"""Stateless, defensive SVG preflight analysis.

The uploaded XML is inspected and parsed entirely in memory.  Only normalized,
rounded geometry and findings leave this module; the original markup is never
returned to the browser.
"""

from __future__ import annotations

import base64
import hashlib
import io
import math
import re
import warnings
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import PurePath
from typing import Any, Iterable
from urllib.parse import unquote_to_bytes
from xml.etree import ElementTree as StdET

from defusedxml import ElementTree as SafeET
from defusedxml.common import DefusedXmlException
from fontTools.ttLib import TTFont
from PIL import Image, UnidentifiedImageError
from shapely import minimum_clearance
from shapely.geometry import LineString, Polygon
from shapely.ops import polygonize, unary_union
from shapely.strtree import STRtree
from svgelements import Close, Move, Path, Shape, SVG, SVGImage, SVGText

from .models import (
    AnalysisReport,
    AssignmentProfile,
    Bounds,
    CheckResult,
    DocumentInfo,
    FileInfo,
    FixAction,
    LabProfile,
    MaterialProfile,
    PreviewGeometry,
    PreviewPath,
    PreviewPiece,
    PreviewRasterAsset,
    PreviewRasterLayer,
    ProcessProfile,
    ProfileReference,
    ReportSummary,
    Selection,
    SummaryCounts,
)


MM_PER_PX = 25.4 / 96.0
MAX_ABS_COORD_PX = 10_000_000.0
MAX_TRANSFORM_COMPONENT = 1_000_000.0
MAX_STROKE_WIDTH_MM = 1_000.0
CURVE_CHORD_ERROR_MM = 0.03
MAX_FLATTENED_CHORD_MM = 0.5
MAX_CURVE_SUBDIVISION_DEPTH = 14
MAX_PAIRWISE_GEOMETRY_CHECKS = 100_000
TRANSPARENT_PNG_DATA_URI = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFgAI/7f0M"
    "WQAAAABJRU5ErkJggg=="
)
DRAWABLE_TAGS = {"path", "rect", "circle", "ellipse", "line", "polyline", "polygon"}
PRESERVE_ASPECT_RATIO_ALIGNMENTS = {
    "xMinYMin", "xMidYMin", "xMaxYMin",
    "xMinYMid", "xMidYMid", "xMaxYMid",
    "xMinYMax", "xMidYMax", "xMaxYMax",
}
SUPPORTED_RASTER_MIME_FORMATS = {
    "image/png": "PNG",
    "image/jpeg": "JPEG",
    "image/jpg": "JPEG",
}
PRESENTATION_KEYS = {
    "display",
    "visibility",
    "opacity",
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-opacity",
    "stroke-width",
    "stroke-dasharray",
    "vector-effect",
    "font-family",
    "font-size",
    "clip-path",
    "mask",
    "filter",
}
INHERITED_KEYS = {
    "visibility",
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-opacity",
    "stroke-width",
    "stroke-dasharray",
    "font-family",
    "font-size",
}
LENGTH_RE = re.compile(
    r"^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(in|mm|cm|pt|pc|px|%)?\s*$",
    re.IGNORECASE,
)
CSS_RULE_RE = re.compile(r"([^{}]+)\{([^{}]*)\}")
CSS_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
URL_RE = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.IGNORECASE)
TRANSFORM_SCALE_RE = re.compile(r"(?:matrix|scale)\s*\(([^)]*)\)", re.IGNORECASE)


class SVGAnalysisError(ValueError):
    """A safe, user-facing analysis failure."""


class UnsafeSVGError(SVGAnalysisError):
    """The file contains active or externally referenced content."""


class StrokeFixError(SVGAnalysisError):
    """A safe, student-facing reason a corrected copy cannot be produced."""


class ArtboardFixError(SVGAnalysisError):
    """A safe, student-facing reason an artboard-corrected copy cannot be produced."""


@dataclass
class FixedSVG:
    data: bytes
    changed_source_ids: list[str]


@dataclass
class FixedArtboardSVG:
    data: bytes
    target_width_mm: float
    target_height_mm: float


@dataclass
class DocumentScale:
    width_mm: float | None
    height_mm: float | None
    units: str
    confidence: str
    viewbox: tuple[float, float, float, float] | None


@dataclass
class ElementMeta:
    object_id: str
    tag: str
    style: dict[str, str]
    hidden: bool
    unsupported_effects: list[str] = field(default_factory=list)
    ambiguous_transform: bool = False
    generated_id: bool = False
    source_order: int = 0


@dataclass
class ExtractedPath:
    preview: PreviewPath
    line: LineString
    color: str | None
    fill: str | None
    dash: str | None
    ambiguous_transform: bool
    source_id: str


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _round(value: float, digits: int = 4) -> float:
    rounded = round(float(value), digits)
    return 0.0 if rounded == -0.0 else rounded


def _format_inches(value_mm: float, digits: int = 4) -> str:
    return f"{value_mm / 25.4:.{digits}f} in"


def _format_square_inches(value_mm2: float, digits: int = 4) -> str:
    return f"{value_mm2 / (25.4 * 25.4):.{digits}f} in\u00b2"


def _process_stroke_range_mm(process: ProcessProfile) -> tuple[float, float]:
    """Return the configured inclusive process range, preserving legacy symmetry."""
    return (
        process.stroke_width_mm - process.effective_lower_tolerance_mm,
        process.stroke_width_mm + process.stroke_tolerance_mm,
    )


def _matches_process_stroke(stroke_width_mm: float, process: ProcessProfile) -> bool:
    lower_mm, upper_mm = _process_stroke_range_mm(process)
    return lower_mm - 1e-12 <= stroke_width_mm <= upper_mm + 1e-12


def _sanitize_preserve_aspect_ratio(value: str | None) -> str:
    text = " ".join((value or "").split())
    if text == "none":
        return "none"
    parts = text.split()
    if len(parts) == 1 and parts[0] in PRESERVE_ASPECT_RATIO_ALIGNMENTS:
        return f"{parts[0]} meet"
    if (
        len(parts) == 2
        and parts[0] in PRESERVE_ASPECT_RATIO_ALIGNMENTS
        and parts[1] in {"meet", "slice"}
    ):
        return text
    return "xMidYMid meet"


def _point_xy(point: Any) -> tuple[float, float]:
    if hasattr(point, "x") and hasattr(point, "y"):
        result = float(point.x), float(point.y)
    else:
        value = complex(point)
        result = float(value.real), float(value.imag)
    if any(not math.isfinite(item) or abs(item) > MAX_ABS_COORD_PX for item in result):
        raise SVGAnalysisError("Geometry contains non-finite or extreme coordinates.")
    return result


def _bounds_from_coords(coords: Iterable[tuple[float, float]]) -> Bounds | None:
    points = list(coords)
    if not points:
        return None
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return Bounds(
        x_mm=_round(min(xs)),
        y_mm=_round(min(ys)),
        width_mm=_round(max(xs) - min(xs)),
        height_mm=_round(max(ys) - min(ys)),
    )


def _parse_length(value: str | None) -> tuple[float | None, str | None, bool]:
    if value is None:
        return None, None, False
    match = LENGTH_RE.match(value)
    if not match:
        return None, None, False
    number = float(match.group(1))
    unit = (match.group(2) or "").lower()
    if not math.isfinite(number) or number <= 0 or unit == "%":
        return None, unit or None, False
    factors = {
        "in": 25.4,
        "mm": 1.0,
        "cm": 10.0,
        "pt": 25.4 / 72.0,
        "pc": 25.4 / 6.0,
        "px": MM_PER_PX,
        "": MM_PER_PX,
    }
    return number * factors[unit], unit or "unitless", unit != ""


def _parse_viewbox(value: str | None) -> tuple[float, float, float, float] | None:
    if not value:
        return None
    try:
        parts = [float(item) for item in re.split(r"[\s,]+", value.strip()) if item]
    except ValueError:
        return None
    if len(parts) != 4 or any(not math.isfinite(item) for item in parts):
        return None
    if parts[2] <= 0 or parts[3] <= 0:
        return None
    return parts[0], parts[1], parts[2], parts[3]


def _document_scale(root: StdET.Element) -> DocumentScale:
    width_mm, width_unit, width_explicit = _parse_length(root.get("width"))
    height_mm, height_unit, height_explicit = _parse_length(root.get("height"))
    viewbox = _parse_viewbox(root.get("viewBox") or root.get("viewbox"))

    if width_mm is None and height_mm is not None and viewbox:
        width_mm = height_mm * viewbox[2] / viewbox[3]
    elif height_mm is None and width_mm is not None and viewbox:
        height_mm = width_mm * viewbox[3] / viewbox[2]
    elif width_mm is None and height_mm is None and viewbox:
        # SVG user units default to CSS pixels. This is useful, but lower
        # confidence than an explicitly declared physical viewport.
        width_mm = viewbox[2] * MM_PER_PX
        height_mm = viewbox[3] * MM_PER_PX

    if width_mm is None or height_mm is None:
        confidence = "unresolved"
    elif width_explicit and height_explicit:
        confidence = "explicit"
    else:
        confidence = "inferred"

    units = "unresolved"
    known_units = {item for item in (width_unit, height_unit) if item}
    if len(known_units) == 1:
        units = next(iter(known_units))
    elif len(known_units) > 1:
        units = "mixed"
    elif viewbox:
        units = "px (inferred)"
    return DocumentScale(width_mm, height_mm, units, confidence, viewbox)


def _declarations(value: str | None) -> dict[str, str]:
    result: dict[str, str] = {}
    if not value:
        return result
    declarations: list[str] = []
    current: list[str] = []
    quote: str | None = None
    escaped = False
    parenthesis_depth = 0
    for character in value:
        if escaped:
            current.append(character)
            escaped = False
            continue
        if character == "\\":
            current.append(character)
            escaped = True
            continue
        if quote:
            current.append(character)
            if character == quote:
                quote = None
            continue
        if character in {"'", '"'}:
            quote = character
            current.append(character)
        elif character == "(":
            parenthesis_depth += 1
            current.append(character)
        elif character == ")":
            parenthesis_depth = max(0, parenthesis_depth - 1)
            current.append(character)
        elif character == ";" and parenthesis_depth == 0:
            declarations.append("".join(current))
            current = []
        else:
            current.append(character)
    declarations.append("".join(current))
    for declaration in declarations:
        if ":" not in declaration:
            continue
        key, raw = declaration.split(":", 1)
        key = key.strip().lower()
        if key:
            result[key] = raw.strip()
    return result


def _selector_matches(selector: str, element: StdET.Element) -> bool:
    """Match the simple selectors emitted by Illustrator.

    Complex combinators and pseudo selectors are intentionally ignored. Their
    presence is surfaced as an unsupported-style finding instead of guessed.
    """
    selector = selector.strip()
    if not selector or any(token in selector for token in (" ", ">", "+", "~", ":", "[")):
        return False
    tag = _local_name(element.tag).lower()
    element_id = element.get("id", "")
    classes = set(element.get("class", "").split())
    id_match = re.search(r"#([\w:-]+)", selector)
    if id_match and id_match.group(1) != element_id:
        return False
    selector_classes = re.findall(r"\.([\w:-]+)", selector)
    if any(item not in classes for item in selector_classes):
        return False
    selector_tag = re.match(r"^[a-zA-Z][\w:-]*", selector)
    if selector_tag and selector_tag.group(0).lower() != tag:
        return False
    return bool(id_match or selector_classes or selector_tag or selector == "*")


def _css_rules(root: StdET.Element) -> tuple[list[tuple[str, dict[str, str]]], list[str]]:
    rules: list[tuple[str, dict[str, str]]] = []
    unsupported: list[str] = []
    for element in root.iter():
        if _local_name(element.tag) != "style":
            continue
        raw_css = element.text or ""
        css = CSS_COMMENT_RE.sub("", raw_css)
        if "!" in raw_css:
            unsupported.append("CSS priority (!important) declarations")
        if "@import" in css.lower():
            raise UnsafeSVGError("External CSS imports are not allowed.")
        for _, target in URL_RE.findall(css):
            target = target.strip().lower()
            if target and not target.startswith(("#", "data:")):
                raise UnsafeSVGError("External CSS resources are not allowed.")
        if "@" in re.sub(r"@font-face\s*\{.*?\}", "", css, flags=re.I | re.S):
            unsupported.append("CSS at-rules")
        for selectors, body in CSS_RULE_RE.findall(css):
            if selectors.strip().lower().startswith("@font-face"):
                continue
            declarations = _declarations(body)
            for selector in selectors.split(","):
                selector = selector.strip()
                if any(token in selector for token in (" ", ">", "+", "~", ":", "[")):
                    unsupported.append(f"complex selector {selector[:160]}")
                else:
                    rules.append((selector, declarations))
    return rules, sorted(set(unsupported))


def _style_for(
    element: StdET.Element,
    inherited: dict[str, str],
    rules: list[tuple[str, dict[str, str]]],
) -> dict[str, str]:
    style = {key: value for key, value in inherited.items() if key in INHERITED_KEYS}
    for key in PRESENTATION_KEYS:
        if key in element.attrib:
            style[key] = element.attrib[key].strip()
    for selector, declarations in rules:
        if _selector_matches(selector, element):
            style.update(declarations)
    style.update(_declarations(element.get("style")))
    return style


def _is_hidden(style: dict[str, str]) -> bool:
    if style.get("display", "").strip().lower() == "none":
        return True
    if style.get("visibility", "").strip().lower() in {"hidden", "collapse"}:
        return True
    try:
        return float(style.get("opacity", "1")) <= 0
    except ValueError:
        return False


def _is_ambiguous_transform(transform: str | None) -> bool:
    if not transform:
        return False
    lower = transform.lower()
    if "skew" in lower:
        return True
    for match in TRANSFORM_SCALE_RE.finditer(transform):
        try:
            values = [float(item) for item in re.split(r"[\s,]+", match.group(1).strip()) if item]
        except ValueError:
            return True
        if match.group(0).lower().lstrip().startswith("scale"):
            if len(values) > 1 and not math.isclose(abs(values[0]), abs(values[1]), rel_tol=1e-7):
                return True
        elif len(values) == 6:
            a, b, c, d, _, _ = values
            sx, sy = math.hypot(a, b), math.hypot(c, d)
            dot = a * c + b * d
            if not math.isclose(sx, sy, rel_tol=1e-7) or not math.isclose(dot, 0.0, abs_tol=1e-7):
                return True
    return False


def _collect_metadata(
    root: StdET.Element,
    rules: list[tuple[str, dict[str, str]]],
) -> tuple[dict[str, ElementMeta], list[str], int, list[str]]:
    metadata: dict[str, ElementMeta] = {}
    unsupported: list[str] = []
    hidden_count = 0
    sequence = 0
    id_counts: dict[str, int] = {}
    duplicate_source_ids: set[str] = set()

    def walk(
        element: StdET.Element,
        inherited: dict[str, str],
        parent_ambiguous: bool,
        parent_hidden: bool,
        inherited_effects: list[str],
    ) -> None:
        nonlocal sequence, hidden_count
        tag = _local_name(element.tag)
        style = _style_for(element, inherited, rules)
        declared_id = element.get("id")
        generated_id = False
        if declared_id:
            occurrence = id_counts.get(declared_id, 0) + 1
            id_counts[declared_id] = occurrence
            if occurrence > 1:
                duplicate_source_ids.add(declared_id)
                element.set("id", f"{declared_id}--duplicate-{occurrence}")
        hidden = parent_hidden or _is_hidden(style)
        ambiguous = parent_ambiguous or _is_ambiguous_transform(element.get("transform"))
        own_effects: list[str] = []
        if "!" in (element.get("style") or ""):
            own_effects.append("inline CSS priority (!important) declaration")
        for key in ("clip-path", "mask", "filter"):
            value = style.get(key) or element.get(key)
            if value and value.strip().lower() != "none":
                own_effects.append(key)
        for opacity_key in ("opacity", "fill-opacity", "stroke-opacity"):
            opacity = style.get(opacity_key)
            if opacity is None:
                continue
            try:
                opacity_value = float(opacity)
                if not math.isfinite(opacity_value) or not 0 <= opacity_value <= 1:
                    own_effects.append(f"invalid {opacity_key}")
                elif 0 < opacity_value < 1:
                    own_effects.append(f"partial {opacity_key}")
                elif opacity_value == 0 and opacity_key != "opacity":
                    own_effects.append(f"zero {opacity_key}")
            except ValueError:
                own_effects.append(f"invalid {opacity_key}")
        for paint_key in ("fill", "stroke"):
            if "url(" in style.get(paint_key, "").lower():
                own_effects.append(f"{paint_key} paint server")
        if tag in DRAWABLE_TAGS | {"image", "text", "use"}:
            sequence += 1
            if not element.get("id"):
                element.set("id", f"object-{sequence:04d}")
                generated_id = True
            object_id = element.get("id", f"object-{sequence:04d}")
            effects = list(dict.fromkeys(inherited_effects + own_effects))
            metadata[object_id] = ElementMeta(
                object_id=object_id,
                tag=tag,
                style=style,
                hidden=hidden,
                unsupported_effects=effects,
                ambiguous_transform=ambiguous,
                generated_id=generated_id,
                source_order=sequence - 1,
            )
            if hidden:
                hidden_count += 1
            unsupported.extend(f"{object_id}: {item}" for item in effects)
        scope = element.get("id") or tag
        descendant_effects = list(inherited_effects)
        descendant_effects.extend(f"ancestor {scope}: {item}" for item in own_effects)
        for child in element:
            walk(child, style, ambiguous, hidden, descendant_effects)

    walk(root, {}, False, False, [])
    return metadata, sorted(set(unsupported)), hidden_count, sorted(duplicate_source_ids)


def _validate_xml_safety(data: bytes, limits: Any) -> tuple[StdET.Element, str]:
    if b"\x00" in data:
        raise UnsafeSVGError("The file contains invalid binary data.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise SVGAnalysisError("The SVG must be UTF-8 encoded.") from exc
    lower = text.lower()
    if "<!doctype" in lower or "<!entity" in lower:
        raise UnsafeSVGError("DTD and entity declarations are not allowed.")
    # Count incrementally before building the retained tree. Clearing completed
    # elements keeps this first pass bounded even for broad documents.
    depth = 0
    element_count = 0
    try:
        events = SafeET.iterparse(
            io.BytesIO(data),
            events=("start", "end"),
            forbid_dtd=True,
            forbid_entities=True,
            forbid_external=True,
        )
        for event, element in events:
            if event == "start":
                depth += 1
                element_count += 1
                if element_count > limits.max_elements:
                    raise SVGAnalysisError(f"The SVG exceeds the {limits.max_elements:,}-element limit.")
                if depth > limits.max_xml_depth:
                    raise SVGAnalysisError(f"The SVG exceeds the XML depth limit of {limits.max_xml_depth}.")
            else:
                depth -= 1
                element.clear()
    except SVGAnalysisError:
        raise
    except (DefusedXmlException, StdET.ParseError, ValueError) as exc:
        raise SVGAnalysisError("The SVG XML could not be parsed safely.") from exc
    try:
        root = SafeET.fromstring(text, forbid_dtd=True, forbid_entities=True, forbid_external=True)
    except (DefusedXmlException, StdET.ParseError, ValueError) as exc:
        raise SVGAnalysisError("The SVG XML could not be parsed safely.") from exc
    if _local_name(root.tag).lower() != "svg":
        raise SVGAnalysisError("The document root is not an SVG element.")

    count = 0
    stack: list[tuple[StdET.Element, int]] = [(root, 1)]
    while stack:
        element, depth = stack.pop()
        count += 1
        if count > limits.max_elements:
            raise SVGAnalysisError(f"The SVG exceeds the {limits.max_elements:,}-element limit.")
        if depth > limits.max_xml_depth:
            raise SVGAnalysisError(f"The SVG exceeds the XML depth limit of {limits.max_xml_depth}.")
        tag = _local_name(element.tag).lower()
        if tag in {
            "script", "foreignobject", "iframe", "object", "embed",
            "animate", "animatemotion", "animatetransform", "set", "discard",
        }:
            raise UnsafeSVGError(f"Active SVG element <{tag}> is not allowed.")
        for key, value in element.attrib.items():
            attr = _local_name(key).lower()
            stripped = value.strip()
            lowered = stripped.lower()
            linked_image_reference = (
                tag == "image"
                and attr in {"href", "src"}
                and bool(lowered)
                and not lowered.startswith(("#", "data:"))
            )
            if attr == "id" and (len(stripped) > 255 or any(not character.isprintable() for character in stripped)):
                raise SVGAnalysisError("SVG object IDs must be printable and no longer than 255 characters.")
            if attr.startswith("on"):
                raise UnsafeSVGError(f"Event handler attribute {attr} is not allowed.")
            if attr in {"href", "src"}:
                if lowered and not lowered.startswith(("#", "data:")) and not linked_image_reference:
                    raise UnsafeSVGError("External linked resources are not allowed.")
            if "url(" in lowered:
                for _, target in URL_RE.findall(stripped):
                    target = target.strip().lower()
                    if target and not target.startswith(("#", "data:")):
                        raise UnsafeSVGError("External URL references are not allowed.")
            if "javascript:" in lowered or (
                any(scheme in lowered for scheme in ("file:", "http:", "https:"))
                and not linked_image_reference
            ):
                raise UnsafeSVGError("External or executable URL schemes are not allowed.")
        stack.extend((child, depth + 1) for child in element)
    return root, text


def _neutralize_image_payloads(root: StdET.Element) -> None:
    """Replace every image payload before any geometry library sees the XML.

    The inventory safely validates and re-encodes embedded pixels first. This
    placeholder preserves placement geometry while making external I/O and
    nested payload interpretation impossible during normalization.
    """
    for element in root.iter():
        if _local_name(element.tag).lower() != "image":
            continue
        found_reference = False
        for attribute in ("href", "{http://www.w3.org/1999/xlink}href", "src"):
            value = element.get(attribute)
            if value:
                element.set(attribute, TRANSPARENT_PNG_DATA_URI)
                found_reference = True
        if not found_reference:
            element.set("href", TRANSPARENT_PNG_DATA_URI)


def _normalize_color(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip().lower().replace(" ", "")
    if text in {"", "none", "transparent"}:
        return None
    names = {"black": "#000000", "white": "#ffffff", "red": "#ff0000", "blue": "#0000ff"}
    if text in names:
        return names[text]
    if re.fullmatch(r"#[0-9a-f]{3}", text):
        return "#" + "".join(character * 2 for character in text[1:])
    if re.fullmatch(r"#[0-9a-f]{6}", text):
        return text
    rgb = re.fullmatch(r"rgb\((\d+),(\d+),(\d+)\)", text)
    if rgb:
        values = [min(255, int(item)) for item in rgb.groups()]
        return "#" + "".join(f"{item:02x}" for item in values)
    # Keep unknown paint explicit for process classification without returning
    # an uploaded CSS token to the browser's SVG presentation attributes.
    return "unsupported-color"


def _decode_data_uri(uri: str, max_bytes: int) -> tuple[str, bytes]:
    if not uri.lower().startswith("data:") or "," not in uri:
        raise ValueError("not a data URI")
    header, payload = uri.split(",", 1)
    media_type = header[5:].split(";", 1)[0].lower() or "text/plain"
    if ";base64" in header.lower():
        decoded = base64.b64decode(payload, validate=True)
    else:
        decoded = unquote_to_bytes(payload)
    if len(decoded) > max_bytes:
        raise ValueError("embedded resource is too large")
    return media_type, decoded


def _embedded_fonts(root: StdET.Element, max_bytes: int) -> tuple[set[str], list[str]]:
    families: set[str] = set()
    errors: list[str] = []
    for element in root.iter():
        if _local_name(element.tag) != "style":
            continue
        css = CSS_COMMENT_RE.sub("", element.text or "")
        for match in re.finditer(r"@font-face\s*\{(.*?)\}", css, flags=re.I | re.S):
            declarations = _declarations(match.group(1))
            family = declarations.get("font-family", "").strip(" '\"")
            src = declarations.get("src", "")
            urls = [target for _, target in URL_RE.findall(src)]
            data_urls = [target for target in urls if target.lower().startswith("data:")]
            if not family or not data_urls:
                errors.append("An @font-face rule is missing an embedded data font.")
                continue
            try:
                _, decoded = _decode_data_uri(data_urls[0], max_bytes)
                font = TTFont(io.BytesIO(decoded), lazy=True)
                font.close()
                families.add(family.lower())
            except Exception:  # fontTools raises several format-specific errors
                errors.append(f"Embedded font '{family}' could not be validated.")
    return families, errors


def _safe_png_preview(image: Image.Image, limits: Any, remaining_bytes: int) -> tuple[str | None, int, int]:
    byte_limit = min(limits.max_raster_preview_bytes, remaining_bytes)
    if byte_limit <= 0:
        return None, image.width, image.height
    preview = image.convert("RGBA")
    preview.thumbnail(
        (limits.max_raster_preview_dimension_px, limits.max_raster_preview_dimension_px),
        Image.Resampling.LANCZOS,
    )
    while preview.width > 0 and preview.height > 0:
        output = io.BytesIO()
        preview.save(output, format="PNG", optimize=True)
        encoded = output.getvalue()
        if len(encoded) <= byte_limit:
            return (
                "data:image/png;base64," + base64.b64encode(encoded).decode("ascii"),
                preview.width,
                preview.height,
            )
        if preview.width <= 16 and preview.height <= 16:
            break
        preview = preview.resize(
            (max(1, int(preview.width * 0.75)), max(1, int(preview.height * 0.75))),
            Image.Resampling.LANCZOS,
        )
    return None, preview.width, preview.height


def _image_references(element: StdET.Element) -> list[str]:
    references: list[str] = []
    for key, value in element.attrib.items():
        if _local_name(key).lower() in {"href", "src"} and value.strip():
            references.append(value.strip())
    return references


def _image_inventory(
    root: StdET.Element,
    metadata: dict[str, ElementMeta],
    limits: Any,
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    images: list[dict[str, Any]] = []
    external: list[str] = []
    invalid: list[str] = []
    preview_bytes_used = 0
    embedded_image_count = 0
    decoded_pixels_used = 0
    for element in root.iter():
        if _local_name(element.tag) != "image":
            continue
        object_id = element.get("id", "image")
        references = _image_references(element)
        if any(not reference.lower().startswith(("data:", "#")) for reference in references):
            external.append(object_id)
            continue
        if (
            not references
            or any(not reference.lower().startswith("data:") for reference in references)
            or len(set(references)) != 1
        ):
            invalid.append(object_id)
            continue
        data_references = references
        embedded_image_count += 1
        if embedded_image_count > limits.max_embedded_images:
            invalid.append(object_id)
            continue
        href = data_references[0]
        try:
            media_type, decoded = _decode_data_uri(href, limits.max_upload_bytes)
            expected_format = SUPPORTED_RASTER_MIME_FORMATS.get(media_type)
            if expected_format is None:
                raise ValueError("embedded image MIME type is not a supported raster format")
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(decoded)) as image:
                    if image.format != expected_format:
                        raise ValueError("embedded image MIME type does not match its decoded format")
                    pixel_width, pixel_height = image.size
                    image_pixels = pixel_width * pixel_height
                    if image_pixels > limits.max_embedded_image_pixels:
                        raise ValueError("embedded image exceeds the decoded-pixel limit")
                    if decoded_pixels_used + image_pixels > limits.max_total_embedded_image_pixels:
                        raise ValueError("embedded images exceed the cumulative decoded-pixel limit")
                    decoded_pixels_used += image_pixels
                    image.seek(0)
                    image.load()
                    preview_data_url, preview_width, preview_height = _safe_png_preview(
                        image,
                        limits,
                        limits.max_total_raster_preview_bytes - preview_bytes_used,
                    )
            if preview_data_url:
                preview_bytes_used += len(base64.b64decode(preview_data_url.split(",", 1)[1]))
            width_mm, _, _ = _parse_length(element.get("width"))
            height_mm, _, _ = _parse_length(element.get("height"))
            dpi = None
            if width_mm and height_mm:
                dpi = min(pixel_width / (width_mm / 25.4), pixel_height / (height_mm / 25.4))
            images.append(
                {
                    "id": object_id,
                    "media_type": media_type,
                    "pixel_width": pixel_width,
                    "pixel_height": pixel_height,
                    "effective_dpi": _round(dpi, 1) if dpi else None,
                    "hidden": metadata.get(object_id).hidden if object_id in metadata else False,
                    "opacity": _image_opacity(metadata.get(object_id)),
                    "preview_data_url": preview_data_url,
                    "preview_pixel_width": preview_width,
                    "preview_pixel_height": preview_height,
                    "preserve_aspect_ratio": _sanitize_preserve_aspect_ratio(
                        element.get("preserveAspectRatio")
                    ),
                }
            )
        except (
            ValueError,
            OSError,
            UnidentifiedImageError,
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
            base64.binascii.Error,
        ):
            invalid.append(object_id)
    return images, external, invalid


def _image_opacity(meta: ElementMeta | None) -> float:
    if meta is None:
        return 1.0
    try:
        return min(1.0, max(0.0, float(meta.style.get("opacity", "1"))))
    except ValueError:
        return 1.0


def _live_text_inventory(
    root: StdET.Element,
    metadata: dict[str, ElementMeta],
    embedded_families: set[str],
) -> tuple[list[str], list[str]]:
    valid: list[str] = []
    missing: list[str] = []
    for element in root.iter():
        if _local_name(element.tag) != "text":
            continue
        object_id = element.get("id", "text")
        meta = metadata.get(object_id)
        if meta and meta.hidden:
            continue
        family_value = meta.style.get("font-family", "") if meta else ""
        requested = {
            family.strip(" '\"").lower()
            for family in family_value.split(",")
            if family.strip(" '\"")
        }
        if requested and requested.intersection(embedded_families):
            valid.append(object_id)
        else:
            missing.append(object_id)
    return valid, missing


def _element_identifier(element: Any, fallback: str) -> str:
    values = getattr(element, "values", {}) or {}
    identifier = getattr(element, "id", None) or values.get("id")
    return str(identifier) if identifier else fallback


def _use_expansion_context(xml_text: str) -> tuple[dict[str, list[str]], dict[str, int]]:
    """Map local use targets to instance IDs and expected emitted object counts."""
    try:
        root = StdET.fromstring(xml_text)
    except StdET.ParseError:
        return {}, {}
    by_id = {element.get("id"): element for element in root.iter() if element.get("id")}

    def href_for(element: StdET.Element) -> str:
        return element.get("href") or element.get("{http://www.w3.org/1999/xlink}href") or ""

    def renderable_count(element: StdET.Element, seen: set[str]) -> int:
        tag = _local_name(element.tag)
        if tag in DRAWABLE_TAGS | {"image", "text"}:
            return 1
        if tag == "use":
            href = href_for(element)
            target_id = href[1:] if href.startswith("#") else ""
            if target_id and target_id not in seen and target_id in by_id:
                return renderable_count(by_id[target_id], seen | {target_id})
            return 0
        return sum(renderable_count(child, seen) for child in element)

    instances: dict[str, list[str]] = {}
    counts: dict[str, int] = {}
    for element in root.iter():
        if _local_name(element.tag) != "use":
            continue
        href = href_for(element)
        use_id = element.get("id")
        if not use_id or not href.startswith("#"):
            continue
        instances.setdefault(href, []).append(use_id)
        target = by_id.get(href[1:])
        if target is not None:
            counts[href] = max(1, renderable_count(target, {href[1:]}))
    return instances, counts


def _matrix_scale(matrix: Any) -> tuple[float, bool]:
    if matrix is None:
        return 1.0, False
    try:
        a, b, c, d = (float(matrix.a), float(matrix.b), float(matrix.c), float(matrix.d))
    except (AttributeError, TypeError, ValueError):
        return 1.0, True
    if any(not math.isfinite(item) or abs(item) > MAX_TRANSFORM_COMPONENT for item in (a, b, c, d)):
        raise SVGAnalysisError("Geometry contains a non-finite or extreme transform.")
    sx, sy = math.hypot(a, b), math.hypot(c, d)
    dot = a * c + b * d
    if sx <= 0 or sy <= 0:
        return 0.0, True
    ambiguous = not math.isclose(sx, sy, rel_tol=1e-6) or not math.isclose(dot, 0.0, abs_tol=1e-7)
    determinant = abs(a * d - b * c)
    if not math.isfinite(determinant):
        raise SVGAnalysisError("Geometry transform scale is not finite.")
    return math.sqrt(determinant), ambiguous


def _transform_xy(x: float, y: float, matrix: Any) -> tuple[float, float]:
    if matrix is None:
        return _point_xy(complex(x, y))
    try:
        a, b, c, d, e, f = (
            float(matrix.a), float(matrix.b), float(matrix.c),
            float(matrix.d), float(matrix.e), float(matrix.f),
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise SVGAnalysisError("Geometry contains an unreadable transform.") from exc
    values = (a, b, c, d, e, f)
    if any(not math.isfinite(item) or abs(item) > MAX_TRANSFORM_COMPONENT for item in values):
        raise SVGAnalysisError("Geometry contains a non-finite or extreme transform.")
    return _point_xy(complex(a * x + c * y + e, b * x + d * y + f))


def _distance_to_chord(
    point: tuple[float, float],
    start: tuple[float, float],
    end: tuple[float, float],
) -> float:
    chord_x = end[0] - start[0]
    chord_y = end[1] - start[1]
    length_squared = chord_x * chord_x + chord_y * chord_y
    if length_squared <= 1e-18:
        return math.dist(point, start)
    position = max(
        0.0,
        min(1.0, ((point[0] - start[0]) * chord_x + (point[1] - start[1]) * chord_y) / length_squared),
    )
    projection = start[0] + position * chord_x, start[1] + position * chord_y
    return math.dist(point, projection)


def _flatten_curve(segment: Any, remaining_points: int) -> list[tuple[float, float]]:
    """Flatten a Bezier/arc using physical chord-error and length limits."""
    if remaining_points <= 0:
        raise SVGAnalysisError("The SVG exceeds the normalized preview-point limit.")
    start = _point_xy(segment.point(0.0))
    end = _point_xy(segment.point(1.0))
    stack: list[tuple[float, tuple[float, float], float, tuple[float, float], int]] = [
        (0.0, start, 1.0, end, 0)
    ]
    flattened: list[tuple[float, float]] = []
    while stack:
        t0, point0, t1, point1, depth = stack.pop()
        midpoint_t = (t0 + t1) / 2.0
        quarter_t = (3.0 * t0 + t1) / 4.0
        three_quarter_t = (t0 + 3.0 * t1) / 4.0
        quarter = _point_xy(segment.point(quarter_t))
        midpoint = _point_xy(segment.point(midpoint_t))
        three_quarter = _point_xy(segment.point(three_quarter_t))
        error_mm = max(
            _distance_to_chord(quarter, point0, point1),
            _distance_to_chord(midpoint, point0, point1),
            _distance_to_chord(three_quarter, point0, point1),
        ) * MM_PER_PX
        chord_mm = math.dist(point0, point1) * MM_PER_PX
        needs_split = error_mm > CURVE_CHORD_ERROR_MM or chord_mm > MAX_FLATTENED_CHORD_MM
        if needs_split:
            if depth >= MAX_CURVE_SUBDIVISION_DEPTH:
                raise SVGAnalysisError("A curve is too detailed to flatten reliably within the analysis limit.")
            stack.append((midpoint_t, midpoint, t1, point1, depth + 1))
            stack.append((t0, point0, midpoint_t, midpoint, depth + 1))
            if len(stack) + len(flattened) > remaining_points:
                raise SVGAnalysisError("The SVG exceeds the normalized preview-point limit.")
            continue
        flattened.append(point1)
        if len(flattened) > remaining_points:
            raise SVGAnalysisError("The SVG exceeds the normalized preview-point limit.")
    return flattened


def _sample_subpath(segments: list[Any], max_points: int) -> tuple[list[tuple[float, float]], bool]:
    coords: list[tuple[float, float]] = []
    closed = False
    for segment in segments:
        if isinstance(segment, Move):
            if segment.end is not None:
                coords.append(_point_xy(segment.end))
            continue
        if isinstance(segment, Close):
            closed = True
            if segment.end is not None:
                end = _point_xy(segment.end)
                if not coords or math.dist(coords[-1], end) > 1e-9:
                    coords.append(end)
            continue
        name = segment.__class__.__name__.lower()
        if "bezier" in name or "arc" in name:
            try:
                length_px = float(segment.length(error=0.05, min_depth=2))
            except (ValueError, TypeError, AttributeError, RecursionError):
                length_px = 16.0
            if not math.isfinite(length_px) or length_px < 0 or length_px > MAX_ABS_COORD_PX * 4:
                raise SVGAnalysisError("Geometry contains a non-finite or extreme curve length.")
            coords.extend(_flatten_curve(segment, max_points - len(coords)))
        else:
            coords.append(_point_xy(segment.point(1.0)))
        if len(coords) > max_points:
            raise SVGAnalysisError("The SVG exceeds the normalized preview-point limit.")
    if closed and len(coords) > 2 and math.dist(coords[0], coords[-1]) <= 0.01 / MM_PER_PX:
        coords[-1] = coords[0]
    return coords, closed


def _extract_paths(
    xml_text: str,
    metadata: dict[str, ElementMeta],
    assignment: AssignmentProfile,
    hairline_threshold_mm: float,
    limits: Any,
    non_renderable_image_ids: set[str] | None = None,
) -> tuple[list[ExtractedPath], int, int]:
    try:
        svg = SVG.parse(io.StringIO(xml_text), ppi=96, reify=False)
    except Exception as exc:
        raise SVGAnalysisError("The SVG geometry could not be interpreted.") from exc

    extracted: list[ExtractedPath] = []
    segment_count = 0
    preview_points = 0
    hidden_geometry = 0
    object_index = 0
    preview_id_counts: dict[str, int] = {}
    use_instances, use_renderable_counts = _use_expansion_context(xml_text)
    emitted_for_use_target: dict[str, int] = {}
    non_renderable_image_ids = non_renderable_image_ids or set()

    def object_identity(element: Any, fallback: str) -> tuple[str, str, ElementMeta | None, dict[str, Any]]:
        values = getattr(element, "values", {}) or {}
        source_id = _element_identifier(element, fallback)
        preview_source_id = source_id
        meta = metadata.get(source_id)
        href = str(values.get("href", ""))
        instance_ids = use_instances.get(href, [])
        if instance_ids:
            emitted_index = emitted_for_use_target.get(href, 0)
            emitted_for_use_target[href] = emitted_index + 1
            renderable_count = max(1, use_renderable_counts.get(href, 1))
            instance_index = min(emitted_index // renderable_count, len(instance_ids) - 1)
            use_id = instance_ids[instance_index]
            preview_source_id = use_id if renderable_count == 1 else f"{use_id}--{source_id}"
            meta = metadata.get(use_id) or meta
        return source_id, preview_source_id, meta, values

    for element in svg.elements():
        if isinstance(element, SVGText):
            object_index += 1
            source_id, preview_source_id, meta, values = object_identity(
                element, f"text-{object_index:04d}"
            )
            hidden = meta.hidden if meta else (
                str(values.get("display", "")).lower() == "none"
                or str(values.get("visibility", "")).lower() in {"hidden", "collapse"}
            )
            if hidden:
                hidden_geometry += 1
                continue
            instance_number = preview_id_counts.get(preview_source_id, 0) + 1
            preview_id_counts[preview_source_id] = instance_number
            object_id = preview_source_id if instance_number == 1 else f"{preview_source_id}--instance-{instance_number}"
            try:
                x = float(element.x) + float(getattr(element, "dx", 0) or 0)
                baseline_y = float(element.y) + float(getattr(element, "dy", 0) or 0)
                font_size = abs(float(getattr(element, "font_size", 16) or 16))
            except (TypeError, ValueError) as exc:
                raise SVGAnalysisError(f"Live-text bounds on {source_id} are unresolved.") from exc
            if any(not math.isfinite(item) for item in (x, baseline_y, font_size)) or font_size <= 0:
                raise SVGAnalysisError(f"Live-text bounds on {source_id} are non-finite or invalid.")
            text_value = str(getattr(element, "text", "") or "")
            measured_width = float(getattr(element, "width", 0) or 0)
            measured_height = float(getattr(element, "height", 0) or 0)
            width = measured_width if measured_width > 0 else max(font_size * 0.6, len(text_value) * font_size * 0.6)
            height = measured_height if measured_height > 0 else font_size * 1.2
            anchor = str(getattr(element, "anchor", "start") or "start").lower()
            left = x - width / 2 if anchor == "middle" else (x - width if anchor == "end" else x)
            top = baseline_y - height * 0.82
            matrix = getattr(element, "transform", None)
            corners_px = [
                _transform_xy(left, top, matrix),
                _transform_xy(left + width, top, matrix),
                _transform_xy(left + width, top + height, matrix),
                _transform_xy(left, top + height, matrix),
            ]
            corners_px.append(corners_px[0])
            coords_mm = [(_round(px * MM_PER_PX), _round(py * MM_PER_PX)) for px, py in corners_px]
            bounds = _bounds_from_coords(coords_mm)
            if bounds is None:
                raise SVGAnalysisError(f"Live-text bounds on {source_id} could not be normalized.")
            preview = PreviewPath(
                id=object_id,
                z_index=meta.source_order if meta else max(0, object_index - 1),
                operation="engrave-text",
                closed=True,
                stroke="#b26a56",
                points=[[_round(px), _round(py)] for px, py in coords_mm],
                bounds=bounds,
            )
            extracted.append(
                ExtractedPath(
                    preview=preview,
                    line=LineString(coords_mm),
                    color=None,
                    fill=None,
                    dash=None,
                    ambiguous_transform=False,
                    source_id=source_id,
                )
            )
            preview_points += len(coords_mm)
            if preview_points > limits.max_preview_points:
                raise SVGAnalysisError("The SVG exceeds the normalized preview-point limit.")
            continue
        if isinstance(element, SVGImage):
            object_index += 1
            source_id, preview_source_id, meta, values = object_identity(
                element, f"image-{object_index:04d}"
            )
            hidden = meta.hidden if meta else (
                str(values.get("display", "")).lower() == "none"
                or str(values.get("visibility", "")).lower() in {"hidden", "collapse"}
            )
            if hidden:
                hidden_geometry += 1
                continue
            instance_number = preview_id_counts.get(preview_source_id, 0) + 1
            preview_id_counts[preview_source_id] = instance_number
            object_id = preview_source_id if instance_number == 1 else f"{preview_source_id}--instance-{instance_number}"
            try:
                x = float(element.x)
                y = float(element.y)
                width = float(element.width)
                height = float(element.height)
            except (TypeError, ValueError) as exc:
                if source_id in non_renderable_image_ids:
                    continue
                raise SVGAnalysisError(f"Raster image bounds on {source_id} are unresolved.") from exc
            if any(not math.isfinite(item) for item in (x, y, width, height)) or width <= 0 or height <= 0:
                if source_id in non_renderable_image_ids:
                    continue
                raise SVGAnalysisError(f"Raster image bounds on {source_id} are non-finite or invalid.")
            matrix = getattr(element, "transform", None)
            corners_px = [
                _transform_xy(x, y, matrix),
                _transform_xy(x + width, y, matrix),
                _transform_xy(x + width, y + height, matrix),
                _transform_xy(x, y + height, matrix),
            ]
            corners_px.append(corners_px[0])
            coords_mm = [(_round(px * MM_PER_PX), _round(py * MM_PER_PX)) for px, py in corners_px]
            bounds = _bounds_from_coords(coords_mm)
            if bounds is None:
                raise SVGAnalysisError(f"Raster image bounds on {source_id} could not be normalized.")
            line = LineString(coords_mm)
            preview = PreviewPath(
                id=object_id,
                z_index=meta.source_order if meta else max(0, object_index - 1),
                operation="raster-engrave",
                closed=True,
                points=[[_round(px), _round(py)] for px, py in coords_mm],
                bounds=bounds,
            )
            extracted.append(
                ExtractedPath(
                    preview=preview,
                    line=line,
                    color=None,
                    fill=None,
                    dash=None,
                    ambiguous_transform=False,
                    source_id=source_id,
                )
            )
            preview_points += len(coords_mm)
            if preview_points > limits.max_preview_points:
                raise SVGAnalysisError("The SVG exceeds the normalized preview-point limit.")
            continue
        if not isinstance(element, Shape):
            continue
        object_index += 1
        source_id, preview_source_id, meta, values = object_identity(
            element, f"vector-{object_index:04d}"
        )
        instance_number = preview_id_counts.get(preview_source_id, 0) + 1
        preview_id_counts[preview_source_id] = instance_number
        preview_base_id = preview_source_id if instance_number == 1 else f"{preview_source_id}--instance-{instance_number}"
        hidden = meta.hidden if meta else (
            str(values.get("display", "")).lower() == "none"
            or str(values.get("visibility", "")).lower() in {"hidden", "collapse"}
        )
        if hidden:
            hidden_geometry += 1
            continue
        try:
            path = Path(element)
        except (ValueError, TypeError, AttributeError):
            continue
        matrix = getattr(path, "transform", None)
        scale, matrix_ambiguous = _matrix_scale(matrix)
        try:
            transformed = abs(path)
        except (ValueError, TypeError, AttributeError, RecursionError) as exc:
            raise SVGAnalysisError(f"Transform on {source_id} could not be resolved.") from exc

        raw_width = getattr(element, "stroke_width", values.get("stroke-width", 1.0))
        try:
            stroke_width_px = float(raw_width)
        except (ValueError, TypeError):
            raise SVGAnalysisError(f"Stroke width on {source_id} is not numeric.")
        if not math.isfinite(stroke_width_px) or stroke_width_px < 0:
            raise SVGAnalysisError(f"Stroke width on {source_id} is not finite and nonnegative.")
        vector_effect = str(values.get("vector-effect", "")).lower()
        effective_scale = 1.0 if "non-scaling-stroke" in vector_effect else scale
        stroke_width_mm = stroke_width_px * effective_scale * MM_PER_PX
        if not math.isfinite(stroke_width_mm) or stroke_width_mm > MAX_STROKE_WIDTH_MM:
            raise SVGAnalysisError(f"Stroke width on {source_id} is non-finite or extreme.")

        color = _normalize_color(getattr(element, "stroke", values.get("stroke")))
        fill = _normalize_color(getattr(element, "fill", values.get("fill")))
        dash = values.get("stroke-dasharray")
        ambiguous = (meta.ambiguous_transform if meta else False) or matrix_ambiguous
        approved_process = None
        for process in assignment.processes:
            if color == process.color and _matches_process_stroke(stroke_width_mm, process):
                approved_process = process
                break
        configured_process_color = any(color == process.color for process in assignment.processes)
        if approved_process:
            operation = approved_process.id
        elif color is not None and (
            stroke_width_mm <= hairline_threshold_mm + 1e-6
            or (
                fill is None
                and configured_process_color
                and stroke_width_mm <= limits.max_fixable_cut_stroke_width_mm + 1e-6
            )
        ):
            operation = "unassigned-vector"
        elif color is not None or fill is not None:
            operation = "engrave"
        else:
            operation = "unassigned"

        subpaths: list[list[Any]] = []
        current: list[Any] = []
        for segment in transformed:
            segment_count += 1
            if segment_count > limits.max_path_segments:
                raise SVGAnalysisError(f"The SVG exceeds the {limits.max_path_segments:,}-segment limit.")
            if isinstance(segment, Move) and current:
                subpaths.append(current)
                current = [segment]
            else:
                current.append(segment)
        if current:
            subpaths.append(current)

        for sub_index, segments in enumerate(subpaths, start=1):
            coords_px, closed = _sample_subpath(segments, limits.max_preview_points - preview_points)
            if len(coords_px) < 2:
                continue
            coords_mm = [(_round(x * MM_PER_PX), _round(y * MM_PER_PX)) for x, y in coords_px]
            preview_points += len(coords_mm)
            if preview_points > limits.max_preview_points:
                raise SVGAnalysisError("The SVG exceeds the normalized preview-point limit.")
            object_id = preview_base_id if len(subpaths) == 1 else f"{preview_base_id}--subpath-{sub_index}"
            bounds = _bounds_from_coords(coords_mm)
            line = LineString(coords_mm)
            preview_stroke = (
                color if color and re.fullmatch(r"#[0-9a-f]{6}", color)
                else ("#b45353" if color else None)
            )
            preview = PreviewPath(
                id=object_id,
                z_index=meta.source_order if meta else max(0, object_index - 1),
                operation=operation,
                closed=closed,
                stroke=preview_stroke,
                stroke_width_mm=_round(stroke_width_mm, 5) if color is not None else None,
                points=[[_round(x), _round(y)] for x, y in coords_mm],
                bounds=bounds,
            )
            extracted.append(
                ExtractedPath(
                    preview=preview,
                    line=line,
                    color=color,
                    fill=fill,
                    dash=str(dash) if dash is not None else None,
                    ambiguous_transform=ambiguous,
                    source_id=source_id,
                )
            )
    return extracted, segment_count, hidden_geometry


def _canonical_line(line: LineString) -> tuple[tuple[float, float], ...]:
    points = tuple((_round(x, 3), _round(y, 3)) for x, y in line.coords)
    reverse = tuple(reversed(points))
    return min(points, reverse)


def _bounds_for_ids(paths: list[ExtractedPath], object_ids: Iterable[str]) -> list[Bounds]:
    wanted = set(object_ids)
    return [
        item.preview.bounds
        for item in paths
        if item.preview.bounds is not None
        and (
            item.preview.id in wanted
            or item.source_id in wanted
            or any(item.preview.id.startswith(f"{object_id}--") for object_id in wanted)
        )
    ]


def _preview_ids_for_source_ids(
    paths: list[ExtractedPath], object_ids: Iterable[str]
) -> list[str]:
    wanted = set(object_ids)
    matched = [
        item.preview.id
        for item in paths
        if item.preview.id in wanted
        or item.source_id in wanted
        or any(item.preview.id.startswith(f"{object_id}--") for object_id in wanted)
    ]
    return list(dict.fromkeys(matched)) or sorted(wanted)


def _fixable_stroke_paths(
    paths: Iterable[ExtractedPath],
    metadata: dict[str, ElementMeta],
    assignment: AssignmentProfile,
    hairline_threshold_mm: float,
    max_fixable_width_mm: float,
) -> list[ExtractedPath]:
    """Return deterministic, source-backed cut candidates safe to restyle."""
    result: list[ExtractedPath] = []
    seen_preview_ids: set[str] = set()
    other_process_colors = {
        process.color for process in assignment.processes if process.color != "#000000"
    }
    for item in paths:
        meta = metadata.get(item.source_id)
        dashed = bool(item.dash and item.dash.strip().lower() not in {"", "0", "none"})
        width_mm = item.preview.stroke_width_mm
        same_process_wrong_width = bool(
            item.color == "#000000"
            and item.fill is None
            and width_mm is not None
            and width_mm <= max_fixable_width_mm + 1e-6
        )
        wrong_color_hairline = bool(
            item.color != "#000000"
            and item.color not in other_process_colors
            and width_mm is not None
            and width_mm <= hairline_threshold_mm + 1e-6
        )
        if (
            item.preview.operation != "unassigned-vector"
            or not (same_process_wrong_width or wrong_color_hairline)
            or item.ambiguous_transform
            or dashed
            or meta is None
            or meta.tag not in DRAWABLE_TAGS
            or meta.hidden
            or meta.unsupported_effects
            or item.color in other_process_colors
            or item.preview.id != item.source_id
            or item.preview.id in seen_preview_ids
        ):
            continue
        result.append(item)
        seen_preview_ids.add(item.preview.id)
    return result


def _polygon_for_path(item: ExtractedPath) -> Polygon | None:
    if not item.preview.closed or len(item.line.coords) < 4:
        return None
    try:
        polygon = Polygon(item.line.coords)
    except (ValueError, TypeError):
        return None
    return polygon if not polygon.is_empty else None


def _piece_geometry(cut_paths: list[ExtractedPath], kerf_mm: float, max_points: int) -> list[PreviewPiece]:
    if not cut_paths:
        return []
    try:
        merged = unary_union([item.line for item in cut_paths])
        polygons = list(polygonize(merged))
    except (ValueError, TypeError):
        return []
    pieces: list[PreviewPiece] = []
    point_count = 0
    for index, polygon in enumerate(polygons, start=1):
        if polygon.is_empty or not polygon.is_valid or polygon.area <= 1e-6:
            continue
        adjusted = polygon.buffer(-kerf_mm / 2.0, join_style=2) if kerf_mm else polygon
        candidates = list(adjusted.geoms) if hasattr(adjusted, "geoms") else [adjusted]
        for candidate in candidates:
            if candidate.is_empty or candidate.geom_type != "Polygon":
                continue
            outer = [[_round(x), _round(y)] for x, y in candidate.exterior.coords]
            holes = [
                [[_round(x), _round(y)] for x, y in interior.coords]
                for interior in candidate.interiors
            ]
            point_count += len(outer) + sum(len(hole) for hole in holes)
            if point_count > max_points:
                return pieces
            bounds = _bounds_from_coords(candidate.exterior.coords)
            if bounds is None:
                continue
            pieces.append(
                PreviewPiece(
                    id=f"piece-{index:04d}-{len(pieces) + 1}",
                    outer=outer,
                    holes=holes,
                    area_mm2=_round(candidate.area, 3),
                    bounds=bounds,
                )
            )
    return pieces


def _add_check(
    checks: list[CheckResult],
    *,
    rule_id: str,
    title: str,
    state: str,
    message: str,
    evidence: Iterable[str] = (),
    fix: str | None = None,
    object_ids: Iterable[str] = (),
    bounds: Iterable[Bounds] = (),
    fix_actions: Iterable[FixAction] = (),
) -> None:
    checks.append(
        CheckResult(
            rule_id=rule_id,
            title=title,
            state=state,  # type: ignore[arg-type]
            message=message,
            evidence=list(evidence),
            fix=fix,
            object_ids=list(object_ids),
            bounds=list(bounds),
            fix_actions=list(fix_actions),
        )
    )


def _apply_severity_overrides(
    checks: list[CheckResult],
    assignment: AssignmentProfile,
    material: MaterialProfile,
) -> None:
    """Apply profile overrides without allowing a blocking rule to be weakened."""
    overrides = {**material.severity_overrides, **assignment.severity_overrides}
    for check in checks:
        target = overrides.get(check.rule_id)
        if target is None or check.state == "pass":
            continue
        if check.state == "blocker" and target != "blocker":
            continue
        if target != check.state:
            previous = check.state
            check.state = target  # type: ignore[assignment]
            check.evidence.append(f"Profile severity override: {previous} -> {target}")


def _summary(checks: list[CheckResult], profile: LabProfile) -> ReportSummary:
    totals = {state: sum(check.state == state for check in checks) for state in ("blocker", "warning", "pass", "info", "unverified")}
    if totals["blocker"]:
        status, label = "not_ready", "Not ready — fix blockers before teacher review"
    elif profile.profile.demo:
        status, label = "review", "Checks complete — demo profile requires instructor review"
    else:
        status, label = "ready", "Ready for teacher review"
    return ReportSummary(
        status=status,  # type: ignore[arg-type]
        label=label,
        counts=SummaryCounts.model_validate(totals),
    )


def _base_report(
    *,
    data: bytes,
    filename: str,
    profile: LabProfile,
    assignment: AssignmentProfile,
    material: MaterialProfile,
    thickness_mm: float,
    checks: list[CheckResult],
    document: DocumentInfo,
    metrics: dict[str, Any],
    geometry: PreviewGeometry,
) -> AnalysisReport:
    clean_name = "".join(character for character in PurePath(filename).name if character.isprintable())[:255] or "upload.svg"
    return AnalysisReport(
        analyzed_at=datetime.now(timezone.utc).isoformat(),
        file=FileInfo(name=clean_name, size_bytes=len(data), sha256=hashlib.sha256(data).hexdigest()),
        profile=ProfileReference(**profile.profile.model_dump()),
        selection=Selection(
            assignment_id=assignment.id,
            material_id=material.id,
            thickness_mm=thickness_mm,
        ),
        summary=_summary(checks, profile),
        document=document,
        metrics=metrics,
        checks=checks,
        geometry=geometry,
    )


def failure_report(
    *,
    data: bytes,
    filename: str,
    profile: LabProfile,
    assignment: AssignmentProfile,
    material: MaterialProfile,
    thickness_mm: float,
    title: str,
    message: str,
    rule_id: str = "file.readable",
) -> AnalysisReport:
    checks: list[CheckResult] = []
    _add_check(
        checks,
        rule_id=rule_id,
        title=title,
        state="blocker",
        message=message,
        evidence=[message],
        fix="Export a fresh SVG from Illustrator without scripts, linked files, or external resources, then upload it again.",
    )
    return _base_report(
        data=data,
        filename=filename,
        profile=profile,
        assignment=assignment,
        material=material,
        thickness_mm=thickness_mm,
        checks=checks,
        document=DocumentInfo(units="unresolved", unit_confidence="unresolved"),
        metrics={
            "object_count": 0,
            "vector_path_count": 0,
            "cut_path_count": 0,
            "image_count": 0,
            "live_text_count": 0,
            "material": material.name,
            "material_thickness_mm": thickness_mm,
            "kerf_mm": material.kerf_mm,
        },
        geometry=PreviewGeometry(
            page={"width_mm": None, "height_mm": None},
            paths=[],
            pieces=[],
            valid_3d=False,
            invalid_reason=message,
        ),
    )


def _stroke_fix_target(assignment: AssignmentProfile) -> ProcessProfile:
    matches = [
        process for process in assignment.processes
        if process.color == "#000000" and abs(process.stroke_width_mm - 0.0254) <= 1e-9
    ]
    if len(matches) != 1:
        raise StrokeFixError("This assignment does not define one unambiguous black 0.001 in cut process.")
    return matches[0]


def _set_inline_cut_style(element: StdET.Element) -> None:
    declarations = _declarations(element.get("style"))
    declarations.update(
        {
            "stroke": "#000000",
            "stroke-width": "0.001in",
            "vector-effect": "non-scaling-stroke",
        }
    )
    element.set("style", ";".join(f"{key}:{value}" for key, value in declarations.items()))
    element.set("stroke", "#000000")
    element.set("stroke-width", "0.001in")
    element.set("vector-effect", "non-scaling-stroke")


def _artboard_scale_mm_per_unit(scale: DocumentScale) -> tuple[float, float] | None:
    """Return reliable viewport scales for an explicit, non-distorting document."""
    if (
        scale.confidence != "explicit"
        or scale.width_mm is None
        or scale.height_mm is None
        or scale.viewbox is None
    ):
        return None
    x_scale = scale.width_mm / scale.viewbox[2]
    y_scale = scale.height_mm / scale.viewbox[3]
    if (
        not math.isfinite(x_scale)
        or not math.isfinite(y_scale)
        or x_scale <= 0
        or y_scale <= 0
        or not math.isclose(x_scale, y_scale, rel_tol=1e-7, abs_tol=1e-10)
    ):
        return None
    return x_scale, y_scale


def _root_aspect_ratio_is_reliable(root: StdET.Element) -> bool:
    raw = " ".join((root.get("preserveAspectRatio") or "").split())
    if not raw:
        return True
    if raw == "none":
        return True
    parts = raw.split()
    return bool(
        (len(parts) == 1 and parts[0] in PRESERVE_ASPECT_RATIO_ALIGNMENTS)
        or (
            len(parts) == 2
            and parts[0] in PRESERVE_ASPECT_RATIO_ALIGNMENTS
            and parts[1] in {"meet", "slice"}
        )
    )


def _root_viewport_styles_match(
    root: StdET.Element,
    rules: list[tuple[str, dict[str, str]]],
    scale: DocumentScale,
) -> bool:
    """Reject a CSS viewport that disagrees with the physical root attributes."""
    styled = _style_for(root, {}, rules)
    for key, expected_mm in (("width", scale.width_mm), ("height", scale.height_mm)):
        if key not in styled:
            continue
        measured_mm, _, explicit = _parse_length(styled[key])
        if (
            not explicit
            or measured_mm is None
            or expected_mm is None
            or not math.isclose(measured_mm, expected_mm, rel_tol=1e-9, abs_tol=1e-7)
        ):
            return False
    return True


def _svg_number(value: float) -> str:
    text = format(value, ".15g")
    return "0" if text in {"-0", "-0.0"} else text


def _set_artboard_viewport(
    root: StdET.Element,
    *,
    target_width_mm: float,
    target_height_mm: float,
    viewbox: tuple[float, float, float, float],
    x_scale_mm_per_unit: float,
    y_scale_mm_per_unit: float,
) -> None:
    width_in = _svg_number(target_width_mm / 25.4)
    height_in = _svg_number(target_height_mm / 25.4)
    new_viewbox_width = target_width_mm / x_scale_mm_per_unit
    new_viewbox_height = target_height_mm / y_scale_mm_per_unit
    root.set("width", f"{width_in}in")
    root.set("height", f"{height_in}in")
    root.set(
        "viewBox",
        " ".join(
            _svg_number(value)
            for value in (viewbox[0], viewbox[1], new_viewbox_width, new_viewbox_height)
        ),
    )
    root.attrib.pop("viewbox", None)
    declarations = _declarations(root.get("style"))
    declarations.update({"width": f"{width_in}in", "height": f"{height_in}in"})
    root.set("style", ";".join(f"{key}:{value}" for key, value in declarations.items()))


def _same_optional_number(left: float | None, right: float | None, tolerance: float = 1e-4) -> bool:
    if left is None or right is None:
        return left is right
    return math.isclose(left, right, rel_tol=1e-9, abs_tol=tolerance)


def _same_bounds(left: Bounds | None, right: Bounds | None) -> bool:
    if left is None or right is None:
        return left is right
    return all(
        _same_optional_number(getattr(left, name), getattr(right, name))
        for name in ("x_mm", "y_mm", "width_mm", "height_mm")
    )


def _normalized_geometry_is_unchanged(
    before: list[ExtractedPath], after: list[ExtractedPath]
) -> bool:
    """Prove each normalized vector/raster placement stayed at the same physical coordinates."""
    if len(before) != len(after):
        return False
    for left, right in zip(before, after):
        if (
            left.source_id != right.source_id
            or left.preview.id != right.preview.id
            or left.preview.z_index != right.preview.z_index
            or left.preview.operation != right.preview.operation
            or left.preview.closed != right.preview.closed
            or left.color != right.color
            or left.fill != right.fill
            or left.dash != right.dash
            or left.ambiguous_transform != right.ambiguous_transform
            or not _same_optional_number(
                left.preview.stroke_width_mm, right.preview.stroke_width_mm
            )
            or not _same_bounds(left.preview.bounds, right.preview.bounds)
            or len(left.preview.points) != len(right.preview.points)
        ):
            return False
        for left_point, right_point in zip(left.preview.points, right.preview.points):
            if len(left_point) != len(right_point) or any(
                not math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-4)
                for a, b in zip(left_point, right_point)
            ):
                return False
    return True


def _paths_for_fix_verification(
    root: StdET.Element,
    metadata: dict[str, ElementMeta],
    assignment: AssignmentProfile,
    profile: LabProfile,
) -> list[ExtractedPath]:
    analysis_root = StdET.fromstring(StdET.tostring(root, encoding="utf-8"))
    _neutralize_image_payloads(analysis_root)
    paths, _, _ = _extract_paths(
        StdET.tostring(analysis_root, encoding="unicode"),
        metadata,
        assignment,
        profile.machine.vector_hairline_threshold_mm,
        profile.limits,
    )
    return paths


def fix_artboard(
    *,
    data: bytes,
    expected_sha256: str,
    profile: LabProfile,
    assignment: AssignmentProfile,
) -> FixedArtboardSVG:
    """Return a verified copy with only the exact-assignment viewport enlarged or reduced."""
    actual_sha256 = hashlib.sha256(data).hexdigest()
    if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha256) or actual_sha256 != expected_sha256.lower():
        raise ArtboardFixError(
            "The selected SVG no longer matches the analyzed file. Analyze it again before correcting the artboard."
        )
    if (
        assignment.page_policy != "exact"
        or assignment.expected_width_mm is None
        or assignment.expected_height_mm is None
    ):
        raise ArtboardFixError("This assignment does not define one exact artboard size.")

    root, _ = _validate_xml_safety(data, profile.limits)
    if any(_local_name(element.tag).lower() in {"use", "text"} for element in root.iter()):
        raise ArtboardFixError(
            "Automatic artboard correction is unavailable for SVGs with reusable <use> or live text geometry."
        )
    scale = _document_scale(root)
    original_scales = _artboard_scale_mm_per_unit(scale)
    if original_scales is None or not _root_aspect_ratio_is_reliable(root):
        raise ArtboardFixError(
            "The SVG needs explicit physical width and height, a valid viewBox, and matching horizontal and vertical scale before its artboard can be corrected safely."
        )
    if (
        abs((scale.width_mm or 0) - assignment.expected_width_mm) <= assignment.page_tolerance_mm
        and abs((scale.height_mm or 0) - assignment.expected_height_mm) <= assignment.page_tolerance_mm
    ):
        raise ArtboardFixError("The SVG artboard already matches the assignment size.")

    rules, unsupported_css = _css_rules(root)
    if not _root_viewport_styles_match(root, rules, scale):
        raise ArtboardFixError(
            "CSS width or height conflicts with the SVG's physical viewport, so the artboard cannot be corrected safely."
        )
    metadata, unsupported_effects, _, duplicate_source_ids = _collect_metadata(root, rules)
    _, external_images, invalid_images = _image_inventory(root, metadata, profile.limits)
    if duplicate_source_ids:
        raise ArtboardFixError("Duplicate object IDs make artboard verification unreliable.")
    if unsupported_css or unsupported_effects:
        raise ArtboardFixError("Unsupported SVG effects or CSS make artboard verification unreliable.")
    if external_images or invalid_images:
        raise ArtboardFixError("Embed or replace every raster image before correcting the artboard.")

    before_paths = _paths_for_fix_verification(root, metadata, assignment, profile)
    _set_artboard_viewport(
        root,
        target_width_mm=assignment.expected_width_mm,
        target_height_mm=assignment.expected_height_mm,
        viewbox=scale.viewbox,  # type: ignore[arg-type]
        x_scale_mm_per_unit=original_scales[0],
        y_scale_mm_per_unit=original_scales[1],
    )
    for element in root.iter():
        element_id = element.get("id")
        if element_id and metadata.get(element_id) and metadata[element_id].generated_id:
            element.attrib.pop("id", None)

    StdET.register_namespace("", "http://www.w3.org/2000/svg")
    fixed_data = StdET.tostring(root, encoding="utf-8", xml_declaration=True)
    if len(fixed_data) > profile.limits.max_upload_bytes:
        raise ArtboardFixError("The artboard-corrected SVG would exceed the upload size limit.")

    verify_root, _ = _validate_xml_safety(fixed_data, profile.limits)
    verify_scale = _document_scale(verify_root)
    verify_scales = _artboard_scale_mm_per_unit(verify_scale)
    if (
        verify_scales is None
        or verify_scale.width_mm is None
        or verify_scale.height_mm is None
        or verify_scale.viewbox is None
        or abs(verify_scale.width_mm - assignment.expected_width_mm) > 1e-7
        or abs(verify_scale.height_mm - assignment.expected_height_mm) > 1e-7
        or not math.isclose(verify_scale.viewbox[0], scale.viewbox[0], rel_tol=0, abs_tol=1e-10)  # type: ignore[index]
        or not math.isclose(verify_scale.viewbox[1], scale.viewbox[1], rel_tol=0, abs_tol=1e-10)  # type: ignore[index]
        or not math.isclose(verify_scales[0], original_scales[0], rel_tol=1e-9, abs_tol=1e-11)
        or not math.isclose(verify_scales[1], original_scales[1], rel_tol=1e-9, abs_tol=1e-11)
    ):
        raise ArtboardFixError("The corrected artboard did not preserve the original physical scale.")
    verify_rules, verify_css = _css_rules(verify_root)
    verify_metadata, verify_effects, _, verify_duplicates = _collect_metadata(verify_root, verify_rules)
    _, verify_external_images, verify_invalid_images = _image_inventory(
        verify_root, verify_metadata, profile.limits
    )
    if (
        verify_css
        or verify_effects
        or verify_duplicates
        or verify_external_images
        or verify_invalid_images
        or not _root_viewport_styles_match(verify_root, verify_rules, verify_scale)
    ):
        raise ArtboardFixError("The artboard-corrected SVG did not pass safety verification.")
    after_paths = _paths_for_fix_verification(verify_root, verify_metadata, assignment, profile)
    if not _normalized_geometry_is_unchanged(before_paths, after_paths):
        raise ArtboardFixError("The artboard correction would move or scale artwork, so no copy was created.")
    return FixedArtboardSVG(
        data=fixed_data,
        target_width_mm=assignment.expected_width_mm,
        target_height_mm=assignment.expected_height_mm,
    )


def fix_strokes(
    *,
    data: bytes,
    expected_sha256: str,
    profile: LabProfile,
    assignment: AssignmentProfile,
) -> FixedSVG:
    """Return a corrected copy containing only verified cut-stroke style changes."""
    actual_sha256 = hashlib.sha256(data).hexdigest()
    if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha256) or actual_sha256 != expected_sha256.lower():
        raise StrokeFixError(
            "The selected SVG no longer matches the analyzed file. Analyze it again before downloading a corrected copy."
        )
    target_process = _stroke_fix_target(assignment)
    root, _ = _validate_xml_safety(data, profile.limits)
    if any(_local_name(element.tag).lower() == "use" for element in root.iter()):
        raise StrokeFixError(
            "Automatic stroke correction is unavailable for SVGs that contain reusable <use> instances."
        )
    scale = _document_scale(root)
    rules, unsupported_css = _css_rules(root)
    metadata, unsupported_effects, _, duplicate_source_ids = _collect_metadata(root, rules)
    _, external_images, invalid_images = _image_inventory(root, metadata, profile.limits)
    if duplicate_source_ids:
        raise StrokeFixError("Duplicate object IDs make a safe targeted stroke correction impossible.")
    if unsupported_css or unsupported_effects:
        raise StrokeFixError("Unsupported SVG effects or CSS make a safe targeted stroke correction impossible.")
    if external_images or invalid_images:
        raise StrokeFixError("Embed or replace every raster image before creating a corrected SVG copy.")
    analysis_root = StdET.fromstring(StdET.tostring(root, encoding="utf-8"))
    _neutralize_image_payloads(analysis_root)
    if scale.width_mm and not analysis_root.get("width"):
        analysis_root.set("width", f"{scale.width_mm / MM_PER_PX}px")
    if scale.height_mm and not analysis_root.get("height"):
        analysis_root.set("height", f"{scale.height_mm / MM_PER_PX}px")
    normalized_xml = StdET.tostring(analysis_root, encoding="unicode")
    paths, _, _ = _extract_paths(
        normalized_xml,
        metadata,
        assignment,
        profile.machine.vector_hairline_threshold_mm,
        profile.limits,
    )
    candidates = _fixable_stroke_paths(
        paths,
        metadata,
        assignment,
        profile.machine.vector_hairline_threshold_mm,
        profile.limits.max_fixable_cut_stroke_width_mm,
    )
    source_ids = sorted({item.source_id for item in candidates})
    if not source_ids:
        raise StrokeFixError("No analyzer-identified cut strokes are eligible for automatic correction.")

    source_id_set = set(source_ids)
    changed = 0
    for element in root.iter():
        if element.get("id") in source_id_set:
            _set_inline_cut_style(element)
            changed += 1
    if changed != len(source_ids):
        raise StrokeFixError("The highlighted SVG objects could not be mapped back to unique source elements.")

    for element in root.iter():
        element_id = element.get("id")
        if element_id and metadata.get(element_id) and metadata[element_id].generated_id:
            element.attrib.pop("id", None)

    StdET.register_namespace("", "http://www.w3.org/2000/svg")
    fixed_data = StdET.tostring(root, encoding="utf-8", xml_declaration=True)
    if len(fixed_data) > profile.limits.max_upload_bytes:
        raise StrokeFixError("The corrected SVG would exceed the upload size limit.")

    # Re-run the same parser on the output. The copy is only returned when each
    # changed source now resolves to the configured cut process at 0.001 in.
    verify_root, _ = _validate_xml_safety(fixed_data, profile.limits)
    verify_scale = _document_scale(verify_root)
    verify_rules, verify_css = _css_rules(verify_root)
    verify_metadata, verify_effects, _, verify_duplicates = _collect_metadata(verify_root, verify_rules)
    if verify_css or verify_effects or verify_duplicates:
        raise StrokeFixError("The corrected SVG did not pass the required safety verification.")
    if verify_scale.width_mm and not verify_root.get("width"):
        verify_root.set("width", f"{verify_scale.width_mm / MM_PER_PX}px")
    if verify_scale.height_mm and not verify_root.get("height"):
        verify_root.set("height", f"{verify_scale.height_mm / MM_PER_PX}px")
    _neutralize_image_payloads(verify_root)
    verify_paths, _, _ = _extract_paths(
        StdET.tostring(verify_root, encoding="unicode"),
        verify_metadata,
        assignment,
        profile.machine.vector_hairline_threshold_mm,
        profile.limits,
    )
    changed_verify_paths = [item for item in verify_paths if item.source_id in source_id_set]
    verified_sources = {item.source_id for item in changed_verify_paths}
    if (
        verified_sources != source_id_set
        or any(item.preview.operation != target_process.id for item in changed_verify_paths)
    ):
        raise StrokeFixError("The corrected strokes did not re-analyze as exact black 0.001 in cuts.")
    return FixedSVG(data=fixed_data, changed_source_ids=source_ids)


def analyze_svg(
    *,
    data: bytes,
    filename: str,
    profile: LabProfile,
    assignment: AssignmentProfile,
    material: MaterialProfile,
    thickness_mm: float,
) -> AnalysisReport:
    """Analyze one SVG upload and return only normalized, JSON-safe data."""
    try:
        root, _ = _validate_xml_safety(data, profile.limits)
        has_use_elements = any(_local_name(element.tag).lower() == "use" for element in root.iter())
        has_live_text_elements = any(
            _local_name(element.tag).lower() == "text" for element in root.iter()
        )
        scale = _document_scale(root)
        rules, unsupported_css = _css_rules(root)
        metadata, unsupported_effects, hidden_count, duplicate_source_ids = _collect_metadata(root, rules)
        embedded_families, font_errors = _embedded_fonts(root, profile.limits.max_upload_bytes)
        images, external_images, invalid_images = _image_inventory(
            root, metadata, profile.limits
        )
        embedded_text, missing_text = _live_text_inventory(root, metadata, embedded_families)
        _neutralize_image_payloads(root)
        # Give inferred documents an explicit internal viewport so svgelements'
        # default 300x150 viewport cannot distort normalized output.
        if scale.width_mm and not root.get("width"):
            root.set("width", f"{scale.width_mm / MM_PER_PX}px")
        if scale.height_mm and not root.get("height"):
            root.set("height", f"{scale.height_mm / MM_PER_PX}px")
        sanitized_xml = StdET.tostring(root, encoding="unicode")
        paths, segment_count, hidden_geometry = _extract_paths(
            sanitized_xml,
            metadata,
            assignment,
            profile.machine.vector_hairline_threshold_mm,
            profile.limits,
            set(external_images + invalid_images),
        )
        raster_paths = [item for item in paths if item.preview.operation == "raster-engrave"]
        raster_assets: list[PreviewRasterAsset] = []
        raster_layers: list[PreviewRasterLayer] = []
        for image_index, image in enumerate(images, start=1):
            placements = [item for item in raster_paths if item.source_id == image["id"]]
            image["preview_ids"] = [item.preview.id for item in placements] or [image["id"]]
            image["bounds"] = [item.preview.bounds for item in placements if item.preview.bounds]
            dpi_values: list[float] = []
            for placement in placements:
                bounds = placement.preview.bounds
                if bounds and bounds.width_mm > 0 and bounds.height_mm > 0:
                    dpi_values.append(
                        min(
                            image["pixel_width"] / (bounds.width_mm / 25.4),
                            image["pixel_height"] / (bounds.height_mm / 25.4),
                        )
                    )
            if dpi_values:
                image["effective_dpi"] = _round(min(dpi_values), 1)
            if image["preview_data_url"]:
                asset_id = f"raster-asset-{image_index:04d}"
                raster_assets.append(
                    PreviewRasterAsset(
                        id=asset_id,
                        data_url=image["preview_data_url"],
                        pixel_width=image["pixel_width"],
                        pixel_height=image["pixel_height"],
                        preview_width_px=image["preview_pixel_width"],
                        preview_height_px=image["preview_pixel_height"],
                    )
                )
                for placement in placements:
                    corners = placement.preview.points[:4]
                    if len(corners) == 4:
                        raster_layers.append(
                            PreviewRasterLayer(
                                id=placement.preview.id,
                                asset_id=asset_id,
                                z_index=placement.preview.z_index,
                                corners_mm=corners,
                                opacity=image["opacity"],
                                preserve_aspect_ratio=image["preserve_aspect_ratio"],
                            )
                        )
    except UnsafeSVGError as exc:
        return failure_report(
            data=data,
            filename=filename,
            profile=profile,
            assignment=assignment,
            material=material,
            thickness_mm=thickness_mm,
            title="Unsafe or externally linked SVG",
            message=str(exc),
            rule_id="file.security",
        )
    except SVGAnalysisError as exc:
        return failure_report(
            data=data,
            filename=filename,
            profile=profile,
            assignment=assignment,
            material=material,
            thickness_mm=thickness_mm,
            title="Unreadable or unsupported SVG",
            message=str(exc),
        )

    effects = unsupported_effects + unsupported_css
    checks: list[CheckResult] = []
    _add_check(
        checks,
        rule_id="file.readable",
        title="SVG file is readable",
        state="pass",
        message="The SVG was parsed safely in memory.",
        evidence=[f"{len(data):,} bytes; {len(metadata):,} drawable objects inspected"],
    )
    _add_check(
        checks,
        rule_id="document.unique_ids",
        title="SVG object IDs are unique",
        state="blocker" if duplicate_source_ids else "pass",
        message=(
            f"{len(duplicate_source_ids)} duplicate source ID(s) make styles or references ambiguous."
            if duplicate_source_ids
            else "All declared SVG object IDs are unique."
        ),
        evidence=[f"Duplicate ID: {item}" for item in duplicate_source_ids],
        fix=(
            "In Illustrator, copy the artwork into a new document or rename duplicated objects, then export again."
            if duplicate_source_ids else None
        ),
    )

    document = DocumentInfo(
        width_mm=_round(scale.width_mm, 3) if scale.width_mm else None,
        height_mm=_round(scale.height_mm, 3) if scale.height_mm else None,
        units=scale.units,
        unit_confidence=scale.confidence,  # type: ignore[arg-type]
    )
    if scale.confidence == "unresolved":
        _add_check(
            checks,
            rule_id="document.units",
            title="Document scale and units",
            state="blocker",
            message="The physical document size cannot be established.",
            evidence=["No usable absolute width/height or viewBox dimensions were found."],
            fix="In Illustrator, set the artboard size and export SVG with width, height, and viewBox enabled.",
        )
    elif scale.confidence == "inferred":
        _add_check(
            checks,
            rule_id="document.units",
            title="Document scale and units",
            state="warning",
            message="Physical size was inferred using 96 CSS pixels per inch.",
            evidence=[
                f"Interpreted as {_format_inches(document.width_mm or 0)} x "
                f"{_format_inches(document.height_mm or 0)}"
            ],
            fix="Export with explicit in, mm, cm, pt, pc, or px width and height values.",
        )
    else:
        _add_check(
            checks,
            rule_id="document.units",
            title="Document scale and units",
            state="pass",
            message="The document declares a physical viewport.",
            evidence=[
                f"{_format_inches(document.width_mm or 0)} x "
                f"{_format_inches(document.height_mm or 0)}; source units: {scale.units}"
            ],
        )

    page_ok = scale.width_mm is not None and scale.height_mm is not None
    page_evidence: list[str] = []
    if page_ok and assignment.page_policy == "exact":
        expected_w = assignment.expected_width_mm or 0
        expected_h = assignment.expected_height_mm or 0
        page_evidence = [
            f"Measured {_format_inches(scale.width_mm)} x {_format_inches(scale.height_mm)}",
            f"Expected {_format_inches(expected_w)} x {_format_inches(expected_h)} "
            f"+/- {_format_inches(assignment.page_tolerance_mm)}",
        ]
        page_ok = (
            abs(scale.width_mm - expected_w) <= assignment.page_tolerance_mm
            and abs(scale.height_mm - expected_h) <= assignment.page_tolerance_mm
        )
    elif page_ok:
        page_evidence = [
            f"Document {_format_inches(scale.width_mm)} x {_format_inches(scale.height_mm)}",
            f"Usable bed {_format_inches(profile.machine.usable_width_mm)} x "
            f"{_format_inches(profile.machine.usable_height_mm)}",
        ]
        page_ok = (
            scale.width_mm <= profile.machine.usable_width_mm + assignment.page_tolerance_mm
            and scale.height_mm <= profile.machine.usable_height_mm + assignment.page_tolerance_mm
        )
    can_offer_artboard_fix = bool(
        not page_ok
        and assignment.page_policy == "exact"
        and _artboard_scale_mm_per_unit(scale) is not None
        and _root_aspect_ratio_is_reliable(root)
        and _root_viewport_styles_match(root, rules, scale)
        and not duplicate_source_ids
        and not effects
        and not external_images
        and not invalid_images
        and not has_use_elements
        and not has_live_text_elements
    )
    artboard_fix_actions = [
        FixAction(
            id="set-artboard",
            kind="set_artboard",
            label=(
                f"Set artboard to {_format_inches(assignment.expected_width_mm or 0)} x "
                f"{_format_inches(assignment.expected_height_mm or 0)}"
            ),
            description=(
                "Creates a separate SVG copy with the assignment artboard size while preserving "
                "the artwork's physical scale and coordinates. The original file is unchanged."
            ),
            endpoint="/api/v1/fix-artboard",
            object_ids=[],
            count=1,
            target_width_in=_round((assignment.expected_width_mm or 0) / 25.4, 6),
            target_height_in=_round((assignment.expected_height_mm or 0) / 25.4, 6),
        )
    ] if can_offer_artboard_fix else []
    _add_check(
        checks,
        rule_id="document.page_size",
        title="Artboard size",
        state="pass" if page_ok else "blocker",
        message="The artboard matches the assignment policy." if page_ok else "The artboard does not match the assignment page policy.",
        evidence=page_evidence or ["Physical artboard size is unresolved."],
        fix=None if page_ok else "Set the Illustrator artboard to the assignment size, then export the SVG again.",
        fix_actions=artboard_fix_actions,
    )

    outside_ids: list[str] = []
    if scale.width_mm is not None and scale.height_mm is not None:
        tolerance = assignment.page_tolerance_mm
        for item in paths:
            bounds = item.preview.bounds
            if bounds and (
                bounds.x_mm < -tolerance
                or bounds.y_mm < -tolerance
                or bounds.x_mm + bounds.width_mm > scale.width_mm + tolerance
                or bounds.y_mm + bounds.height_mm > scale.height_mm + tolerance
            ):
                outside_ids.append(item.preview.id)
    _add_check(
        checks,
        rule_id="document.artwork_bounds",
        title="Artwork stays on the artboard",
        state="blocker" if outside_ids else ("unverified" if scale.confidence == "unresolved" else "pass"),
        message=f"{len(outside_ids)} artwork object(s) extend beyond the artboard." if outside_ids else (
            "Artwork bounds cannot be verified without physical scale." if scale.confidence == "unresolved" else "All normalized artwork is inside the artboard."
        ),
        evidence=[f"Affected object: {item}" for item in outside_ids[:20]],
        fix="Move or resize the highlighted artwork so it remains fully inside the artboard." if outside_ids else None,
        object_ids=outside_ids,
        bounds=_bounds_for_ids(paths, outside_ids),
    )

    vector_paths = [item for item in paths if item.color is not None]
    approved_process_ids = {process.id for process in assignment.processes}
    through_cut_ids = {process.id for process in assignment.processes if process.require_closed}
    approved_paths = [item for item in paths if item.preview.operation in approved_process_ids]
    cut_paths = [item for item in approved_paths if item.preview.operation in through_cut_ids]
    unassigned_vectors = [item for item in vector_paths if item.preview.operation == "unassigned-vector"]
    dashed_cuts = [item for item in approved_paths if item.dash and item.dash.lower() not in {"none", "", "0"}]
    ambiguous_vectors = [item for item in approved_paths + unassigned_vectors if item.ambiguous_transform]
    process_bad = list({item.preview.id: item for item in unassigned_vectors + dashed_cuts + ambiguous_vectors}.values())
    process_evidence = [
        (
            f"{process.name}: target {_format_inches(process.stroke_width_mm, 5)}; "
            f"accepted Illustrator export range "
            f"{_format_inches(_process_stroke_range_mm(process)[0], 5)} to "
            f"{_format_inches(_process_stroke_range_mm(process)[1], 5)}"
        )
        for process in assignment.processes
    ]
    process_evidence.extend(
        [
        f"{item.preview.id}: stroke {item.color}, width "
        f"{_format_inches(item.preview.stroke_width_mm or 0, 5)}"
        for item in unassigned_vectors[:20]
        ]
    )
    process_evidence.extend(f"{item.preview.id}: dashed cut stroke" for item in dashed_cuts[:20])
    process_evidence.extend(f"{item.preview.id}: non-uniform/skewed stroke transform" for item in ambiguous_vectors[:20])
    if not approved_paths:
        process_evidence.append("No approved cut or score vectors were found.")
    process_blocked = bool(process_bad or not approved_paths)
    process_references = process_bad or (vector_paths if not approved_paths else [])
    target_processes = [
        process for process in assignment.processes
        if process.color == "#000000" and abs(process.stroke_width_mm - 0.0254) <= 1e-9
    ]
    fixable_paths = _fixable_stroke_paths(
        unassigned_vectors,
        metadata,
        assignment,
        profile.machine.vector_hairline_threshold_mm,
        profile.limits.max_fixable_cut_stroke_width_mm,
    )
    can_offer_stroke_fix = bool(
        fixable_paths
        and len(target_processes) == 1
        and not duplicate_source_ids
        and not effects
        and not external_images
        and not invalid_images
        and not has_use_elements
    )
    process_fix_actions = [
        FixAction(
            id="normalize-cut-strokes",
            kind="normalize_cut_strokes",
            label=f"Download a corrected copy ({len(fixable_paths)} stroke(s))",
            description=(
                "Creates a separate SVG copy with the highlighted likely-cut strokes set to "
                "black, 0.001 in, and non-scaling. The original file is unchanged."
            ),
            endpoint="/api/v1/fix-strokes",
            object_ids=[item.preview.id for item in fixable_paths],
            count=len(fixable_paths),
            target_color="#000000",
            target_stroke_width_in=0.001,
        )
    ] if can_offer_stroke_fix else []
    _add_check(
        checks,
        rule_id="vectors.process_setup",
        title="Cut color and hairline width",
        state="blocker" if process_blocked else "pass",
        message=(
            "All cut-weight strokes match an approved process; thicker strokes are treated as engraving." if not process_blocked else
            (f"{len(process_bad)} vector path(s) have an incorrect or ambiguous process setup."
             if process_bad else "No vector path matches an approved cut or score process.")
        ),
        evidence=process_evidence or [f"{len(approved_paths)} approved process path(s)"],
        fix=None if not process_blocked else "In Illustrator, use the assignment cut color, a solid 0.001 in stroke, and avoid non-uniform scaling of stroked paths.",
        object_ids=[item.preview.id for item in process_references],
        bounds=[item.preview.bounds for item in process_references if item.preview.bounds],
        fix_actions=process_fix_actions,
    )

    unintended_hairlines = [
        item for item in unassigned_vectors
        if item.preview.stroke_width_mm is not None
        and item.preview.stroke_width_mm <= profile.machine.vector_hairline_threshold_mm + 1e-6
    ]
    _add_check(
        checks,
        rule_id="vectors.unapproved_hairlines",
        title="No unintended vector hairlines",
        state="blocker" if unintended_hairlines else "pass",
        message=f"{len(unintended_hairlines)} unapproved hairline(s) could be sent as vectors." if unintended_hairlines else "No unapproved vector-weight strokes were found.",
        evidence=[
            f"{item.preview.id}: {_format_inches(item.preview.stroke_width_mm or 0, 5)}"
            for item in unintended_hairlines[:20]
        ],
        fix="Remove stray strokes or assign each highlighted hairline to an approved cut/score process." if unintended_hairlines else None,
        object_ids=[item.preview.id for item in unintended_hairlines],
        bounds=[item.preview.bounds for item in unintended_hairlines if item.preview.bounds],
    )

    open_cuts = [item for item in cut_paths if not item.preview.closed]
    _add_check(
        checks,
        rule_id="geometry.closed_cuts",
        title="Through-cut paths are closed",
        state="blocker" if open_cuts else "pass",
        message=f"{len(open_cuts)} through-cut path(s) are open." if open_cuts else "All through-cut paths form closed loops.",
        evidence=[f"Open path: {item.preview.id}" for item in open_cuts[:20]],
        fix="Join the highlighted end anchors in Illustrator so each through-cut outline is a closed path." if open_cuts else None,
        object_ids=[item.preview.id for item in open_cuts],
        bounds=[item.preview.bounds for item in open_cuts if item.preview.bounds],
    )

    degenerate = [item for item in cut_paths if item.line.length <= max(0.01, material.kerf_mm / 2)]
    self_intersections = [item for item in cut_paths if not item.line.is_simple]
    seen: dict[tuple[tuple[float, float], ...], ExtractedPath] = {}
    duplicates: list[ExtractedPath] = []
    for item in cut_paths:
        key = _canonical_line(item.line)
        if key in seen:
            duplicates.extend([seen[key], item])
        else:
            seen[key] = item
    duplicates = list({item.preview.id: item for item in duplicates}.values())
    overlap_ids: set[str] = set()
    crossing_ids: set[str] = set()
    close_ids: set[str] = set()
    min_spacing: float | None = None
    topology_limit_reached = False
    topology_pair_checks = 0
    if len(cut_paths) > 1:
        tree = STRtree([item.line for item in cut_paths])
        for index, item in enumerate(cut_paths):
            for candidate_value in tree.query(item.line.buffer(material.min_spacing_mm)):
                candidate = int(candidate_value)
                if candidate <= index:
                    continue
                topology_pair_checks += 1
                if topology_pair_checks > MAX_PAIRWISE_GEOMETRY_CHECKS:
                    topology_limit_reached = True
                    break
                other = cut_paths[candidate]
                distance = item.line.distance(other.line)
                if min_spacing is None or distance < min_spacing:
                    min_spacing = distance
                if 0 < distance < material.min_spacing_mm:
                    close_ids.update((item.preview.id, other.preview.id))
                if not item.line.intersects(other.line):
                    continue
                intersection = item.line.intersection(other.line)
                # GeometryCollection is common when closed rings both share a
                # segment and meet at a point; any non-trivial linear length is
                # still a coincident cut overlap.
                if intersection.length > 0.01:
                    overlap_ids.update((item.preview.id, other.preview.id))
                elif not intersection.is_empty:
                    crossing_ids.update((item.preview.id, other.preview.id))
            if topology_limit_reached:
                break
    topology_ids = set(item.preview.id for item in degenerate + self_intersections + duplicates) | overlap_ids
    if topology_limit_reached:
        topology_ids.update(item.preview.id for item in cut_paths[:20])
    topology_evidence = []
    if degenerate:
        topology_evidence.append(f"{len(degenerate)} degenerate/kerf-sized path(s)")
    if self_intersections:
        topology_evidence.append(f"{len(self_intersections)} self-intersecting path(s)")
    if duplicates:
        topology_evidence.append(f"{len(duplicates)} duplicate or reversed duplicate path(s)")
    if overlap_ids:
        topology_evidence.append(f"{len(overlap_ids)} path(s) participate in coincident overlaps")
    if topology_limit_reached:
        topology_evidence.append(
            f"Pairwise topology work exceeded the {MAX_PAIRWISE_GEOMETRY_CHECKS:,}-comparison safety limit"
        )
    _add_check(
        checks,
        rule_id="geometry.topology",
        title="Cut topology is valid",
        state="blocker" if topology_ids else "pass",
        message=(
            "Cut geometry is too dense to verify safely within the comparison limit."
            if topology_limit_reached else
            ("Cut geometry has blocking overlaps or invalid paths." if topology_ids else "No self-intersections, duplicates, or coincident overlaps were found.")
        ),
        evidence=topology_evidence,
        fix="Use Illustrator's Outline/Pathfinder tools to remove duplicates, self-intersections, zero-length paths, and shared cut segments." if topology_ids else None,
        object_ids=sorted(topology_ids),
        bounds=_bounds_for_ids(paths, topology_ids),
    )
    _add_check(
        checks,
        rule_id="geometry.crossings",
        title="Cut crossings and touches",
        state="warning" if crossing_ids else "pass",
        message=f"{len(crossing_ids)} path(s) cross or touch another path; verify this is intentional." if crossing_ids else "No separate cut paths cross or touch.",
        evidence=[f"Affected path: {item}" for item in sorted(crossing_ids)[:20]],
        fix="Inspect the highlighted intersections and separate or combine paths if the crossing is accidental." if crossing_ids else None,
        object_ids=sorted(crossing_ids),
        bounds=_bounds_for_ids(paths, crossing_ids),
    )

    effect_source_ids = sorted({entry.split(":", 1)[0] for entry in unsupported_effects})
    effect_preview_ids = _preview_ids_for_source_ids(paths, effect_source_ids)
    _add_check(
        checks,
        rule_id="geometry.effects",
        title="Geometry uses supported SVG features",
        state="blocker" if effects else "pass",
        message="Effects or CSS make the cut geometry unreliable." if effects else "No unsupported masks, filters, clipping, paint servers, or CSS were found.",
        evidence=effects[:30],
        fix="Expand appearances in Illustrator and remove clipping masks, filters, opacity, gradients/patterns, and complex CSS from cut artwork." if effects else None,
        object_ids=effect_preview_ids,
        bounds=_bounds_for_ids(paths, effect_source_ids),
    )

    if external_images or invalid_images:
        resource_ids = external_images + invalid_images
        if external_images:
            resource_message = (
                "A linked image is only a pointer to a file on the computer that created this SVG. "
                "The review Space and laser workstation cannot access those pixels, so the engraving "
                "could be missing or different. Embed the image so its pixels travel inside the SVG."
            )
        else:
            resource_message = "One or more embedded raster images could not be decoded safely."
        resource_evidence = [f"Linked image object: {item}" for item in external_images]
        resource_evidence.extend(f"Unreadable embedded image object: {item}" for item in invalid_images)
        _add_check(
            checks,
            rule_id="assets.images_embedded",
            title="Images are embedded and readable",
            state="blocker",
            message=resource_message,
            evidence=resource_evidence,
            fix=(
                "In Illustrator, open Window > Links, select each linked image, choose Embed Image(s), "
                "then export a fresh SVG."
            ),
            object_ids=resource_ids,
            bounds=_bounds_for_ids(paths, resource_ids),
        )
    else:
        _add_check(
            checks,
            rule_id="assets.images_embedded",
            title="Images are embedded and readable",
            state="pass",
            message="All raster images are embedded and readable." if images else "No raster images are present.",
            evidence=[f"{len(images)} embedded image(s)"],
        )

    if images:
        image_state = "blocker" if assignment.image_policy == "blocker" else ("warning" if assignment.image_policy == "warning" else "info")
        _add_check(
            checks,
            rule_id="assets.raster_presence",
            title="Raster image presence",
            state=image_state,
            message=f"The SVG contains {len(images)} raster image(s).",
            evidence=[f"{item['id']}: {item['pixel_width']} x {item['pixel_height']} px" for item in images],
            fix="If this is a tracing assignment, finish tracing, remove the placed image, and submit vector outlines only." if image_state in {"blocker", "warning"} else None,
            object_ids=[preview_id for item in images for preview_id in item.get("preview_ids", [item["id"]])],
            bounds=[bound for item in images for bound in item.get("bounds", [])],
        )
    else:
        _add_check(checks, rule_id="assets.raster_presence", title="Raster image presence", state="pass", message="No raster images are present.")
    low_dpi = [
        item for item in images
        if item["effective_dpi"] is not None and item["effective_dpi"] < assignment.min_raster_dpi
    ]
    if low_dpi:
        _add_check(
            checks,
            rule_id="assets.raster_resolution",
            title="Raster engraving resolution",
            state="warning",
            message=f"{len(low_dpi)} raster image(s) are below {assignment.min_raster_dpi:g} effective DPI.",
            evidence=[f"{item['id']}: {item['effective_dpi']} DPI" for item in low_dpi],
            fix="Replace the image with a higher-resolution embedded source or reduce its placed size.",
            object_ids=[preview_id for item in low_dpi for preview_id in item.get("preview_ids", [item["id"]])],
            bounds=[bound for item in low_dpi for bound in item.get("bounds", [])],
        )

    font_problem_ids = missing_text
    font_preview_ids = _preview_ids_for_source_ids(paths, font_problem_ids)
    if font_errors or font_problem_ids:
        _add_check(
            checks,
            rule_id="assets.fonts",
            title="Fonts are outlined or embedded",
            state="blocker",
            message=f"{len(font_problem_ids)} live text object(s) depend on unavailable fonts.",
            evidence=font_errors + [f"Live text: {item}" for item in font_problem_ids],
            fix="In Illustrator, select live text and choose Type > Create Outlines, or embed a valid font in the SVG.",
            object_ids=font_preview_ids,
            bounds=_bounds_for_ids(paths, font_problem_ids),
        )
    else:
        _add_check(
            checks,
            rule_id="assets.fonts",
            title="Fonts are outlined or embedded",
            state="pass",
            message="No unembedded live text was found.",
            evidence=[f"{len(embedded_text)} embedded-font text object(s); outlined text appears as paths"],
        )

    cut_with_fill = [item for item in cut_paths if item.fill is not None]
    _add_check(
        checks,
        rule_id="vectors.cut_fills",
        title="Cut paths do not carry fills",
        state="warning" if cut_with_fill else "pass",
        message=f"{len(cut_with_fill)} cut path(s) also have a fill that may engrave." if cut_with_fill else "Cut paths do not include visible fills.",
        evidence=[f"Filled cut: {item.preview.id}" for item in cut_with_fill],
        fix="Set Fill to None on through-cut paths unless the engraving is intentional." if cut_with_fill else None,
        object_ids=[item.preview.id for item in cut_with_fill],
        bounds=[item.preview.bounds for item in cut_with_fill if item.preview.bounds],
    )

    cut_polygons: list[tuple[ExtractedPath, Polygon]] = []
    fragile_ids: set[str] = set(close_ids)
    tiny_ids: set[str] = set()
    clearances: list[float] = []
    for item in cut_paths:
        polygon = _polygon_for_path(item)
        if polygon is None or not polygon.is_valid:
            continue
        cut_polygons.append((item, polygon))
        clearance = float(minimum_clearance(polygon))
        if math.isfinite(clearance):
            clearances.append(clearance)
            if clearance < material.min_bridge_mm:
                fragile_ids.add(item.preview.id)
        if polygon.area < material.min_piece_area_mm2:
            tiny_ids.add(item.preview.id)
            fragile_ids.add(item.preview.id)
    total_cut_length = sum(item.line.length for item in cut_paths)
    page_area = (scale.width_mm or 0) * (scale.height_mm or 0)
    cut_density = total_cut_length / page_area if page_area else 0.0
    dense = bool(page_area and cut_density > material.heat_density_threshold_mm_per_mm2)
    fragility_evidence: list[str] = []
    if close_ids:
        fragility_evidence.append(
            f"{len(close_ids)} path(s) are closer than {_format_inches(material.min_spacing_mm)}"
        )
    if tiny_ids:
        fragility_evidence.append(
            f"{len(tiny_ids)} enclosed region(s) are below "
            f"{_format_square_inches(material.min_piece_area_mm2)}"
        )
    if fragile_ids - close_ids - tiny_ids:
        fragility_evidence.append(
            f"Thin features below the {_format_inches(material.min_bridge_mm)} bridge guideline"
        )
    if dense:
        fragility_evidence.append(
            f"Cut density {cut_density * 25.4:.3f} in/in² exceeds the "
            f"{material.heat_density_threshold_mm_per_mm2 * 25.4:.3f} in/in² guideline"
        )
    _add_check(
        checks,
        rule_id="material.fragility",
        title="Estimated feature strength and spacing",
        state="warning" if fragile_ids or dense else "pass",
        message="Material-dependent fragile or heat-dense areas need instructor review." if fragile_ids or dense else "No features fall below the demo material thresholds.",
        evidence=fragility_evidence,
        fix="Increase bridges and spacing, remove tiny loose pieces, or ask the instructor to review the highlighted geometry." if fragile_ids or dense else None,
        object_ids=sorted(fragile_ids),
        bounds=_bounds_for_ids(paths, fragile_ids),
    )

    ordering_ids: set[str] = set()
    ordering_limit_reached = False
    ordering_checks = 0
    if len(cut_polygons) > 1:
        polygon_tree = STRtree([polygon for _, polygon in cut_polygons])
        representative_points = [polygon.representative_point() for _, polygon in cut_polygons]
        for outer_index, (outer_item, outer_polygon) in enumerate(cut_polygons):
            for candidate_value in polygon_tree.query(outer_polygon):
                inner_index = int(candidate_value)
                if inner_index <= outer_index:
                    continue
                ordering_checks += 1
                if ordering_checks > MAX_PAIRWISE_GEOMETRY_CHECKS:
                    ordering_limit_reached = True
                    break
                inner_item, _ = cut_polygons[inner_index]
                if outer_polygon.contains(representative_points[inner_index]):
                    ordering_ids.update((outer_item.preview.id, inner_item.preview.id))
            if ordering_limit_reached:
                break
    ordering_references = ordering_ids or (
        {item.preview.id for item, _ in cut_polygons[:20]} if ordering_limit_reached else set()
    )
    ordering_evidence = [f"Review order near {item}" for item in sorted(ordering_ids)[:20]]
    if ordering_limit_reached:
        ordering_evidence.append(
            f"Ordering review stopped at the {MAX_PAIRWISE_GEOMETRY_CHECKS:,}-comparison safety limit"
        )
    _add_check(
        checks,
        rule_id="vectors.cut_order",
        title="Inner cuts appear before outer cuts",
        state="warning" if ordering_ids or ordering_limit_reached else "pass",
        message=(
            "Cut order could not be fully verified within the comparison limit."
            if ordering_limit_reached else
            ("Some outer paths appear before contained paths in document order." if ordering_ids else "No obvious inner-before-outer ordering issue was found.")
        ),
        evidence=ordering_evidence,
        fix=(
            "In Illustrator's Layers panel, arrange inner details before their outer perimeter paths."
            if ordering_ids or ordering_limit_reached else None
        ),
        object_ids=sorted(ordering_references),
        bounds=_bounds_for_ids(paths, ordering_references),
    )

    hidden_total = max(hidden_count, hidden_geometry)
    if hidden_total:
        _add_check(
            checks,
            rule_id="document.hidden_objects",
            title="Hidden or non-rendering artwork",
            state="warning",
            message=f"{hidden_total} hidden/non-rendering object(s) were ignored.",
            evidence=["Hidden content can make the submitted file differ from the student's intent."],
            fix="Delete unused hidden artwork or make intentional artwork visible before export.",
        )

    pieces = [] if topology_ids else _piece_geometry(
        cut_paths, material.kerf_mm, profile.limits.max_preview_points
    )
    invalid_3d_reasons: list[str] = []
    if not cut_paths:
        invalid_3d_reasons.append("no approved closed cut regions")
    if open_cuts:
        invalid_3d_reasons.append("open cut paths")
    if topology_ids:
        invalid_3d_reasons.append("invalid or overlapping cut topology")
    if scale.confidence == "unresolved":
        invalid_3d_reasons.append("unresolved physical scale")
    if not pieces:
        invalid_3d_reasons.append("no polygonized pieces")
    if effects:
        invalid_3d_reasons.append("unsupported SVG effects")
    valid_3d = not invalid_3d_reasons

    operation_counts: dict[str, int] = {}
    for item in paths:
        operation_counts[item.preview.operation] = operation_counts.get(item.preview.operation, 0) + 1
    effective_dpis = [item["effective_dpi"] for item in images if item["effective_dpi"] is not None]
    metrics: dict[str, Any] = {
        "object_count": len(metadata),
        "vector_path_count": sum(
            item.preview.operation not in {"raster-engrave", "engrave-text"} for item in paths
        ),
        "preview_object_count": len(paths),
        "path_segment_count": segment_count,
        "cut_path_count": len(cut_paths),
        "approved_vector_path_count": len(approved_paths),
        "operation_inventory": operation_counts,
        "total_cut_length_mm": _round(total_cut_length, 2),
        "image_count": len(images),
        "image_inventory": [
            {
                "id": item["id"],
                "pixel_width": item["pixel_width"],
                "pixel_height": item["pixel_height"],
                "effective_dpi": item["effective_dpi"],
            }
            for item in images
        ],
        "live_text_count": len(embedded_text) + len(missing_text),
        "live_text_object_ids": sorted(embedded_text + missing_text),
        "embedded_font_count": len(embedded_families),
        "embedded_font_families": sorted(embedded_families),
        "minimum_raster_dpi": min(effective_dpis) if effective_dpis else None,
        "required_raster_dpi": assignment.min_raster_dpi,
        "smallest_piece_area_mm2": min((piece.area_mm2 for piece in pieces), default=None),
        "minimum_feature_mm": _round(min(clearances), 3) if clearances else None,
        "minimum_cut_spacing_mm": _round(min_spacing, 3) if min_spacing is not None else None,
        "cut_density_mm_per_mm2": _round(cut_density, 4),
        "heat_density_threshold_mm_per_mm2": material.heat_density_threshold_mm_per_mm2,
        "material": material.name,
        "material_family": material.family,
        "material_thickness_mm": thickness_mm,
        "kerf_mm": material.kerf_mm,
        "manual_operator_checklist": profile.operator_checklist,
    }
    _add_check(
        checks,
        rule_id="operator.manual_review",
        title="Instructor and operator checks are still required",
        state="info",
        message="This preflight does not approve material, machine settings, placement, ventilation, or unattended operation.",
        evidence=profile.operator_checklist,
    )
    if profile.profile.demo:
        _add_check(
            checks,
            rule_id="profile.demo",
            title="Demo lab thresholds",
            state="unverified",
            message="This installation is using example machine and material values, so it cannot mark a file ready.",
            evidence=[f"Profile {profile.profile.id} version {profile.profile.version}"],
            fix="An instructor must validate the lab profile with known-good and known-bad exports before production use.",
        )

    _apply_severity_overrides(checks, assignment, material)

    return _base_report(
        data=data,
        filename=filename,
        profile=profile,
        assignment=assignment,
        material=material,
        thickness_mm=thickness_mm,
        checks=checks,
        document=document,
        metrics=metrics,
        geometry=PreviewGeometry(
            page={"width_mm": document.width_mm, "height_mm": document.height_mm},
            paths=[item.preview for item in paths],
            pieces=pieces,
            raster_assets=raster_assets,
            raster_layers=raster_layers,
            valid_3d=valid_3d,
            invalid_reason="; ".join(dict.fromkeys(invalid_3d_reasons)) if invalid_3d_reasons else None,
        ),
    )
