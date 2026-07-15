from __future__ import annotations

import base64
import io
from xml.etree import ElementTree as ET

import pytest
from PIL import Image

from backend import svg_analyzer

from .conftest import check, expected_hash, post_svg, svg_document


def test_zero_width_stroke_is_never_offered_or_applied_as_a_cut_fix(client):
    data = svg_document(
        '<rect id="invisible" x="96" y="96" width="192" height="192" '
        'fill="none" stroke="#ff0000" stroke-width="0"/>'
    )
    report = post_svg(client, data).json()
    assert check(report, "vectors.process_setup")["fix_actions"] == []

    response = client.post(
        "/api/v1/fix-strokes",
        files={"file": ("zero.svg", data, "image/svg+xml")},
        data={"assignment_id": "intro-svg", "expected_sha256": expected_hash(data)},
    )
    assert response.status_code == 422
    assert "eligible" in response.json()["detail"].lower()


def test_css_specificity_wins_over_later_lower_specificity_rule(client):
    data = svg_document(
        '<style>#cut{fill:none;stroke:#ff0000;stroke-width:.096}.late{stroke:#000000}</style>'
        '<rect id="cut" class="late" x="96" y="96" width="192" height="192"/>'
    )
    report = post_svg(client, data).json()
    path = next(item for item in report["geometry"]["paths"] if item["id"] == "cut")
    assert path["stroke"] == "#ff0000"
    assert path["operation"] == "unassigned-vector"
    assert check(report, "vectors.process_setup")["state"] == "blocker"


def test_root_css_viewport_override_controls_page_size(client):
    data = svg_document(
        '<style>svg{width:13in;height:12in}</style>'
        '<rect id="cut" x="96" y="96" width="192" height="192" '
        'fill="none" stroke="#000" stroke-width=".096"/>'
    )
    report = post_svg(client, data).json()
    assert report["document"]["width_mm"] == pytest.approx(330.2)
    page = check(report, "document.page_size")
    assert page["state"] == "blocker"
    assert page["fix_actions"] == []


@pytest.mark.parametrize("css_width", ["100%", "calc(12in + 1px)", "100vw", "100vh", "10em"])
def test_nonabsolute_root_css_width_never_falls_back_to_viewbox(client, css_width):
    data = svg_document(
        f'<style>svg{{width:{css_width};height:12in}}</style>'
        '<rect id="cut" x="96" y="96" width="192" height="192" '
        'fill="none" stroke="#000" stroke-width=".096"/>'
    )
    report = post_svg(client, data).json()
    assert report["document"]["width_mm"] is None
    assert report["document"]["unit_confidence"] == "unresolved"
    assert check(report, "document.units")["state"] == "blocker"
    assert check(report, "document.page_size")["state"] == "blocker"


@pytest.mark.parametrize("container", ["symbol", "mask", "marker"])
def test_unused_definition_containers_do_not_emit_phantom_cuts(client, container):
    data = svg_document(
        f'<{container} id="unused"><rect id="phantom" x="400" y="96" width="96" height="96" '
        'fill="none" stroke="#ff0000" stroke-width=".096"/>'
        f'</{container}>'
        '<rect id="real" x="96" y="96" width="192" height="192" '
        'fill="none" stroke="#000" stroke-width=".096"/>'
    )
    report = post_svg(client, data).json()
    assert {item["id"] for item in report["geometry"]["paths"]} == {"real"}
    assert check(report, "vectors.process_setup")["state"] == "pass"


def test_symbol_geometry_is_emitted_only_when_instantiated(client):
    data = svg_document(
        '<symbol id="part"><rect id="source" x="96" y="96" width="192" height="192" '
        'fill="none" stroke="#000" stroke-width=".096"/></symbol>'
        '<use id="placed" href="#part"/>'
    )
    report = post_svg(client, data).json()
    cut_paths = [item for item in report["geometry"]["paths"] if item["operation"] == "cut"]
    assert len(cut_paths) == 1
    assert cut_paths[0]["id"].startswith("placed")


def test_visible_marker_reference_is_blocking_even_when_definition_is_suppressed(client):
    data = svg_document(
        '<defs><marker id="arrow"><path id="arrow-shape" d="M0 0L10 5L0 10Z" '
        'fill="#000"/></marker></defs>'
        '<path id="marked" d="M96 96H288V288H96Z" fill="none" stroke="#000" '
        'stroke-width=".096" marker-start="url(#arrow)"/>'
    )
    report = post_svg(client, data).json()
    assert {item["id"] for item in report["geometry"]["paths"]} == {"marked"}
    effects = check(report, "geometry.effects")
    assert effects["state"] == "blocker"
    assert "marked" in effects["object_ids"]
    assert any("marker-start" in item for item in effects["evidence"])
    assert report["geometry"]["valid_3d"] is False


def test_primary_font_must_be_embedded_even_when_fallback_is_embedded():
    root = ET.fromstring(
        '<svg xmlns="http://www.w3.org/2000/svg">'
        '<text id="label" font-family="Arial, Embedded Test">Student</text>'
        '</svg>'
    )
    rules, _ = svg_analyzer._css_rules(root)
    metadata, _, _, _ = svg_analyzer._collect_metadata(root, rules)
    valid, missing = svg_analyzer._live_text_inventory(root, metadata, {"embedded test"})
    assert valid == []
    assert missing == ["label"]


def test_artboard_fix_is_withheld_when_reduction_would_crop_artwork(client):
    data = svg_document(
        '<rect id="near-edge" x="1170" y="96" width="60" height="96" '
        'fill="none" stroke="#000" stroke-width=".096"/>',
        width="13in",
        height="8in",
        viewbox="0 0 1248 768",
    )
    report = post_svg(client, data).json()
    assert check(report, "document.page_size")["state"] == "blocker"
    assert check(report, "document.page_size")["fix_actions"] == []

    response = client.post(
        "/api/v1/fix-artboard",
        files={"file": ("crop.svg", data, "image/svg+xml")},
        data={"assignment_id": "intro-svg", "expected_sha256": expected_hash(data)},
    )
    assert response.status_code == 422
    assert "outside" in response.json()["detail"].lower()


def _png_data_uri(width: int, height: int) -> str:
    output = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def test_raster_opacity_remains_previewable_in_3d(client):
    data = svg_document(
        f'<image id="photo" x="110" y="110" width="120" height="120" opacity=".7" '
        f'href="{_png_data_uri(20, 20)}"/>'
        '<rect id="part" x="96" y="96" width="192" height="192" '
        'fill="none" stroke="#000" stroke-width=".096"/>'
    )
    report = post_svg(client, data).json()
    assert check(report, "geometry.effects")["state"] == "pass"
    assert report["geometry"]["valid_3d"] is True
    assert report["geometry"]["raster_layers"][0]["opacity"] == pytest.approx(0.7)


def test_rotated_meet_image_dpi_uses_edge_lengths_and_letterboxed_size(client):
    data = svg_document(
        f'<image id="photo" x="96" y="96" width="384" height="192" '
        'transform="rotate(90 96 96)" preserveAspectRatio="xMidYMid meet" '
        f'href="{_png_data_uri(100, 100)}"/>'
        '<rect id="part" x="600" y="96" width="192" height="192" '
        'fill="none" stroke="#000" stroke-width=".096"/>'
    )
    report = post_svg(client, data).json()
    inventory = report["metrics"]["image_inventory"]
    assert inventory[0]["effective_dpi"] == pytest.approx(50.0)


def test_sheared_raster_transform_is_blocked_as_unreliable(client):
    data = svg_document(
        f'<image id="photo" x="96" y="96" width="192" height="192" '
        'transform="matrix(1 0 1 .01 0 0)" '
        f'href="{_png_data_uri(100, 100)}"/>'
        '<rect id="part" x="600" y="96" width="192" height="192" '
        'fill="none" stroke="#000" stroke-width=".096"/>'
    )
    report = post_svg(client, data).json()
    effects = check(report, "geometry.effects")
    assert effects["state"] == "blocker"
    assert "photo" in effects["object_ids"]
    assert any("non-orthogonal raster transform" in item for item in effects["evidence"])
    assert report["metrics"]["image_inventory"][0]["effective_dpi"] is None
    assert report["geometry"]["valid_3d"] is False


def test_nested_frame_wall_triggers_localized_weak_point(client):
    data = svg_document(
        '<rect id="outer" x="96" y="96" width="100" height="100" '
        'fill="none" stroke="#000" stroke-width=".096"/>'
        '<rect id="inner" x="100" y="100" width="92" height="92" '
        'fill="none" stroke="#000" stroke-width=".096"/>',
        width="8in",
        height="8in",
        viewbox="0 0 768 768",
    )
    report = post_svg(client, data).json()
    fragility = check(report, "material.fragility")
    assert fragility["state"] == "warning"
    assert {"outer", "inner"}.issubset(fragility["object_ids"])
    weak = [
        point for point in report["geometry"]["weak_points"]["points"]
        if point["kind"] == "narrow_feature" and set(point["object_ids"]) == {"outer", "inner"}
    ]
    assert weak
    assert weak[0]["measurement"] == pytest.approx(4 * 25.4 / 96, abs=0.001)
    assert weak[0]["span_mm"] is not None
