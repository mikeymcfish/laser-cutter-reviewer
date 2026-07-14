from __future__ import annotations

import hashlib

import pytest
from fastapi.testclient import TestClient

from backend.main import app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


def svg_document(body: str, *, width: str = "12in", height: str = "8in", viewbox: str = "0 0 1152 768") -> bytes:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="{viewbox}">{body}</svg>'
    ).encode()


@pytest.fixture()
def good_svg() -> bytes:
    return svg_document(
        '<style>.cut{fill:none;stroke:#000;stroke-width:.096}</style>'
        '<rect id="part" class="cut" x="96" y="96" width="288" height="192"/>'
    )


def post_svg(client: TestClient, data: bytes, *, assignment: str = "intro-svg", name: str = "student.svg"):
    return client.post(
        "/api/v1/analyze",
        files={"file": (name, data, "image/svg+xml")},
        data={
            "assignment_id": assignment,
            "material_id": "birch-plywood",
            "thickness_mm": "3.0",
        },
    )


def check(report: dict, rule_id: str) -> dict:
    return next(item for item in report["checks"] if item["rule_id"] == rule_id)


def expected_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
