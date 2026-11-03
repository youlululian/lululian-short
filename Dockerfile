FROM node:22-bookworm-slim AS web
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk curl && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.11.13 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY backend/ backend/
COPY --from=web /build/dist frontend/dist/
RUN useradd --create-home studio && mkdir -p /app/.data && chown -R studio:studio /app
USER studio
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD curl --fail http://127.0.0.1:8000/api/health || exit 1
CMD ["uv", "run", "--no-sync", "uvicorn", "lululian.main:app", "--app-dir", "backend", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
