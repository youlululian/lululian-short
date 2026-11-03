import os
import re
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .jobs import JobRunner
from .judge import content_hash
from .models import JobInput, ProjectDocument, ProjectInput, SaveProject, Settings, new_id
from .providers import load_settings, public_settings, save_settings
from .render import normalize_image, probe
from .store import Store

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")


def create_app(data_dir: Path | None = None):
    root = data_dir or Path(os.getenv("LULULIAN_DATA_DIR", str(ROOT / ".data")))
    store = Store(root)

    @asynccontextmanager
    async def lifespan(app):
        app.state.runner = JobRunner(store)
        yield
        app.state.runner.shutdown()

    app = FastAPI(title="Lululian Short Studio", version="0.1.0", lifespan=lifespan)
    app.state.store = store
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "testserver"]
    )

    @app.middleware("http")
    async def local_origin(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin and urlparse(origin).hostname not in {"localhost", "127.0.0.1"}:
            return JSONResponse({"detail": "仅允许本机工作台访问"}, status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        if request.url.path.startswith("/api"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/health")
    def health():
        return {
            "status": "ok",
            "ffmpeg": bool(shutil.which("ffmpeg") and shutil.which("ffprobe")),
            "mode": load_settings(store.root).mode,
        }

    @app.get("/api/settings")
    def get_settings():
        return public_settings(load_settings(store.root))

    @app.put("/api/settings")
    def put_settings(settings: Settings):
        save_settings(store.root, settings)
        return public_settings(load_settings(store.root))

    @app.get("/api/projects")
    def list_projects():
        return store.list()

    @app.post("/api/projects", status_code=201)
    def create_project(project: ProjectInput):
        return store.create(ProjectDocument(**project.model_dump()))

    @app.get("/api/projects/{pid}")
    def get_project(pid: str):
        return store.get(pid)

    @app.post("/api/projects/{pid}/approve")
    def approve_project(pid: str):
        record = store.get(pid)
        document = ProjectDocument.model_validate(record["document"])
        fingerprint = content_hash(document)
        reviews = [
            j
            for j in store.jobs(pid)
            if j["kind"] == "judge"
            and j["status"] == "succeeded"
            and j["result"]
            and j["result"].get("content_hash") == fingerprint
        ]
        if not reviews:
            raise HTTPException(409, "当前剧本版本尚未评审，请先运行 Judge")
        document.approved_hash = fingerprint
        return store.save(pid, document, record["revision"])

    @app.put("/api/projects/{pid}")
    def save_project(pid: str, body: SaveProject):
        body.document.approved_hash = store.get(pid)["document"].get("approved_hash", "")
        directory = store.asset_dir(pid)
        for episode in body.document.episodes:
            for shot in episode.shots:
                for asset in (shot.image, shot.audio, shot.video):
                    if asset and not (directory / asset).is_file():
                        raise HTTPException(422, "项目引用的素材不存在")
        return store.save(pid, body.document, body.revision)

    @app.delete("/api/projects/{pid}", status_code=204)
    def delete_project(pid: str):
        store.get(pid)
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute(
                "SELECT 1 FROM jobs WHERE project_id=? AND status IN ('running','queued')", (pid,)
            ).fetchone():
                raise HTTPException(409, "请等待任务完成后再删除项目")
            db.execute("DELETE FROM projects WHERE id=?", (pid,))
        shutil.rmtree(store.media / pid, ignore_errors=True)
        return Response(status_code=204)

    @app.get("/api/projects/{pid}/jobs")
    def list_jobs(pid: str):
        store.get(pid)
        return store.jobs(pid)

    @app.post("/api/projects/{pid}/jobs", status_code=202)
    def create_job(pid: str, body: JobInput):
        return app.state.runner.submit(pid, body)

    @app.post("/api/projects/{pid}/shots/{sid}/upload/{kind}")
    def upload(pid: str, sid: str, kind: str, file: UploadFile):
        if kind not in {"image", "audio", "video"}:
            raise HTTPException(422, "不支持的素材类型")
        record = store.get(pid)
        document = ProjectDocument.model_validate(record["document"])
        shot = next((s for e in document.episodes for s in e.shots if s.id == sid), None)
        if not shot:
            raise HTTPException(404, "镜头不存在")
        if shot.locked:
            raise HTTPException(409, "请先解锁镜头")
        data = file.file.read(30 * 1024 * 1024 + 1)
        if len(data) > 30 * 1024 * 1024:
            raise HTTPException(413, "单个素材不能超过 30 MB")
        extension = {"image": "png", "audio": "mp3", "video": "mp4"}[kind]
        filename = f"{new_id()}.{extension}"
        path = store.asset_dir(pid) / filename
        try:
            if kind == "image":
                normalize_image(data, path)
            else:
                path.write_bytes(data)
                metadata = probe(path)
                if not any(s.get("codec_type") == kind for s in metadata.get("streams", [])):
                    raise ValueError("素材类型不匹配")
                duration = float(metadata["format"]["duration"])
                if not 0 < duration <= 120:
                    raise ValueError("音视频素材需在 120 秒以内")
            setattr(shot, kind, filename)
            return store.save(pid, document, record["revision"])
        except HTTPException:
            path.unlink(missing_ok=True)
            raise
        except Exception as exc:
            path.unlink(missing_ok=True)
            raise HTTPException(
                422, "无法读取素材，请上传有效图片或 120 秒以内的音视频，并确认已安装 FFmpeg"
            ) from exc

    @app.get("/api/projects/{pid}/export")
    def export_project(pid: str):
        record = store.get(pid)
        return JSONResponse(
            {"format": "lululian-short/v1", **record},
            headers={"Content-Disposition": 'attachment; filename="project.json"'},
        )

    @app.get("/media/{pid}/{filename}")
    def media(pid: str, filename: str):
        store.get(pid)
        if not re.fullmatch(r"[a-f0-9]{32}\.(png|jpg|mp3|wav|mp4|srt)", filename):
            raise HTTPException(404, "素材不存在")
        path = store.media / pid / filename
        if not path.is_file():
            raise HTTPException(404, "素材不存在")
        return FileResponse(path)

    dist = ROOT / "frontend" / "dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
    return app


app = create_app()
