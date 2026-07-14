"""Validated lab-profile loading and public serialization."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from .models import AssignmentProfile, LabProfile, MaterialProfile


DEFAULT_PROFILE_PATH = Path(__file__).resolve().parents[1] / "config" / "lab-profile.yaml"


@lru_cache(maxsize=4)
def load_profile(path: str | None = None) -> LabProfile:
    selected = Path(path or os.getenv("LASER_REVIEWER_PROFILE", DEFAULT_PROFILE_PATH))
    with selected.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    return LabProfile.model_validate(data)


def get_assignment(profile: LabProfile, assignment_id: str) -> AssignmentProfile:
    for assignment in profile.assignments:
        if assignment.id == assignment_id:
            return assignment
    raise KeyError(assignment_id)


def get_material(profile: LabProfile, material_id: str) -> MaterialProfile:
    for material in profile.materials:
        if material.id == material_id:
            return material
    raise KeyError(material_id)


def public_profile(profile: LabProfile) -> dict[str, Any]:
    machine = profile.machine.model_dump()
    machine.update(
        usable_width_mm=profile.machine.usable_width_mm,
        usable_height_mm=profile.machine.usable_height_mm,
    )
    return {
        "profile": profile.profile.model_dump(),
        "machine": machine,
        "assignments": [item.model_dump() for item in profile.assignments],
        "materials": [item.model_dump() for item in profile.materials if item.approved],
        "operator_checklist": profile.operator_checklist,
        "limits": {"max_upload_bytes": profile.limits.max_upload_bytes},
    }
