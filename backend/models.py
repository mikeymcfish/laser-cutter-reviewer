"""Pydantic models shared by the profile loader and API responses."""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


SeverityState = Literal["blocker", "warning", "info", "unverified"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProfileIdentity(StrictModel):
    id: str
    name: str
    version: str
    demo: bool = True


class MachineProfile(StrictModel):
    label: str
    bed_width_mm: float = Field(gt=0)
    bed_height_mm: float = Field(gt=0)
    margin_mm: float = Field(ge=0)
    vector_hairline_threshold_mm: float = Field(gt=0)

    @model_validator(mode="after")
    def validate_usable_bed(self) -> "MachineProfile":
        if self.margin_mm * 2 >= self.bed_width_mm or self.margin_mm * 2 >= self.bed_height_mm:
            raise ValueError("machine margins must leave a positive usable bed")
        return self

    @property
    def usable_width_mm(self) -> float:
        return max(0.0, self.bed_width_mm - 2 * self.margin_mm)

    @property
    def usable_height_mm(self) -> float:
        return max(0.0, self.bed_height_mm - 2 * self.margin_mm)


class LimitsProfile(StrictModel):
    max_upload_bytes: int = Field(gt=0)
    max_elements: int = Field(gt=0)
    max_path_segments: int = Field(gt=0)
    max_xml_depth: int = Field(gt=0)
    max_preview_points: int = Field(gt=0)
    analysis_timeout_seconds: float = Field(gt=0)


class ProcessProfile(StrictModel):
    id: str
    name: str
    color: str
    stroke_width_mm: float = Field(gt=0)
    stroke_tolerance_mm: float = Field(ge=0)
    require_closed: bool = True

    @field_validator("color")
    @classmethod
    def normalize_color(cls, value: str) -> str:
        value = value.strip().lower()
        if len(value) != 7 or not value.startswith("#"):
            raise ValueError("process colors must use #rrggbb")
        int(value[1:], 16)
        return value


class AssignmentProfile(StrictModel):
    id: str
    name: str
    description: str
    page_policy: Literal["exact", "fit_bed"]
    expected_width_mm: float | None = Field(default=None, gt=0)
    expected_height_mm: float | None = Field(default=None, gt=0)
    page_tolerance_mm: float = Field(default=0.25, ge=0)
    image_policy: Literal["allow", "warning", "blocker"] = "warning"
    min_raster_dpi: float = Field(default=300.0, gt=0)
    severity_overrides: dict[str, SeverityState] = Field(default_factory=dict)
    processes: list[ProcessProfile]

    @model_validator(mode="after")
    def validate_page_policy(self) -> "AssignmentProfile":
        if self.page_policy == "exact" and (
            self.expected_width_mm is None or self.expected_height_mm is None
        ):
            raise ValueError("exact page assignments need expected width and height")
        process_ids = [process.id for process in self.processes]
        if len(process_ids) != len(set(process_ids)):
            raise ValueError("process IDs must be unique within an assignment")
        return self

    @field_validator("processes")
    @classmethod
    def require_process(cls, value: list[ProcessProfile]) -> list[ProcessProfile]:
        if not value:
            raise ValueError("an assignment needs at least one process")
        return value


class PreviewMaterial(StrictModel):
    color: str
    opacity: float = Field(ge=0, le=1)
    roughness: float = Field(ge=0, le=1)

    @field_validator("color")
    @classmethod
    def validate_color(cls, value: str) -> str:
        value = value.strip().lower()
        if not re.fullmatch(r"#[0-9a-f]{6}", value):
            raise ValueError("preview color must use #rrggbb")
        return value


class MaterialProfile(StrictModel):
    id: str
    name: str
    family: Literal["wood", "acrylic"]
    approved: bool
    thicknesses_mm: list[float]
    kerf_mm: float = Field(ge=0)
    min_bridge_mm: float = Field(gt=0)
    min_spacing_mm: float = Field(gt=0)
    min_piece_area_mm2: float = Field(gt=0)
    heat_density_threshold_mm_per_mm2: float = Field(default=0.25, gt=0)
    severity_overrides: dict[str, SeverityState] = Field(default_factory=dict)
    preview: PreviewMaterial

    @field_validator("thicknesses_mm")
    @classmethod
    def validate_thicknesses(cls, value: list[float]) -> list[float]:
        if not value or any(item <= 0 for item in value):
            raise ValueError("materials need positive thickness choices")
        return value


class LabProfile(StrictModel):
    profile: ProfileIdentity
    machine: MachineProfile
    limits: LimitsProfile
    assignments: list[AssignmentProfile]
    materials: list[MaterialProfile]
    operator_checklist: list[str]

    @model_validator(mode="after")
    def validate_core_profile(self) -> "LabProfile":
        if not self.assignments:
            raise ValueError("profile needs at least one assignment")
        if not self.materials:
            raise ValueError("profile needs at least one material")
        if not any(material.approved for material in self.materials):
            raise ValueError("profile needs at least one approved material")
        if not self.operator_checklist or any(not item.strip() for item in self.operator_checklist):
            raise ValueError("operator checklist must contain nonempty items")
        assignment_ids = [item.id for item in self.assignments]
        material_ids = [item.id for item in self.materials]
        if len(assignment_ids) != len(set(assignment_ids)):
            raise ValueError("assignment IDs must be unique")
        if len(material_ids) != len(set(material_ids)):
            raise ValueError("material IDs must be unique")
        for assignment in self.assignments:
            if assignment.page_policy != "exact":
                continue
            if (
                (assignment.expected_width_mm or 0) > self.machine.usable_width_mm + assignment.page_tolerance_mm
                or (assignment.expected_height_mm or 0) > self.machine.usable_height_mm + assignment.page_tolerance_mm
            ):
                raise ValueError(f"assignment {assignment.id!r} is larger than the usable machine bed")
        return self


CheckState = Literal["pass", "blocker", "warning", "info", "unverified"]


class Bounds(StrictModel):
    x_mm: float
    y_mm: float
    width_mm: float = Field(ge=0)
    height_mm: float = Field(ge=0)


class CheckResult(StrictModel):
    rule_id: str
    title: str
    state: CheckState
    message: str
    evidence: list[str] = Field(default_factory=list)
    fix: str | None = None
    object_ids: list[str] = Field(default_factory=list)
    bounds: list[Bounds] = Field(default_factory=list)


class FileInfo(StrictModel):
    name: str
    size_bytes: int = Field(ge=0)
    sha256: str


class ProfileReference(StrictModel):
    id: str
    name: str
    version: str
    demo: bool


class Selection(StrictModel):
    assignment_id: str
    material_id: str
    thickness_mm: float = Field(gt=0)


class SummaryCounts(StrictModel):
    blocker: int = 0
    warning: int = 0
    pass_: int = Field(default=0, alias="pass", serialization_alias="pass")
    info: int = 0
    unverified: int = 0


class ReportSummary(StrictModel):
    status: Literal["ready", "not_ready", "review"]
    label: str
    counts: SummaryCounts


class DocumentInfo(StrictModel):
    width_mm: float | None = None
    height_mm: float | None = None
    units: str
    unit_confidence: Literal["explicit", "inferred", "unresolved"]


class PreviewPath(StrictModel):
    id: str
    operation: str
    closed: bool
    stroke: str | None = None
    stroke_width_mm: float | None = None
    points: list[list[float]]
    bounds: Bounds | None = None


class PreviewPiece(StrictModel):
    id: str
    outer: list[list[float]]
    holes: list[list[list[float]]] = Field(default_factory=list)
    area_mm2: float = Field(ge=0)
    bounds: Bounds


class PreviewGeometry(StrictModel):
    page: dict[str, float | None]
    paths: list[PreviewPath]
    pieces: list[PreviewPiece]
    valid_3d: bool
    invalid_reason: str | None = None


class AnalysisReport(StrictModel):
    report_version: str = "1.0"
    analyzed_at: str
    file: FileInfo
    profile: ProfileReference
    selection: Selection
    summary: ReportSummary
    document: DocumentInfo
    metrics: dict[str, Any]
    checks: list[CheckResult]
    geometry: PreviewGeometry
