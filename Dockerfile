# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS frontend-builder

WORKDIR /build/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY frontend/ ./
RUN npm run build


FROM python:3.12-slim-bookworm AS runtime

ARG APP_UID=1000
ARG APP_GID=1000

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    LASER_REVIEWER_FRONTEND_DIST=/app/frontend/dist

WORKDIR /app

RUN groupadd --gid "${APP_GID}" app \
    && useradd --uid "${APP_UID}" --gid app --create-home --shell /usr/sbin/nologin app

COPY backend/requirements.txt /tmp/requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

COPY --chown=app:app backend/ /app/backend/
COPY --chown=app:app config/ /app/config/
COPY --from=frontend-builder --chown=app:app /build/frontend/dist/ /app/frontend/dist/

USER app

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7860/healthz', timeout=3).read()"]

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "7860", "--no-server-header", "--limit-concurrency", "8", "--timeout-keep-alive", "5"]
