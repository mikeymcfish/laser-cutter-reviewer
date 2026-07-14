from __future__ import annotations

from .conftest import check, expected_hash, post_svg


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
    assert report["report_version"] == "1.0"
    assert report["file"]["sha256"] == expected_hash(good_svg)
    assert report["file"]["name"] == "student.svg"
    assert report["document"]["width_mm"] == 304.8
    assert report["document"]["height_mm"] == 203.2
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


def test_external_resource_and_doctype_never_reach_parser(client):
    external = post_svg(
        client,
        b'<svg xmlns="http://www.w3.org/2000/svg" width="12in" height="8in"><image href="https://example.test/a.png"/></svg>',
    )
    assert external.status_code == 200
    assert check(external.json(), "file.security")["state"] == "blocker"

    entity = post_svg(
        client,
        b'<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    )
    assert entity.status_code == 200
    assert check(entity.json(), "file.security")["state"] == "blocker"
