"""Pydantic models shared by the profile loader and API responses."""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, field_validator, model_validator


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
    max_fixable_cut_stroke_width_mm: float = Field(gt=0)
    max_embedded_image_pixels: int = Field(gt=0)
    max_total_embedded_image_pixels: int = Field(gt=0)
    max_embedded_images: int = Field(gt=0)
    max_raster_preview_dimension_px: int = Field(gt=0)
    max_raster_preview_bytes: int = Field(gt=0)
    max_total_raster_preview_bytes: int = Field(gt=0)
    analysis_timeout_seconds: float = Field(gt=0)


class ProcessProfile(StrictModel):
    id: str
    name: str
    color: str
    stroke_width_mm: float = Field(gt=0)
    stroke_tolerance_mm: float = Field(ge=0)
    stroke_lower_tolerance_mm: float | None = Field(default=None, ge=0)
    require_closed: bool = True

    @model_validator(mode="after")
    def validate_stroke_tolerances(self) -> "ProcessProfile":
        lower_tolerance = (
            self.stroke_tolerance_mm
            if self.stroke_lower_tolerance_mm is None
            else self.stroke_lower_tolerance_mm
        )
        if lower_tolerance >= self.stroke_width_mm:
            raise ValueError("process lower stroke tolerance must leave a positive accepted width")
        return self

    @property
    def effective_lower_tolerance_mm(self) -> float:
        """Use the historical symmetric tolerance when no lower override is configured."""
        return (
            self.stroke_tolerance_mm
            if self.stroke_lower_tolerance_mm is None
            else self.stroke_lower_tolerance_mm
        )

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
    page_policy: Literal["exact", "fit_within", "fit_bed"]
    expected_width_mm: float | None = Field(default=None, gt=0)
    expected_height_mm: float | None = Field(default=None, gt=0)
    page_tolerance_mm: float = Field(default=0.25, ge=0)
    image_policy: Literal["allow", "warning", "blocker"] = "warning"
    min_raster_dpi: float = Field(default=300.0, gt=0)
    severity_overrides: dict[str, SeverityState] = Field(default_factory=dict)
    processes: list[ProcessProfile]

    @model_validator(mode="after")
    def validate_page_policy(self) -> "AssignmentProfile":
        if self.page_policy in {"exact", "fit_within"} and (
            self.expected_width_mm is None or self.expected_height_mm is None
        ):
            raise ValueError("exact and fit-within page assignments need expected width and height")
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
            if assignment.page_policy not in {"exact", "fit_within"}:
                continue
            if (
                (assignment.expected_width_mm or 0) > self.machine.usable_width_mm + assignment.page_tolerance_mm
                or (assignment.expected_height_mm or 0) > self.machine.usable_height_mm + assignment.page_tolerance_mm
            ):
                raise ValueError(f"assignment {assignment.id!r} is larger than the usable machine bed")
        return self


CheckState = Literal["pass", "blocker", "warning", "info", "unverified"]
PreserveAspectRatio = Literal[
    "none",
    "xMinYMin meet", "xMinYMin slice",
    "xMidYMin meet", "xMidYMin slice",
    "xMaxYMin meet", "xMaxYMin slice",
    "xMinYMid meet", "xMinYMid slice",
    "xMidYMid meet", "xMidYMid slice",
    "xMaxYMid meet", "xMaxYMid slice",
    "xMinYMax meet", "xMinYMax slice",
    "xMidYMax meet", "xMidYMax slice",
    "xMaxYMax meet", "xMaxYMax slice",
]


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
    fix_actions: list["FixAction"] = Field(default_factory=list)


class FixAction(StrictModel):
    id: Literal["normalize-cut-strokes", "set-artboard"]
    kind: Literal["normalize_cut_strokes", "set_artboard"]
    label: str
    description: str
    endpoint: Literal["/api/v1/fix-strokes", "/api/v1/fix-artboard"]
    object_ids: list[str] = Field(default_factory=list)
    count: int = Field(gt=0)
    target_color: Literal["#000000"] | None = None
    target_stroke_width_in: Literal[0.001] | None = None
    target_width_in: float | None = Field(default=None, gt=0)
    target_height_in: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def validate_action_contract(self) -> "FixAction":
        if self.kind == "normalize_cut_strokes":
            if self.id != "normalize-cut-strokes" or self.endpoint != "/api/v1/fix-strokes":
                raise ValueError("stroke fix action identifiers do not match")
            if self.target_color != "#000000" or self.target_stroke_width_in != 0.001:
                raise ValueError("stroke fix action needs the configured cut targets")
            if self.target_width_in is not None or self.target_height_in is not None:
                raise ValueError("stroke fix action cannot include artboard targets")
        else:
            if self.id != "set-artboard" or self.endpoint != "/api/v1/fix-artboard":
                raise ValueError("artboard fix action identifiers do not match")
            if self.target_width_in is None or self.target_height_in is None:
                raise ValueError("artboard fix action needs width and height targets")
            if self.target_color is not None or self.target_stroke_width_in is not None:
                raise ValueError("artboard fix action cannot include stroke targets")
        return self


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
    z_index: int = Field(ge=0, strict=True)
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


class PreviewRasterAsset(StrictModel):
    id: str
    data_url: str
    pixel_width: int = Field(gt=0)
    pixel_height: int = Field(gt=0)
    preview_width_px: int = Field(gt=0)
    preview_height_px: int = Field(gt=0)

    @field_validator("data_url")
    @classmethod
    def require_sanitized_png(cls, value: str) -> str:
        if not value.startswith("data:image/png;base64,"):
            raise ValueError("raster preview assets must be server-generated PNG data URLs")
        return value


class PreviewRasterLayer(StrictModel):
    id: str
    asset_id: str
    z_index: int = Field(ge=0, strict=True)
    corners_mm: list[list[float]]
    opacity: float = Field(default=1.0, ge=0, le=1)
    blend_mode: Literal["multiply"] = "multiply"
    preserve_aspect_ratio: PreserveAspectRatio = "xMidYMid meet"
    viewport_aspect_ratio: FiniteFloat = Field(gt=0)

    @field_validator("corners_mm")
    @classmethod
    def require_four_corners(cls, value: list[list[float]]) -> list[list[float]]:
        if len(value) != 4 or any(len(point) != 2 for point in value):
            raise ValueError("raster layers need four transformed corners")
        return value


class PreviewWeakPoint(StrictModel):
    id: str
    kind: Literal["narrow_feature", "close_cut_spacing", "tiny_piece"]
    label: str
    object_ids: list[str] = Field(min_length=1, max_length=2)
    location_mm: tuple[FiniteFloat, FiniteFloat]
    span_mm: tuple[tuple[FiniteFloat, FiniteFloat], tuple[FiniteFloat, FiniteFloat]] | None = None
    measurement: FiniteFloat = Field(ge=0)
    threshold: FiniteFloat = Field(gt=0)
    unit: Literal["mm", "mm2"]

    @model_validator(mode="after")
    def validate_measurement_shape(self) -> "PreviewWeakPoint":
        if self.kind == "tiny_piece":
            if self.unit != "mm2" or self.span_mm is not None:
                raise ValueError("tiny-piece weak points use area measurements without a span")
        elif self.unit != "mm" or self.span_mm is None:
            raise ValueError("linear weak points require a two-point millimeter span")
        if self.kind == "close_cut_spacing" and len(self.object_ids) != 2:
            raise ValueError("close-cut weak points require two affected objects")
        if self.kind != "close_cut_spacing" and len(self.object_ids) != 1:
            raise ValueError("single-object weak points require one affected object")
        return self


class WeakPointPreview(StrictModel):
    status: Literal["complete", "partial", "unavailable"]
    message: str
    points: list[PreviewWeakPoint] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def validate_status(self) -> "WeakPointPreview":
        if self.status == "unavailable" and self.points:
            raise ValueError("an unavailable weak-point scan cannot contain localized points")
        return self


class PreviewGeometry(StrictModel):
    page: dict[str, float | None]
    paths: list[PreviewPath]
    pieces: list[PreviewPiece]
    raster_assets: list[PreviewRasterAsset] = Field(default_factory=list)
    raster_layers: list[PreviewRasterLayer] = Field(default_factory=list)
    weak_points: WeakPointPreview
    valid_3d: bool
    invalid_reason: str | None = None


class AnalysisReport(StrictModel):
    report_version: str = "1.3"
    analyzed_at: str
    file: FileInfo
    profile: ProfileReference
    selection: Selection
    summary: ReportSummary
    document: DocumentInfo
    metrics: dict[str, Any]
    checks: list[CheckResult]
    geometry: PreviewGeometry
