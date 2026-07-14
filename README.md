---
title: Laser Cutter Reviewer
emoji: ✂️
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
short_description: Student-facing SVG preflight for Epilog laser cutter projects
---

# Laser Cutter Reviewer

Laser Cutter Reviewer is a student-facing preflight tool for Adobe Illustrator SVG exports. It checks document setup, vector cut geometry, embedded resources, and material-dependent risk indicators before a file reaches the instructor. Results include an annotated 2D view, an approximate material preview, and a fingerprinted PDF report.

The app does **not** modify uploaded files, set laser power/speed, or certify that a job is safe to run. “Ready for teacher review” only means that the automated profile checks found no blockers. An instructor must still inspect the file, material, machine settings, ventilation, focus, placement, and supervision requirements.

## Privacy and security

- Analysis is anonymous and stateless; there are no accounts or submission records.
- Uploaded SVG data is processed in memory or short-lived request storage and is not retained by the application.
- The browser renders normalized preview geometry returned by the analyzer, never the uploaded SVG markup itself.
- External SVG resources, scripts, entities, and unsafe document features are rejected or reported.
- The default maximum upload size is 20 MB, with additional geometry and analysis limits in the service.

Deploying a public Space sends files to Hugging Face infrastructure for transient processing. Confirm that this is compatible with school policy before inviting students to use it.

## Version 1 scope

- SVG is the only accepted file format, with Adobe Illustrator exports as the primary target.
- The app reviews and visualizes a file but never rewrites it.
- Packing/nesting is intentionally deferred. A future packer must preserve the original and export a separate packed SVG.
- The 3D view is an approximate inspection aid; it cannot infer keep-versus-scrap, assembly intent, charring, or real strength.
- PDF and DXF can be added later as parser adapters behind the same normalized report format.

## Lab profile

Rules live in `config/lab-profile.yaml`. The checked-in profile is intentionally marked `demo: true`; it provides realistic examples but cannot return a production “Ready for teacher review” result. Before classroom use:

1. Enter the exact usable bed dimensions and margins for the lab's Epilog machine.
2. Confirm assignment page dimensions, process colors, and accepted stroke widths.
3. Replace example materials with approved products and verified thickness, kerf, bridge, spacing, and loose-piece thresholds.
4. Set `demo: false` only after testing at least one known-good and one known-bad Illustrator export against the physical lab workflow.

Keep the profile version current whenever a rule or material assumption changes so exported reports remain traceable.
Assignments and materials may define `severity_overrides` by rule ID, and each material has a
`heat_density_threshold_mm_per_mm2`. Overrides can promote or tune estimated warnings, but the
service never allows a configured override to weaken an automated blocker.

## Run with Docker

Docker is the supported production path and matches Hugging Face Spaces:

```bash
docker build -t laser-cutter-reviewer .
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m -p 7860:7860 laser-cutter-reviewer
```

Open `http://localhost:7860`. The health endpoint is `http://localhost:7860/healthz`.

For Docker Compose:

```bash
docker compose up --build
```

The production container builds the Vite frontend, installs the Python service, runs as an unprivileged user with UID/GID 1000, and listens on port 7860.

## Run from source

Requirements: Python 3.12+, Node.js 22+, and npm.

In one terminal:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --host 127.0.0.1 --port 7860
```

On Windows PowerShell, activate the environment with `.venv\\Scripts\\Activate.ps1` instead.

In a second terminal:

```bash
cd frontend
npm ci
npm run dev
```

Use the URL printed by Vite. Its development proxy forwards API requests to the FastAPI service. For a production-style source run, build the frontend and point the backend at it:

```bash
cd frontend
npm ci
npm run build
cd ..
LASER_REVIEWER_FRONTEND_DIST=frontend/dist uvicorn backend.main:app --host 127.0.0.1 --port 7860
```

In PowerShell, set the environment variable with `$env:LASER_REVIEWER_FRONTEND_DIST = "frontend/dist"` before starting Uvicorn.

## API

- `GET /healthz` — liveness/readiness check.
- `GET /api/v1/profile` — public machine, assignment, and material choices.
- `POST /api/v1/analyze` — multipart SVG analysis with assignment, material, and thickness selections.

The API returns normalized, sanitized geometry and a versioned analysis report. Uploaded source markup is not echoed into the page.

## Deploy to Hugging Face Spaces

1. Create a new **Docker** Space.
2. Push this repository to the Space Git remote.
3. Keep the Space SDK set to Docker and its app port set to 7860 (the metadata above already declares both).
4. Review the build log, then verify `/healthz`, a known-good SVG, and a known-bad SVG.
5. Leave the Space profile in demo mode until the lab-specific validation steps above are complete.

No database, persistent volume, secrets, or external services are required. If the Space is public, anyone with the URL can submit a file for transient analysis.

## Quality checks

```bash
python -m pytest backend/tests -q
cd frontend
npm test
npm run build
```

GitHub Actions runs these backend and frontend checks on every push and pull request, then builds the production Docker image without publishing it.

The final container can be smoke-tested with:

```bash
docker build -t laser-cutter-reviewer .
docker run --rm -d --name laser-reviewer-smoke -p 7860:7860 laser-cutter-reviewer
curl --fail http://localhost:7860/healthz
docker stop laser-reviewer-smoke
```

## Classroom operating boundary

Automated geometry analysis cannot reliably infer which pieces are intended to be kept, how assemblies carry load, whether a specific sheet is approved, or whether the physical laser is configured correctly. Treat all 3D appearance, kerf, raster resolution, heat density, and thin-feature findings as review aids. The operator checklist and instructor approval remain mandatory for every job.
