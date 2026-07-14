from __future__ import annotations

import pytest

from backend import svg_analyzer as analyzer_module

from .conftest import check, expected_hash, post_svg
from .conftest import svg_document


def test_health_and_profile(client):
    health = client.get("/healthz")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"

    response = client.get("/api/v1/profile")
    assert response.status_code == 200
    payload = response.json()
    assert payload["profile"]["demo"] is True
    assert {item["id"] for item in payload["assignments"]} >= {"intro-svg", "vector-trace"}
    assert {item["id"] for item in payload["materials"]} >= {"birch-plywood", "cast-acrylic"}
    assert payload["operator_checklist"]
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "frame-ancestors 'self' https://huggingface.co https://*.huggingface.co" in response.headers["content-security-policy"]


def test_known_good_svg_returns_normalized_report(client, good_svg):
    response = post_svg(client, good_svg)
    assert response.status_code == 200, response.text
    report = response.json()
    assert report["report_version"] == "1.2"
    assert report["file"]["sha256"] == expected_hash(good_svg)
    assert report["file"]["name"] == "student.svg"
    assert report["document"]["width_mm"] == 304.8
    assert report["document"]["height_mm"] == 304.8
    assert check(report, "document.page_size")["state"] == "pass"
    assert check(report, "vectors.process_setup")["state"] == "pass"
    assert check(report, "geometry.closed_cuts")["state"] == "pass"
    assert report["geometry"]["valid_3d"] is True
    assert report["geometry"]["pieces"]
    assert report["summary"]["status"] == "review"  # demo profiles cannot approve work
    assert "<svg" not in response.text.lower()


def test_selection_and_upload_validation(client, good_svg):
    bad_assignment = client.post(
        "/api/v1/analyze",
        files={"file": ("a.svg", good_svg, "image/svg+xml")},
        data={"assignment_id": "missing", "material_id": "birch-plywood", "thickness_mm": "3"},
    )
    assert bad_assignment.status_code == 422

    bad_thickness = client.post(
        "/api/v1/analyze",
        files={"file": ("a.svg", good_svg, "image/svg+xml")},
        data={"assignment_id": "intro-svg", "material_id": "birch-plywood", "thickness_mm": "4"},
    )
    assert bad_thickness.status_code == 422

    bad_extension = post_svg(client, good_svg, name="student.pdf")
    assert bad_extension.status_code == 415


def test_fix_strokes_returns_verified_copy_and_preserves_original(client):
    data = svg_document(
        '<style>.wrong-size{fill:none;stroke:#000000;stroke-width:.48}</style>'
        '<g transform="translate(40 20) scale(2)">'
        '<rect id="wrong-size" class="wrong-size" x="48" y="48" width="96" height="96"/>'
        '</g>'
        '<rect id="wrong-color" x="500" y="96" width="192" height="192" '
        'fill="none" stroke="#ff0000" stroke-width=".096"/>'
        '<path id="intentional-thick" d="M500 350H700" fill="none" stroke="#000" stroke-width="2px"/>'
    )
    original = bytes(data)
    analyzed = post_svg(client, data).json()
    process = check(analyzed, "vectors.process_setup")
    assert process["state"] == "blocker"
    action = process["fix_actions"][0]
    assert action["id"] == "normalize-cut-strokes"
    assert action["count"] == 2
    assert set(action["object_ids"]) == {"wrong-size", "wrong-color"}

    response = client.post(
        "/api/v1/fix-strokes",
        files={"file": ("student.svg", data, "image/svg+xml")},
        data={"assignment_id": "intro-svg", "expected_sha256": expected_hash(data)},
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("image/svg+xml")
    assert response.headers["x-original-sha256"] == expected_hash(data)
    assert response.headers["x-corrected-stroke-count"] == "2"
    assert "student-cut-strokes-fixed.svg" in response.headers["content-disposition"]
    assert data == original
    assert response.content != data
    assert b"0.001in" in response.content
    assert b"non-scaling-stroke" in response.content

    reanalyzed = post_svg(client, response.content, name="student-fixed.svg").json()
    assert check(reanalyzed, "vectors.process_setup")["state"] == "pass"
    for object_id in ("wrong-size", "wrong-color"):
        path = next(item for item in reanalyzed["geometry"]["paths"] if item["id"] == object_id)
        assert path["stroke"] == "#000000"
        assert path["stroke_width_mm"] == 0.0254
    thick = next(item for item in reanalyzed["geometry"]["paths"] if item["id"] == "intentional-thick")
    assert thick["operation"] == "engrave"
    assert thick["stroke_width_mm"] == 0.52917


def test_fix_strokes_rejects_a_stale_fingerprint(client, good_svg):
    response = client.post(
        "/api/v1/fix-strokes",
        files={"file": ("student.svg", good_svg, "image/svg+xml")},
        data={"assignment_id": "intro-svg", "expected_sha256": "0" * 64},
    )
    assert response.status_code == 409
    assert "analyze" in response.json()["detail"].lower()


def test_important_css_is_reported_and_never_auto_fixed(client):
    data = svg_document(
        '<style>.bad{fill:none;stroke:#ff0000 !/**/ important;stroke-width:.096}</style>'
        '<rect id="important-cut" class="bad" x="96" y="96" width="192" height="192"/>'
    )
    report = post_svg(client, data).json()
    assert check(report, "geometry.effects")["state"] == "blocker"
    assert any("important" in item.lower() for item in check(report, "geometry.effects")["evidence"])
    assert check(report, "vectors.process_setup")["fix_actions"] == []

    fixed = client.post(
        "/api/v1/fix-strokes",
        files={"file": ("important.svg", data, "image/svg+xml")},
        data={"assignment_id": "intro-svg", "expected_sha256": expected_hash(data)},
    )
    assert fixed.status_code == 422
    assert "css" in fixed.json()["detail"].lower()


def test_shared_use_target_is_never_auto_fixed_across_different_instances(client):
    data = svg_document(
        '<rect id="shared" x="96" y="96" width="96" height="96" fill="none" stroke="#ff0000" stroke-width=".096"/>'
        '<use id="wrong-use" href="#shared" x="150" y="150"/>'
        '<use id="engrave-use" href="#shared" x="300" y="96" fill="#cccccc" stroke="#000000" stroke-width="2px"/>'
    )
    report = post_svg(client, data).json()
    process = check(report, "vectors.process_setup")
    assert process["state"] == "blocker"
    assert any(item in process["object_ids"] for item in ("shared", "wrong-use"))
    assert process["fix_actions"] == []

    fixed = client.post(
        "/api/v1/fix-strokes",
        files={"file": ("uses.svg", data, "image/svg+xml")},
        data={"assignment_id": "intro-svg", "expected_sha256": expected_hash(data)},
    )
    assert fixed.status_code == 422
    assert "use" in fixed.json()["detail"].lower()


def test_default_assignment_requires_twelve_inch_square(client, good_svg):
    accepted = post_svg(client, good_svg).json()
    assert check(accepted, "document.page_size")["state"] == "pass"

    old_page = good_svg.replace(b'height="12in"', b'height="8in"').replace(
        b'viewBox="0 0 1152 1152"', b'viewBox="0 0 1152 768"'
    )
    rejected = post_svg(client, old_page).json()
    assert check(rejected, "document.page_size")["state"] == "blocker"


def test_fix_artboard_preserves_physical_geometry_and_viewbox_origin(client):
    data = svg_document(
        '<rect id="part" x="133" y="149" width="288" height="192" '
        'fill="none" stroke="#000" stroke-width=".096"/>',
        width="12in",
        height="8in",
        viewbox="37 53 1152 768",
    )
    original = bytes(data)
    analyzed = post_svg(client, data).json()
    page = check(analyzed, "document.page_size")
    assert page["state"] == "blocker"
    assert page["fix_actions"] == [
        {
            "id": "set-artboard",
            "kind": "set_artboard",
            "label": "Set artboard to 12.0000 in x 12.0000 in",
            "description": (
                "Creates a separate SVG copy with the assignment artboard size while preserving "
                "the artwork's physical scale and coordinates. The original file is unchanged."
            ),
            "endpoint": "/api/v1/fix-artboard",
            "object_ids": [],
            "count": 1,
            "target_color": None,
            "target_stroke_width_in": None,
            "target_width_in": 12.0,
            "target_height_in": 12.0,
        }
    ]
    before_path = next(path for path in analyzed["geometry"]["paths"] if path["id"] == "part")

    response = client.post(
        "/api/v1/fix-artboard",
        files={"file": ("student.svg", data, "image/svg+xml")},
        data={"assignment_id": "intro-svg", "expected_sha256": expected_hash(data)},
    )
    assert response.status_code == 200, response.text
    assert response.headers["x-original-sha256"] == expected_hash(data)
    assert response.headers["x-artboard-width-in"] == "12"
    assert response.headers["x-artboard-height-in"] == "12"
    assert "student-artboard-fixed.svg" in response.headers["content-disposition"]
    assert data == original
    assert response.content != data
    assert b'width="12in"' in response.content
    assert b'height="12in"' in response.content
    assert b'viewBox="37 53 1152 1152"' in response.content
    assert b'style="width:12in;height:12in"' in response.content

    reanalyzed = post_svg(client, response.content, name="student-artboard-fixed.svg").json()
    assert check(reanalyzed, "document.page_size")["state"] == "pass"
    assert check(reanalyzed, "document.page_size")["fix_actions"] == []
    after_path = next(path for path in reanalyzed["geometry"]["paths"] if path["id"] == "part")
    assert after_path["points"] == before_path["points"]
    assert after_path["bounds"] == before_path["bounds"]
    assert after_path["stroke_width_mm"] == before_path["stroke_width_mm"]


def test_fix_artboard_rejects_stale_fingerprint(client):
    data = svg_document(
        '<rect id="part" x="96" y="96" width="192" height="192" '
        'fill="none" stroke="#000" stroke-width=".096"/>',
        height="8in",
        viewbox="0 0 1152 768",
    )
    response = client.post(
        "/api/v1/fix-artboard",
        files={"file": ("student.svg", data, "image/svg+xml")},
        data={"assignment_id": "intro-svg", "expected_sha256": "0" * 64},
    )
    assert response.status_code == 409
    assert "analyze" in response.json()["detail"].lower()


def test_artboard_fix_is_withheld_without_reliable_viewbox(client):
    data = (
        b'<svg xmlns="http://www.w3.org/2000/svg" width="12in" height="8in">'
        b'<rect id="part" x="96" y="96" width="192" height="192" '
        b'fill="none" stroke="#000" stroke-width=".096"/></svg>'
    )
    report = post_svg(client, data).json()
    assert check(report, "document.page_size")["state"] == "blocker"
    assert check(report, "document.page_size")["fix_actions"] == []

    response = client.post(
        "/api/v1/fix-artboard",
        files={"file": ("student.svg", data, "image/svg+xml")},
        data={"assignment_id": "intro-svg", "expected_sha256": expected_hash(data)},
    )
    assert response.status_code == 422
    assert "viewbox" in response.json()["detail"].lower()


def test_artboard_fix_is_withheld_for_external_or_active_resources(client):
    external = svg_document(
        '<image id="linked" x="96" y="96" width="96" height="96" href="file:///student/photo.png"/>'
        '<rect id="part" x="300" y="96" width="192" height="192" '
        'fill="none" stroke="#000" stroke-width=".096"/>',
        height="8in",
        viewbox="0 0 1152 768",
    )
    report = post_svg(client, external).json()
    assert check(report, "document.page_size")["fix_actions"] == []
    response = client.post(
        "/api/v1/fix-artboard",
        files={"file": ("student.svg", external, "image/svg+xml")},
        data={"assignment_id": "intro-svg", "expected_sha256": expected_hash(external)},
    )
    assert response.status_code == 422
    assert "embed" in response.json()["detail"].lower()

    active = (
        b'<svg xmlns="http://www.w3.org/2000/svg" width="12in" height="8in" '
        b'viewBox="0 0 1152 768"><script>alert(1)</script></svg>'
    )
    active_response = client.post(
        "/api/v1/fix-artboard",
        files={"file": ("student.svg", active, "image/svg+xml")},
        data={"assignment_id": "intro-svg", "expected_sha256": expected_hash(active)},
    )
    assert active_response.status_code == 422
    assert "script" in active_response.json()["detail"].lower()


def test_malformed_and_active_svg_are_structured_blockers(client):
    malformed = post_svg(client, b"<svg><path></svg>")
    assert malformed.status_code == 200
    assert malformed.json()["summary"]["counts"]["blocker"] == 1
    assert malformed.json()["geometry"]["paths"] == []

    scripted = post_svg(client, b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    assert scripted.status_code == 200
    report = scripted.json()
    assert check(report, "file.security")["state"] == "blocker"
    assert "script" in check(report, "file.security")["message"].lower()

    animated = post_svg(
        client,
        b'<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"><animate attributeName="x" values="0;10"/></rect></svg>',
    )
    assert animated.status_code == 200
    assert check(animated.json(), "file.security")["state"] == "blocker"


def test_linked_image_gets_specific_embedding_blocker_and_doctype_is_rejected(client, monkeypatch):
    def forbidden_fetch(*_args, **_kwargs):
        raise AssertionError("linked image fetch was attempted")

    monkeypatch.setattr("urllib.request.urlopen", forbidden_fetch)
    external = post_svg(
        client,
        b'<svg xmlns="http://www.w3.org/2000/svg" width="12in" height="12in" viewBox="0 0 1152 1152">'
        b'<image id="linked-photo" x="96" y="96" width="96" height="96" href="https://example.test/a.png"/>'
        b'<rect id="wrong-cut" x="300" y="96" width="96" height="96" fill="none" stroke="#ff0000" stroke-width=".096"/>'
        b'</svg>',
    )
    assert external.status_code == 200
    finding = check(external.json(), "assets.images_embedded")
    assert finding["state"] == "blocker"
    assert "pointer" in finding["message"].lower()
    assert "example.test" not in external.text
    assert external.json()["geometry"]["raster_assets"] == []
    assert check(external.json(), "vectors.process_setup")["fix_actions"] == []

    entity = post_svg(
        client,
        b'<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    )
    assert entity.status_code == 200
    assert check(entity.json(), "file.security")["state"] == "blocker"


@pytest.mark.parametrize(
    "extra_reference",
    [
        'src="https://private.example/reference.png"',
        'xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="file:///student/reference.png"',
    ],
)
def test_any_external_image_attribute_blocks_even_with_an_embedded_href(client, extra_reference):
    png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    data = svg_document(
        f'<image id="mixed-reference" x="96" y="96" width="96" height="96" '
        f'href="data:image/png;base64,{png}" {extra_reference}/>'
        '<rect id="wrong-cut" x="300" y="96" width="96" height="96" fill="none" stroke="#ff0000" stroke-width=".096"/>'
    )
    response = post_svg(client, data)
    report = response.json()
    assert check(report, "assets.images_embedded")["state"] == "blocker"
    assert check(report, "vectors.process_setup")["fix_actions"] == []
    assert report["geometry"]["raster_assets"] == []
    assert "private.example" not in response.text
    assert "file:///" not in response.text


def test_identical_embedded_href_and_xlink_href_are_accepted(client):
    png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    uri = f"data:image/png;base64,{png}"
    data = svg_document(
        f'<image id="dual-reference" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'x="96" y="96" width="96" height="96" href="{uri}" xlink:href="{uri}"/>'
        '<rect id="cut" x="300" y="96" width="96" height="96" fill="none" stroke="#000" stroke-width=".096"/>'
    )
    report = post_svg(client, data).json()
    assert check(report, "assets.images_embedded")["state"] == "pass"
    assert len(report["geometry"]["raster_assets"]) == 1


def test_conflicting_embedded_image_references_block_preview_and_fix(client):
    png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    data = svg_document(
        f'<image id="conflicting-reference" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'x="96" y="96" width="96" height="96" href="data:image/png;base64,{png}" '
        'xlink:href="data:image/svg+xml;base64,PHN2Zy8+"/>'
        '<rect id="wrong-cut" x="300" y="96" width="96" height="96" fill="none" stroke="#ff0000" stroke-width=".096"/>'
    )
    report = post_svg(client, data).json()
    assert check(report, "assets.images_embedded")["state"] == "blocker"
    assert check(report, "vectors.process_setup")["fix_actions"] == []
    assert report["geometry"]["raster_assets"] == []

    fixed = client.post(
        "/api/v1/fix-strokes",
        files={"file": ("conflict.svg", data, "image/svg+xml")},
        data={"assignment_id": "intro-svg", "expected_sha256": expected_hash(data)},
    )
    assert fixed.status_code == 422


def test_fixer_neutralizes_embedded_payloads_during_both_geometry_passes(client, monkeypatch):
    png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    data = svg_document(
        f'<image id="embedded" x="96" y="96" width="96" height="96" href="data:image/png;base64,{png}"/>'
        '<rect id="wrong-cut" x="300" y="96" width="96" height="96" fill="none" stroke="#ff0000" stroke-width=".096"/>'
    )
    original_extract = analyzer_module._extract_paths
    inspected_xml: list[str] = []

    def guarded_extract(xml_text, *args, **kwargs):
        inspected_xml.append(xml_text)
        assert png not in xml_text
        return original_extract(xml_text, *args, **kwargs)

    monkeypatch.setattr(analyzer_module, "_extract_paths", guarded_extract)
    response = client.post(
        "/api/v1/fix-strokes",
        files={"file": ("embedded.svg", data, "image/svg+xml")},
        data={"assignment_id": "intro-svg", "expected_sha256": expected_hash(data)},
    )
    assert response.status_code == 200, response.text
    assert len(inspected_xml) == 2
    assert png.encode() in response.content
