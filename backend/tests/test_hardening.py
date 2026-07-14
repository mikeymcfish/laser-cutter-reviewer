from __future__ import annotations

import asyncio
import base64
import copy
import io

import pytest
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from PIL import Image
from pydantic import ValidationError

from backend import main as main_module
from backend.main import AggregateRequestLimitMiddleware
from backend.models import LabProfile, PreviewRasterLayer, ProcessProfile
from backend.profile import load_profile, public_profile
from backend.svg_analyzer import _safe_png_preview, analyze_svg

from .conftest import check, post_svg, svg_document


def test_group_effects_and_hidden_state_propagate_to_children(client):
    affected = svg_document(
        '<defs><filter id="blur"/></defs>'
        '<g filter="url(#blur)" opacity=".5">'
        '<rect id="part" x="96" y="96" width="192" height="192" fill="none" stroke="#000" stroke-width=".096"/>'
        '</g>'
    )
    report = post_svg(client, affected).json()
    effects = check(report, "geometry.effects")
    assert effects["state"] == "blocker"
    assert "part" in effects["object_ids"]
    assert any("ancestor" in item and "filter" in item for item in effects["evidence"])

    hidden = svg_document(
        '<g display="none"><rect id="hidden-part" x="96" y="96" width="192" height="192" '
        'fill="none" stroke="#000" stroke-width=".096"/></g>'
    )
    hidden_report = post_svg(client, hidden).json()
    assert hidden_report["geometry"]["paths"] == []
    assert check(hidden_report, "document.hidden_objects")["state"] == "warning"


@pytest.mark.parametrize(
    "body",
    [
        '<path id="huge" d="M0 0L1e20 1" fill="none" stroke="#000" stroke-width=".096"/>',
        '<path id="bad-stroke" d="M0 0L10 10" fill="none" stroke="#000" stroke-width="NaN"/>',
        '<path id="bad-transform" d="M0 0L10 10" fill="none" stroke="#000" stroke-width=".096" transform="matrix(1e309 0 0 1 0 0)"/>',
    ],
)
def test_nonfinite_or_extreme_geometry_returns_report_not_500(client, body):
    response = post_svg(client, svg_document(body))
    assert response.status_code == 200
    report = response.json()
    assert report["summary"]["counts"]["blocker"] >= 1
    assert report["geometry"]["valid_3d"] is False


def test_unexpected_analyzer_error_has_safe_api_fallback(client, good_svg, monkeypatch):
    def fail(**_kwargs):
        raise OverflowError("private parser detail")

    monkeypatch.setattr(main_module, "analyze_svg", fail)
    response = post_svg(client, good_svg)
    assert response.status_code == 200
    report = response.json()
    assert check(report, "file.numeric_safety")["state"] == "blocker"
    assert "private parser detail" not in response.text


def test_declared_and_streamed_request_size_limits(client, good_svg):
    response = client.post(
        "/api/v1/analyze",
        headers={"content-length": str(50 * 1024 * 1024)},
        files={"file": ("a.svg", good_svg, "image/svg+xml")},
        data={"assignment_id": "intro-svg", "material_id": "birch-plywood", "thickness_mm": "3"},
    )
    assert response.status_code == 413

    async def exercise_stream_limit():
        reached = False

        async def downstream(_scope, receive, send):
            nonlocal reached
            while True:
                message = await receive()
                if not message.get("more_body", False):
                    break
            reached = True
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        middleware = AggregateRequestLimitMiddleware(downstream, max_bytes=5)
        chunks = [
            {"type": "http.request", "body": b"1234", "more_body": True},
            {"type": "http.request", "body": b"5678", "more_body": False},
        ]
        sent = []

        async def receive():
            return chunks.pop(0)

        async def send(message):
            sent.append(message)

        await middleware(
            {"type": "http", "method": "POST", "path": "/api/v1/analyze", "headers": []},
            receive,
            send,
        )
        assert reached is False
        assert sent[0]["status"] == 413

    asyncio.run(exercise_stream_limit())


def test_xml_depth_and_element_limits_fail_before_full_analysis():
    profile = load_profile()
    assignment = profile.assignments[0]
    material = profile.materials[0]
    shallow_limits = profile.limits.model_copy(update={"max_xml_depth": 3})
    limited_profile = profile.model_copy(update={"limits": shallow_limits})
    data = svg_document('<g><g><g><rect x="1" y="1" width="2" height="2"/></g></g></g>')
    report = analyze_svg(
        data=data,
        filename="deep.svg",
        profile=limited_profile,
        assignment=assignment,
        material=material,
        thickness_mm=3,
    )
    assert check(report.model_dump(by_alias=True), "file.readable")["state"] == "blocker"
    assert "depth" in report.checks[0].message.lower()


def test_duplicate_source_and_use_instance_ids_are_safe_and_unique(client):
    duplicate = svg_document(
        '<g fill="none" stroke="#000" stroke-width=".2">'
        '<rect id="same" x="96" y="96" width="96" height="96"/>'
        '<rect id="same" x="240" y="96" width="96" height="96"/>'
        '</g>'
    )
    duplicate_report = post_svg(client, duplicate).json()
    assert check(duplicate_report, "document.unique_ids")["state"] == "blocker"
    assert check(duplicate_report, "vectors.process_setup")["fix_actions"] == []
    ids = [item["id"] for item in duplicate_report["geometry"]["paths"]]
    assert len(ids) == len(set(ids))

    uses = svg_document(
        '<defs><rect id="shape" width="96" height="96" fill="none" stroke="#000" stroke-width=".096"/></defs>'
        '<use id="first" href="#shape" x="96" y="96"/>'
        '<use id="second" href="#shape" x="288" y="96"/>'
    )
    use_report = post_svg(client, uses).json()
    use_ids = [item["id"] for item in use_report["geometry"]["paths"]]
    assert len(use_ids) >= 2
    assert len(use_ids) == len(set(use_ids))
    assert {"first", "second"}.issubset(set(use_ids))

    affected_use = svg_document(
        '<defs><rect id="base" width="96" height="96" fill="none" '
        'stroke="#000" stroke-width=".096"/></defs>'
        '<use id="faded-use" href="#base" x="96" y="96" opacity=".5"/>'
    )
    affected_report = post_svg(client, affected_use).json()
    effect = check(affected_report, "geometry.effects")
    assert effect["state"] == "blocker"
    assert "faded-use" in effect["object_ids"]
    assert effect["bounds"]


def test_raster_placeholder_uses_normalized_transformed_bounds(client):
    png = base64.b64encode(
        base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
    ).decode()
    data = svg_document(
        '<rect id="cut" x="96" y="96" width="192" height="192" fill="none" stroke="#000" stroke-width=".096"/>'
        f'<g transform="scale(2)"><image id="photo" x="550" y="100" width="96" height="48" '
        f'href="data:image/png;base64,{png}"/></g>'
    )
    report = post_svg(client, data).json()
    placeholder = next(item for item in report["geometry"]["paths"] if item["id"] == "photo")
    assert placeholder["operation"] == "raster-engrave"
    assert placeholder["bounds"]["width_mm"] == pytest.approx(50.8, abs=.01)
    assert placeholder["bounds"]["height_mm"] == pytest.approx(25.4, abs=.01)
    raster_check = check(report, "assets.raster_presence")
    assert "photo" in raster_check["object_ids"]
    assert raster_check["bounds"]
    assert check(report, "assets.raster_resolution")["state"] == "warning"
    bounds_check = check(report, "document.artwork_bounds")
    assert bounds_check["state"] == "blocker"
    assert "photo" in bounds_check["object_ids"]


@pytest.mark.parametrize(
    "limit_update",
    [
        {"max_embedded_images": 1},
        {"max_total_embedded_image_pixels": 1},
    ],
)
def test_cumulative_embedded_raster_work_limits_stop_additional_previews(limit_update):
    profile = load_profile()
    limited = profile.model_copy(update={"limits": profile.limits.model_copy(update=limit_update)})
    png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    data = svg_document(
        f'<image id="first-image" x="96" y="96" width="96" height="96" href="data:image/png;base64,{png}"/>'
        f'<image id="over-limit-image" x="240" y="96" width="96" height="96" href="data:image/png;base64,{png}"/>'
        '<rect id="cut" x="96" y="300" width="192" height="192" fill="none" stroke="#000" stroke-width=".096"/>'
    )
    report = analyze_svg(
        data=data,
        filename="raster-limits.svg",
        profile=limited,
        assignment=limited.assignments[0],
        material=limited.materials[0],
        thickness_mm=3,
    ).model_dump(by_alias=True)
    assert check(report, "assets.images_embedded")["state"] == "blocker"
    assert report["metrics"]["image_count"] == 1
    assert len(report["geometry"]["raster_assets"]) == 1
    assert report["geometry"]["raster_assets"][0]["id"] == "raster-asset-0001"


def test_zero_remaining_preview_budget_returns_without_pixel_conversion(monkeypatch):
    profile = load_profile()
    image = Image.new("RGB", (2, 3), "white")

    def forbidden_convert(*_args, **_kwargs):
        raise AssertionError("pixel conversion should not run without a preview-byte budget")

    monkeypatch.setattr(Image.Image, "convert", forbidden_convert)
    data_url, width, height = _safe_png_preview(image, profile.limits, remaining_bytes=0)
    assert data_url is None
    assert (width, height) == (2, 3)


@pytest.mark.parametrize(
    "value",
    ["none", "xMinYMin meet", "xMidYMid meet", "xMaxYMax slice"],
)
def test_raster_layer_accepts_only_normalized_aspect_ratio_contract(value):
    layer = PreviewRasterLayer(
        id="layer",
        asset_id="asset",
        z_index=0,
        corners_mm=[[0, 0], [1, 0], [1, 1], [0, 1]],
        preserve_aspect_ratio=value,
    )
    assert layer.preserve_aspect_ratio == value


@pytest.mark.parametrize("value", ["defer xMidYMid meet", "xmidymid meet", "stretch", "xMidYMid"])
def test_raster_layer_rejects_non_normalized_aspect_ratio_values(value):
    with pytest.raises(ValidationError):
        PreviewRasterLayer(
            id="layer",
            asset_id="asset",
            z_index=0,
            corners_mm=[[0, 0], [1, 0], [1, 1], [0, 1]],
            preserve_aspect_ratio=value,
        )


@pytest.mark.parametrize("z_index", [-1, "1"])
def test_raster_layer_z_index_is_required_nonnegative_strict_integer(z_index):
    with pytest.raises(ValidationError):
        PreviewRasterLayer(
            id="layer",
            asset_id="asset",
            z_index=z_index,
            corners_mm=[[0, 0], [1, 0], [1, 1], [0, 1]],
        )


def test_unapproved_materials_are_not_public_and_metric_name_is_stable(client, good_svg):
    profile = load_profile()
    unapproved = profile.materials[0].model_copy(update={"id": "not-for-students", "approved": False})
    modified = profile.model_copy(update={"materials": profile.materials + [unapproved]})
    assert "not-for-students" not in {item["id"] for item in public_profile(modified)["materials"]}

    report = post_svg(client, good_svg).json()
    assert "minimum_feature_mm" in report["metrics"]
    assert "smallest_estimated_feature_mm" not in report["metrics"]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda data: data.update(assignments=[]),
        lambda data: data["assignments"].append(copy.deepcopy(data["assignments"][0])),
        lambda data: data["assignments"][0].update(expected_width_mm=None),
        lambda data: data["machine"].update(margin_mm=data["machine"]["bed_width_mm"]),
        lambda data: data["materials"][0]["preview"].update(color="wood"),
        lambda data: data.update(operator_checklist=[]),
        lambda data: data["limits"].update(max_fixable_cut_stroke_width_mm=0),
        lambda data: data["limits"].update(max_total_embedded_image_pixels=0),
        lambda data: data["limits"].update(max_embedded_images=0),
        lambda data: data["assignments"][0]["processes"][0].update(
            stroke_lower_tolerance_mm=data["assignments"][0]["processes"][0]["stroke_width_mm"]
        ),
    ],
)
def test_core_profile_validation_rejects_invalid_configuration(mutate):
    data = load_profile().model_dump()
    mutate(data)
    with pytest.raises(ValidationError):
        LabProfile.model_validate(data)


def test_open_score_process_is_approved_but_not_used_as_cut_topology():
    profile = load_profile()
    base_assignment = profile.assignments[0]
    score = ProcessProfile(
        id="score",
        name="Score",
        color="#0000ff",
        stroke_width_mm=.0254,
        stroke_tolerance_mm=.0005,
        require_closed=False,
    )
    assignment = base_assignment.model_copy(update={"processes": base_assignment.processes + [score]})
    data = svg_document(
        '<rect id="cut" x="96" y="96" width="192" height="192" fill="none" stroke="#000" stroke-width=".096"/>'
        '<path id="score-line" d="M120 150H260" fill="none" stroke="#0000ff" stroke-width=".096"/>'
    )
    report = analyze_svg(
        data=data,
        filename="score.svg",
        profile=profile,
        assignment=assignment,
        material=profile.materials[0],
        thickness_mm=3,
    ).model_dump(by_alias=True)
    assert check(report, "vectors.process_setup")["state"] == "pass"
    assert check(report, "geometry.closed_cuts")["state"] == "pass"
    assert report["metrics"]["approved_vector_path_count"] == 2
    assert report["metrics"]["cut_path_count"] == 1
    assert report["geometry"]["valid_3d"] is True


def test_profile_severity_override_can_promote_material_warning():
    profile = load_profile()
    assignment = profile.assignments[0].model_copy(
        update={"severity_overrides": {"material.fragility": "blocker"}}
    )
    report = analyze_svg(
        data=svg_document(
            '<rect id="tiny" x="96" y="96" width="5" height="5" '
            'fill="none" stroke="#000" stroke-width=".096"/>'
        ),
        filename="tiny.svg",
        profile=profile,
        assignment=assignment,
        material=profile.materials[0],
        thickness_mm=3,
    ).model_dump(by_alias=True)
    finding = check(report, "material.fragility")
    assert finding["state"] == "blocker"
    assert any("severity override" in item.lower() for item in finding["evidence"])


def test_production_profile_allows_known_good_file_to_be_ready(good_svg):
    profile = load_profile()
    production = profile.model_copy(
        update={"profile": profile.profile.model_copy(update={"demo": False})}
    )
    report = analyze_svg(
        data=good_svg,
        filename="known-good.svg",
        profile=production,
        assignment=production.assignments[0],
        material=production.materials[0],
        thickness_mm=3,
    )
    assert report.summary.status == "ready"
    assert report.summary.counts.blocker == 0


def test_curves_are_adaptively_flattened_beyond_legacy_segment_cap(client):
    data = svg_document(
        '<path id="curved" d="M96 300 C96 80 520 80 520 300 C520 520 96 520 96 300 Z" '
        'fill="none" stroke="#000" stroke-width=".096"/>'
    )
    report = post_svg(client, data).json()
    path = next(item for item in report["geometry"]["paths"] if item["id"] == "curved")
    assert len(path["points"]) > 64
    assert check(report, "geometry.topology")["state"] == "pass"


def test_live_text_has_a_sanitized_highlightable_bounds_placeholder(client):
    data = svg_document(
        '<rect id="cut" x="96" y="96" width="192" height="192" '
        'fill="none" stroke="#000" stroke-width=".096"/>'
        '<text id="label" x="120" y="160" font-family="Missing Font" font-size="24">Student</text>'
    )
    report = post_svg(client, data).json()
    placeholder = next(item for item in report["geometry"]["paths"] if item["id"] == "label")
    assert placeholder["operation"] == "engrave-text"
    assert placeholder["bounds"]["width_mm"] > 0
    font_check = check(report, "assets.fonts")
    assert font_check["state"] == "blocker"
    assert font_check["bounds"]


def test_valid_data_embedded_font_allows_live_text(client):
    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder([".notdef", "H"])
    builder.setupCharacterMap({ord("H"): "H"})
    empty_pen = TTGlyphPen(None)
    h_pen = TTGlyphPen(None)
    h_pen.moveTo((100, 0))
    h_pen.lineTo((250, 0))
    h_pen.lineTo((250, 700))
    h_pen.lineTo((100, 700))
    h_pen.closePath()
    builder.setupGlyf({".notdef": empty_pen.glyph(), "H": h_pen.glyph()})
    builder.setupHorizontalMetrics({".notdef": (600, 0), "H": (600, 100)})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": "Embedded Test", "styleName": "Regular"})
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    builder.setupMaxp()
    font_bytes = io.BytesIO()
    builder.font.save(font_bytes)
    encoded = base64.b64encode(font_bytes.getvalue()).decode("ascii")
    data = svg_document(
        '<style>@font-face{font-family:"Embedded Test";src:url(data:font/ttf;base64,'
        + encoded
        + ') format("truetype")}</style>'
        '<rect id="cut" x="96" y="96" width="192" height="192" '
        'fill="none" stroke="#000" stroke-width=".096"/>'
        '<text id="embedded-label" x="120" y="160" font-family="Embedded Test">H</text>'
    )
    report = post_svg(client, data).json()
    assert check(report, "assets.fonts")["state"] == "pass"
    assert any(item["id"] == "embedded-label" for item in report["geometry"]["paths"])
