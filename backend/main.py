"""FastAPI application for the Laser Cutter Reviewer."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send

from .models import AnalysisReport
from .profile import get_assignment, get_material, load_profile, public_profile
from .svg_analyzer import SVGAnalysisError, analyze_svg, failure_report, fix_artboard, fix_strokes


logger = logging.getLogger("laser_reviewer")


class AggregateRequestLimitMiddleware:
    """Reject oversized multipart bodies before Starlette parses form fields."""

    def __init__(self, app: ASGIApp, max_bytes: int, max_concurrent_bodies: int = 2) -> None:
        self.app = app
        self.max_bytes = max_bytes
        self.body_slots = asyncio.Semaphore(max(1, max_concurrent_bodies))

    async def _reject(self, send: Send, status: int = 413, detail: str = "Request body exceeds the upload limit") -> None:
        body = ('{"detail":"' + detail + '"}').encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                    (b"cache-control", b"no-store"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not (
            scope["type"] == "http"
            and scope.get("method") == "POST"
            and scope.get("path") in {
                "/api/v1/analyze", "/api/v1/fix-strokes", "/api/v1/fix-artboard"
            }
        ):
            await self.app(scope, receive, send)
            return
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        declared = headers.get(b"content-length")
        if declared:
            try:
                if int(declared) > self.max_bytes:
                    await self._reject(send)
                    return
            except ValueError:
                await self._reject(send)
                return

        try:
            await asyncio.wait_for(self.body_slots.acquire(), timeout=2.0)
        except asyncio.TimeoutError:
            await self._reject(
                send,
                status=503,
                detail="Upload analyzer is busy; try again shortly",
            )
            return

        total = 0
        response_started = False

        class RequestTooLarge(Exception):
            pass

        async def limited_receive() -> dict:
            nonlocal total
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > self.max_bytes:
                    raise RequestTooLarge
            return message

        async def tracked_send(message: dict) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            try:
                await self.app(scope, limited_receive, tracked_send)
            except RequestTooLarge:
                if response_started:
                    raise
                await self._reject(send)
        finally:
            self.body_slots.release()


app = FastAPI(
    title="Laser Cutter Reviewer API",
    version="1.2.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

_request_limit = load_profile().limits.max_upload_bytes + 1024 * 1024
app.add_middleware(AggregateRequestLimitMiddleware, max_bytes=_request_limit)

try:
    _analysis_concurrency = max(1, min(8, int(os.getenv("LASER_REVIEWER_ANALYSIS_CONCURRENCY", "2"))))
except ValueError:
    _analysis_concurrency = 2
ANALYSIS_SEMAPHORE = asyncio.Semaphore(_analysis_concurrency)


def _release_analysis_permit(task: asyncio.Task) -> None:
    try:
        task.exception()
    except BaseException:
        pass
    ANALYSIS_SEMAPHORE.release()


async def _read_svg_upload(file: UploadFile, max_bytes: int) -> tuple[bytes, str]:
    filename = file.filename or "upload.svg"
    try:
        data = await file.read(max_bytes + 1)
    finally:
        await file.close()
    if len(data) > max_bytes:
        raise HTTPException(status_code=413, detail="SVG exceeds the 20 MB upload limit")
    if not data:
        raise HTTPException(status_code=422, detail="The uploaded file is empty")
    if Path(filename).suffix.lower() != ".svg":
        raise HTTPException(status_code=415, detail="Only .svg files are supported in v1")
    return data, filename


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; "
        "object-src 'none'; base-uri 'none'; "
        "frame-ancestors 'self' https://huggingface.co https://*.huggingface.co; form-action 'self'"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Cache-Control"] = "no-store" if request.url.path.startswith("/api/") else "no-cache"
    return response


@app.exception_handler(SVGAnalysisError)
async def analysis_error_handler(_request: Request, exc: SVGAnalysisError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": str(exc)})


@app.get("/healthz", tags=["system"])
async def health() -> dict[str, str]:
    profile = load_profile()
    return {"status": "ok", "profile_version": profile.profile.version}


@app.get("/api/v1/profile", tags=["preflight"])
async def profile_endpoint() -> dict:
    return public_profile(load_profile())


@app.post("/api/v1/analyze", response_model=AnalysisReport, tags=["preflight"])
async def analyze_endpoint(
    file: Annotated[UploadFile, File(description="One SVG file")],
    assignment_id: Annotated[str, Form()],
    material_id: Annotated[str, Form()],
    thickness_mm: Annotated[float, Form(gt=0)],
) -> AnalysisReport:
    profile = load_profile()
    try:
        assignment = get_assignment(profile, assignment_id)
    except KeyError as exc:
        raise HTTPException(status_code=422, detail=f"Unknown assignment_id: {assignment_id}") from exc
    try:
        material = get_material(profile, material_id)
    except KeyError as exc:
        raise HTTPException(status_code=422, detail=f"Unknown material_id: {material_id}") from exc
    if not material.approved:
        raise HTTPException(status_code=422, detail=f"Material is not approved for student use: {material.name}")
    if not any(abs(thickness_mm - choice) <= 0.001 for choice in material.thicknesses_mm):
        choices = ", ".join(f"{value / 25.4:.4f} in" for value in material.thicknesses_mm)
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported thickness for {material.name}; choose one of: {choices}",
        )
    data, filename = await _read_svg_upload(file, profile.limits.max_upload_bytes)

    try:
        await asyncio.wait_for(ANALYSIS_SEMAPHORE.acquire(), timeout=2.0)
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=503, detail="Analyzer is busy; try again shortly") from exc
    release_on_exit = True
    try:
        analysis_task = asyncio.create_task(
            asyncio.to_thread(
                analyze_svg,
                data=data,
                filename=filename,
                profile=profile,
                assignment=assignment,
                material=material,
                thickness_mm=thickness_mm,
            )
        )
        try:
            return await asyncio.wait_for(
                asyncio.shield(analysis_task),
                timeout=profile.limits.analysis_timeout_seconds,
            )
        except asyncio.TimeoutError:
            release_on_exit = False
            analysis_task.add_done_callback(_release_analysis_permit)
            return failure_report(
                data=data,
                filename=filename,
                profile=profile,
                assignment=assignment,
                material=material,
                thickness_mm=thickness_mm,
                title="Analysis time limit exceeded",
                message="This SVG is too complex to analyze within the configured time limit.",
                rule_id="file.complexity",
            )
        except asyncio.CancelledError:
            release_on_exit = False
            analysis_task.add_done_callback(_release_analysis_permit)
            raise
        except Exception:
            logger.exception("SVG analysis failed unexpectedly for a sanitized request")
            return failure_report(
                data=data,
                filename=filename,
                profile=profile,
                assignment=assignment,
                material=material,
                thickness_mm=thickness_mm,
                title="SVG analysis could not be completed",
                message="Unexpected or numerically unsafe SVG geometry prevented a reliable review.",
                rule_id="file.numeric_safety",
            )
    finally:
        if release_on_exit:
            ANALYSIS_SEMAPHORE.release()


@app.post("/api/v1/fix-strokes", tags=["preflight"])
async def fix_strokes_endpoint(
    file: Annotated[UploadFile, File(description="The same SVG that was analyzed")],
    assignment_id: Annotated[str, Form()],
    expected_sha256: Annotated[str, Form()],
) -> Response:
    profile = load_profile()
    try:
        assignment = get_assignment(profile, assignment_id)
    except KeyError as exc:
        raise HTTPException(status_code=422, detail=f"Unknown assignment_id: {assignment_id}") from exc
    data, filename = await _read_svg_upload(file, profile.limits.max_upload_bytes)
    expected_sha256 = expected_sha256.strip().lower()
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise HTTPException(
            status_code=409,
            detail="This SVG no longer matches the analyzed file. Analyze it again before fixing strokes.",
        )

    try:
        await asyncio.wait_for(ANALYSIS_SEMAPHORE.acquire(), timeout=2.0)
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=503, detail="Analyzer is busy; try again shortly") from exc
    release_on_exit = True
    try:
        fix_task = asyncio.create_task(
            asyncio.to_thread(
                fix_strokes,
                data=data,
                expected_sha256=expected_sha256,
                profile=profile,
                assignment=assignment,
            )
        )
        try:
            fixed = await asyncio.wait_for(
                asyncio.shield(fix_task),
                timeout=profile.limits.analysis_timeout_seconds,
            )
        except asyncio.TimeoutError as exc:
            release_on_exit = False
            fix_task.add_done_callback(_release_analysis_permit)
            raise HTTPException(status_code=504, detail="Stroke correction exceeded the analysis time limit") from exc
        except asyncio.CancelledError:
            release_on_exit = False
            fix_task.add_done_callback(_release_analysis_permit)
            raise
    finally:
        if release_on_exit:
            ANALYSIS_SEMAPHORE.release()

    safe_stem = "".join(
        character for character in Path(filename).stem
        if character.isascii() and (character.isalnum() or character in {"-", "_"})
    )[:120] or "laser-file"
    fixed_sha256 = hashlib.sha256(fixed.data).hexdigest()
    return Response(
        content=fixed.data,
        media_type="image/svg+xml",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_stem}-cut-strokes-fixed.svg"',
            "X-Original-SHA256": expected_sha256.lower(),
            "X-Fixed-SHA256": fixed_sha256,
            "X-Corrected-Stroke-Count": str(len(fixed.changed_source_ids)),
        },
    )


@app.post("/api/v1/fix-artboard", tags=["preflight"])
async def fix_artboard_endpoint(
    file: Annotated[UploadFile, File(description="The same SVG that was analyzed")],
    assignment_id: Annotated[str, Form()],
    expected_sha256: Annotated[str, Form()],
) -> Response:
    profile = load_profile()
    try:
        assignment = get_assignment(profile, assignment_id)
    except KeyError as exc:
        raise HTTPException(status_code=422, detail=f"Unknown assignment_id: {assignment_id}") from exc
    data, filename = await _read_svg_upload(file, profile.limits.max_upload_bytes)
    expected_sha256 = expected_sha256.strip().lower()
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise HTTPException(
            status_code=409,
            detail="This SVG no longer matches the analyzed file. Analyze it again before correcting the artboard.",
        )

    try:
        await asyncio.wait_for(ANALYSIS_SEMAPHORE.acquire(), timeout=2.0)
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=503, detail="Analyzer is busy; try again shortly") from exc
    release_on_exit = True
    try:
        fix_task = asyncio.create_task(
            asyncio.to_thread(
                fix_artboard,
                data=data,
                expected_sha256=expected_sha256,
                profile=profile,
                assignment=assignment,
            )
        )
        try:
            fixed = await asyncio.wait_for(
                asyncio.shield(fix_task),
                timeout=profile.limits.analysis_timeout_seconds,
            )
        except asyncio.TimeoutError as exc:
            release_on_exit = False
            fix_task.add_done_callback(_release_analysis_permit)
            raise HTTPException(status_code=504, detail="Artboard correction exceeded the analysis time limit") from exc
        except asyncio.CancelledError:
            release_on_exit = False
            fix_task.add_done_callback(_release_analysis_permit)
            raise
    finally:
        if release_on_exit:
            ANALYSIS_SEMAPHORE.release()

    safe_stem = "".join(
        character for character in Path(filename).stem
        if character.isascii() and (character.isalnum() or character in {"-", "_"})
    )[:120] or "laser-file"
    fixed_sha256 = hashlib.sha256(fixed.data).hexdigest()
    return Response(
        content=fixed.data,
        media_type="image/svg+xml",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_stem}-artboard-fixed.svg"',
            "X-Original-SHA256": expected_sha256,
            "X-Fixed-SHA256": fixed_sha256,
            "X-Artboard-Width-In": f"{fixed.target_width_mm / 25.4:g}",
            "X-Artboard-Height-In": f"{fixed.target_height_mm / 25.4:g}",
        },
    )


def _configure_frontend() -> None:
    configured = os.getenv("LASER_REVIEWER_FRONTEND_DIST")
    if not configured:
        return
    dist = Path(configured).resolve()
    index = dist / "index.html"
    assets = dist / "assets"
    if not index.is_file():
        return
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="frontend-assets")

    @app.get("/{requested_path:path}", include_in_schema=False)
    async def frontend_spa(requested_path: str):
        if requested_path == "api" or requested_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="API route not found")
        candidate = (dist / requested_path).resolve()
        try:
            candidate.relative_to(dist)
        except ValueError:
            raise HTTPException(status_code=404, detail="Not found")
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(index)


_configure_frontend()
