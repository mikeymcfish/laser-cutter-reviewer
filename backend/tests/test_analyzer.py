from __future__ import annotations

import base64
import io

import pytest
from PIL import Image

from .conftest import check, post_svg, svg_document


@pytest.mark.parametrize("stroke", ["0.001in", "0.072pt", "0.025mm", "0.0254mm", "0.096px"])
def test_equivalent_hairline_units_pass(client, stroke):
    data = svg_document(
        f'<rect id="part" x="96" y="96" width="192" height="192" '
        f'fill="none" stroke="#000000" stroke-width="{stroke}"/>'
    )
    report = post_svg(client, data).json()
    assert check(report, "vectors.process_setup")["state"] == "pass"


def test_inferred_and_unresolved_units(client):
    inferred = svg_document(
        '<rect x="10" y="10" width="100" height="100" fill="none" stroke="#000" stroke-width=".096"/>',
        width="1152",
        height="768",
    )
    inferred_report = post_svg(client, inferred).json()
    assert inferred_report["document"]["unit_confidence"] == "inferred"
    assert check(inferred_report, "document.units")["state"] == "warning"

    unresolved = b'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 10"/></svg>'
    unresolved_report = post_svg(client, unresolved).json()
    assert check(unresolved_report, "document.units")["state"] == "blocker"
    assert unresolved_report["geometry"]["valid_3d"] is False


def test_wrong_process_open_path_and_fill_are_reported(client):
    data = svg_document(
        '<path id="wrong" d="M96 96 L288 96 L288 288" fill="red" '
        'stroke="#ff0000" stroke-width="0.096"/>'
    )
    report = post_svg(client, data).json()
    assert check(report, "vectors.process_setup")["state"] == "blocker"
    assert "wrong" in check(report, "vectors.process_setup")["object_ids"]

    open_cut = svg_document(
        '<path id="open" d="M96 96 L288 96 L288 288" fill="none" '
        'stroke="#000" stroke-width="0.096"/>'
    )
    open_report = post_svg(client, open_cut).json()
    assert check(open_report, "geometry.closed_cuts")["state"] == "blocker"
    assert open_report["geometry"]["valid_3d"] is False

    coincident_but_open = svg_document(
        '<path id="not-joined" d="M96 96H288V288H96L96 96" fill="none" '
        'stroke="#000" stroke-width=".096"/>'
    )
    coincident_report = post_svg(client, coincident_but_open).json()
    assert check(coincident_report, "geometry.closed_cuts")["state"] == "blocker"


def test_cut_fix_width_cap_preserves_intentional_thick_black_engraving(client):
    data = svg_document(
        '<rect id="cut" x="96" y="96" width="192" height="192" fill="none" stroke="#000" stroke-width=".096"/>'
        '<rect id="fixable-010" x="400" y="96" width="96" height="96" fill="none" stroke="#000" stroke-width="0.010in"/>'
        '<path id="engrave-2px" d="M120 350H260" fill="none" stroke="#000" stroke-width="2px"/>'
        '<path id="engrave-2pt" d="M120 390H260" fill="none" stroke="#000" stroke-width="2pt"/>'
        '<path id="filled-engrave" d="M120 430H260" fill="#cccccc" stroke="#000" stroke-width=".2"/>'
    )
    report = post_svg(client, data).json()
    process = check(report, "vectors.process_setup")
    assert process["state"] == "blocker"
    assert "fixable-010" in process["object_ids"]
    assert process["fix_actions"][0]["kind"] == "normalize_cut_strokes"
    assert process["fix_actions"][0]["object_ids"] == ["fixable-010"]
    assert check(report, "vectors.unapproved_hairlines")["state"] == "pass"
    operations = {item["id"]: item["operation"] for item in report["geometry"]["paths"]}
    assert operations["engrave-2px"] == "engrave"
    assert operations["engrave-2pt"] == "engrave"
    assert operations["filled-engrave"] == "engrave"
    assert report["metrics"]["operation_inventory"]["engrave"] == 3


def test_illustrator_css_and_nested_uniform_transform_are_resolved(client):
    data = svg_document(
        '<style>.st0{fill:none;stroke:#000000;stroke-width:.048}</style>'
        '<g transform="translate(20 30)"><g transform="scale(2)">'
        '<rect id="transformed" class="st0" x="48" y="48" width="96" height="96"/>'
        '</g></g>'
    )
    report = post_svg(client, data).json()
    assert check(report, "vectors.process_setup")["state"] == "pass"
    path = next(item for item in report["geometry"]["paths"] if item["id"] == "transformed")
    assert path["bounds"]["width_mm"] == pytest.approx(50.8, abs=0.01)


def test_duplicate_and_self_intersecting_cuts_block(client):
    duplicate = svg_document(
        '<g fill="none" stroke="#000" stroke-width=".096">'
        '<path id="one" d="M96 96H288V288H96Z"/>'
        '<path id="two" d="M96 96H288V288H96Z"/>'
        '</g>'
    )
    report = post_svg(client, duplicate).json()
    assert check(report, "geometry.topology")["state"] == "blocker"
    assert {"one", "two"}.issubset(set(check(report, "geometry.topology")["object_ids"]))

    bowtie = svg_document(
        '<path id="bowtie" d="M96 96L288 288L96 288L288 96Z" fill="none" stroke="#000" stroke-width=".096"/>'
    )
    bowtie_report = post_svg(client, bowtie).json()
    assert check(bowtie_report, "geometry.topology")["state"] == "blocker"


def test_partial_coincident_overlap_blocks_but_point_crossing_warns(client):
    overlap = svg_document(
        '<g fill="none" stroke="#000" stroke-width=".096">'
        '<path id="left" d="M96 96H288V288H96Z"/>'
        '<path id="right" d="M192 96H384V192H192Z"/>'
        '</g>'
    )
    overlap_report = post_svg(client, overlap).json()
    assert check(overlap_report, "geometry.topology")["state"] == "blocker"
    assert {"left", "right"}.issubset(set(check(overlap_report, "geometry.topology")["object_ids"]))

    crossing = svg_document(
        '<g fill="none" stroke="#000" stroke-width=".096">'
        '<rect id="a" x="96" y="96" width="192" height="192"/>'
        '<rect id="b" x="192" y="192" width="192" height="192"/>'
        '</g>'
    )
    crossing_report = post_svg(client, crossing).json()
    assert check(crossing_report, "geometry.topology")["state"] == "pass"
    assert check(crossing_report, "geometry.crossings")["state"] == "warning"


def test_live_text_blocks_and_outlined_text_does_not(client):
    live = svg_document('<text id="label" x="96" y="96" font-family="Arial">Hello</text>')
    report = post_svg(client, live).json()
    assert check(report, "assets.fonts")["state"] == "blocker"
    assert "label" in check(report, "assets.fonts")["object_ids"]

    outlined = svg_document(
        '<path id="letter" d="M96 192L144 96L192 192Z" fill="none" stroke="#000" stroke-width=".096"/>'
    )
    outlined_report = post_svg(client, outlined).json()
    assert check(outlined_report, "assets.fonts")["state"] == "pass"


def test_embedded_raster_is_flagged_by_assignment_policy(client):
    png = base64.b64encode(
        base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
    ).decode()
    body = (
        f'<image id="reference" x="96" y="96" width="96" height="96" '
        f'preserveAspectRatio="xMaxYMin slice" href="data:image/png;base64,{png}"/>'
        '<rect id="part" x="96" y="96" width="192" height="192" fill="none" stroke="#000" stroke-width=".096"/>'
    )
    warning = post_svg(client, svg_document(body), assignment="intro-svg").json()
    assert check(warning, "assets.images_embedded")["state"] == "pass"
    assert check(warning, "assets.raster_presence")["state"] == "warning"
    assert check(warning, "assets.raster_resolution")["state"] == "warning"
    assets = warning["geometry"]["raster_assets"]
    layers = warning["geometry"]["raster_layers"]
    assert len(assets) == 1
    assert len(layers) == 1
    assert layers[0]["asset_id"] == assets[0]["id"]
    assert layers[0]["blend_mode"] == "multiply"
    assert layers[0]["z_index"] == 0
    assert layers[0]["preserve_aspect_ratio"] == "xMaxYMin slice"
    assert len(layers[0]["corners_mm"]) == 4
    assert assets[0]["data_url"].startswith("data:image/png;base64,")
    assert assets[0]["data_url"] != f"data:image/png;base64,{png}"
    assert assets[0]["preview_width_px"] <= 2048
    assert assets[0]["preview_height_px"] <= 2048
    sanitized_bytes = base64.b64decode(assets[0]["data_url"].split(",", 1)[1])
    with Image.open(io.BytesIO(sanitized_bytes)) as preview:
        assert preview.format == "PNG"
        preview.verify()
    cut_path = next(item for item in warning["geometry"]["paths"] if item["id"] == "part")
    assert cut_path["z_index"] == 1

    blocked = post_svg(client, svg_document(body), assignment="vector-trace").json()
    assert check(blocked, "assets.raster_presence")["state"] == "blocker"


def test_supported_png_and_jpeg_mime_types_match_decoded_pixels(client):
    png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    jpeg_bytes = io.BytesIO()
    Image.new("RGB", (2, 2), "white").save(jpeg_bytes, format="JPEG")
    jpeg = base64.b64encode(jpeg_bytes.getvalue()).decode("ascii")
    data = svg_document(
        f'<image id="png" x="96" y="96" width="96" height="96" href="data:image/png;base64,{png}"/>'
        f'<image id="jpeg" x="240" y="96" width="96" height="96" href="data:image/jpeg;base64,{jpeg}"/>'
        '<rect id="cut" x="96" y="300" width="192" height="192" fill="none" stroke="#000" stroke-width=".096"/>'
    )
    report = post_svg(client, data).json()
    assert check(report, "assets.images_embedded")["state"] == "pass"
    assert report["metrics"]["image_count"] == 2
    assert len(report["geometry"]["raster_assets"]) == 2


def test_embedded_raster_mime_mismatches_are_blocked(client):
    png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    jpeg_bytes = io.BytesIO()
    Image.new("RGB", (2, 2), "white").save(jpeg_bytes, format="JPEG")
    jpeg = base64.b64encode(jpeg_bytes.getvalue()).decode("ascii")
    cases = [
        ("image/svg+xml", png),
        ("text/plain", png),
        ("image/jpeg", png),
        ("image/png", jpeg),
    ]
    for index, (declared_type, payload) in enumerate(cases):
        data = svg_document(
            f'<image id="mismatch-{index}" x="96" y="96" width="96" height="96" '
            f'href="data:{declared_type};base64,{payload}"/>'
            '<rect id="wrong-cut" x="300" y="96" width="96" height="96" fill="none" stroke="#ff0000" stroke-width=".096"/>'
        )
        report = post_svg(client, data).json()
        assert check(report, "assets.images_embedded")["state"] == "blocker"
        assert check(report, "vectors.process_setup")["fix_actions"] == []
        assert report["geometry"]["raster_assets"] == []


def test_tiny_piece_triggers_material_fragility_warning(client):
    data = svg_document(
        '<rect id="tiny" x="96" y="96" width="5" height="5" fill="none" stroke="#000" stroke-width=".096"/>'
    )
    report = post_svg(client, data).json()
    fragility = check(report, "material.fragility")
    assert fragility["state"] == "warning"
    assert "tiny" in fragility["object_ids"]


def test_out_of_bounds_effects_and_dashed_cuts(client):
    data = svg_document(
        '<path id="outside" d="M1100 700H1200V760H1100Z" fill="none" stroke="#000" stroke-width=".096"/>'
        '<path id="effect" d="M96 96H288V288H96Z" fill="none" stroke="#000" stroke-width=".096" filter="url(#f)"/>'
        '<path id="dash" d="M400 96H500V196H400Z" fill="none" stroke="#000" stroke-width=".096" stroke-dasharray="2 2"/>'
    )
    report = post_svg(client, data).json()
    assert check(report, "document.artwork_bounds")["state"] == "blocker"
    assert check(report, "geometry.effects")["state"] == "blocker"
    assert check(report, "vectors.process_setup")["state"] == "blocker"
