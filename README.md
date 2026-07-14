---
title: Laser Cutter Reviewer
emoji: ✂️
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
short_description: Student SVG preflight for Epilog laser cutter projects
---

# Laser Cutter Reviewer

Laser Cutter Reviewer is a student-facing preflight tool for Adobe Illustrator SVG exports. It checks document setup, vector cut geometry, embedded resources, and material-dependent risk indicators before a file reaches the instructor. The classroom assignments default to a 12 x 12 inch artboard, and physical measurements are presented in inches while the analyzer continues to normalize geometry internally in millimeters. Results include an annotated 2D view, an approximate material preview, and a fingerprinted PDF report.

The app never changes the uploaded original, sets laser power/speed, or certifies that a job is safe to run. When the analyzer offers a correction, one click downloads a separate corrected SVG and immediately runs that copy through the full review again so its updated preview and findings appear in the app. Eligible stroke corrections normalize only the identified likely cut strokes to `#000000` and `0.001in`; eligible artboard corrections set the assignment page size without scaling or moving the artwork. “Ready for teacher review” only means that the automated profile checks found no blockers. An instructor must still inspect the file, material, machine settings, ventilation, focus, placement, and supervision requirements.

## Privacy and security

- Analysis is anonymous and stateless; there are no accounts or submission records.
- Uploaded SVG data is processed in memory or short-lived request storage and is not retained by the application.
- The browser renders normalized preview geometry returned by the analyzer, never the uploaded SVG markup itself.
- Valid embedded PNG and JPEG images are decoded, format-checked, bounded, and safely re-encoded before they are returned as multiply-blended preview layers.
- Linked images are blockers because the SVG contains only a reference to pixels that are not present in the upload. External resources are never fetched; students must embed linked images in Illustrator before exporting again.
- External SVG resources, scripts, entities, and unsafe document features are rejected or reported.
- The default maximum upload size is 20 MB, with additional geometry and analysis limits in the service.

Deploying a public Space sends files to Hugging Face infrastructure for transient processing. Confirm that this is compatible with school policy before inviting students to use it.

## Version 1.2 scope

- SVG is the only accepted file format, with Adobe Illustrator exports as the primary target.
- Classroom assignments use a 12 x 12 inch default artboard, and student-facing measurements default to inches.
- The configured through-cut target remains exactly `0.001in`. To accommodate Illustrator SVG export rounding observed in classroom files, the demo profile accepts physical cut strokes from `0.00070in` through approximately `0.00102in`; the lower and upper tolerances are configured separately in the lab profile.
- The uploaded original is read-only. A one-click stroke correction downloads a separate SVG containing only analyzer-identified likely cut-stroke normalization to pure RGB black (`#000000`) and `0.001in`, then immediately analyzes and previews that corrected copy. Automatic correction is limited to plausible cut widths up to `0.010in` and is disabled for documents with shared `<use>` geometry, CSS priorities, ambiguous transforms, unsafe effects, or unresolved resources so intentional engraving is not silently converted.
- For exact-size assignments, an eligible one-click artboard correction downloads a separate SVG and immediately re-reviews it. The corrected artboard is anchored at the existing top-left/viewBox origin and preserves the artwork's physical scale and coordinates; making a page smaller can therefore reveal out-of-page artwork. The fix is conservatively withheld when viewport mapping or geometry cannot be proven stable.
- Embedded raster images can appear in the sanitized 2D preview as multiply-blended layers. Linked images remain blocked because their pixel data is absent from the SVG.
- Packing/nesting is intentionally deferred. A future packer must preserve the original and export a separate packed SVG.
- The 3D view is an approximate inspection aid; it cannot infer keep-versus-scrap, assembly intent, charring, or real strength.
- PDF and DXF can be added later as parser adapters behind the same normalized report format.

## Lab profile

Rules live in `config/lab-profile.yaml`. The checked-in profile is intentionally marked `demo: true`; it provides realistic examples but cannot return a production “Ready for teacher review” result. Before classroom use:

1. Enter the exact usable bed dimensions and margins for the lab's Epilog machine.
2. Confirm the 12 x 12 inch classroom assignment default, process colors, and accepted stroke widths against the lab workflow.
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
- `POST /api/v1/fix-strokes` — multipart, stateless generation of a separate corrected SVG for analyzer-identified cut strokes. The uploaded original is unchanged.
- `POST /api/v1/fix-artboard` — multipart, stateless generation of a separate SVG with the exact assignment artboard while preserving verified physical artwork geometry. The uploaded original is unchanged.

The analysis API returns normalized, sanitized geometry and a versioned report. Valid embedded images are returned only as safely re-encoded preview data, while linked images are never fetched. Uploaded source markup is not echoed into the page.

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
