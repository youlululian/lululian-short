import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from .models import ProjectDocument, new_id


def now():
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.media = self.root / "media"
        self.media.mkdir(exist_ok=True)
        self.db = self.root / "studio.sqlite3"
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY, document TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                    kind TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER DEFAULT 0,
                    message TEXT DEFAULT '', payload TEXT NOT NULL,
                    result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs(project_id)
                    WHERE status IN ('queued','running');
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def create(self, document: ProjectDocument):
        pid, timestamp = new_id(), now()
        with self.connect() as db:
            db.execute(
                "INSERT INTO projects VALUES (?, ?, 1, ?, ?)",
                (pid, document.model_dump_json(), timestamp, timestamp),
            )
        return self.get(pid)

    def get(self, pid):
        with self.connect() as db:
            row = db.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "项目不存在")
        return {**dict(row), "document": json.loads(row["document"])}

    def list(self):
        with self.connect() as db:
            rows = db.execute("SELECT * FROM projects ORDER BY updated_at DESC").fetchall()
        return [{**dict(r), "document": json.loads(r["document"])} for r in rows]

    def save(self, pid, document, revision=None, worker=False):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if (
                not worker
                and db.execute(
                    "SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running')",
                    (pid,),
                ).fetchone()
            ):
                raise HTTPException(409, "项目正在生成，请等待任务完成后再保存")
            row = db.execute("SELECT revision FROM projects WHERE id=?", (pid,)).fetchone()
            if not row:
                raise HTTPException(404, "项目不存在")
            if revision is not None and revision != row[0]:
                raise HTTPException(409, "项目已有新版本，请刷新后再编辑")
            db.execute(
                "UPDATE projects SET document=?, revision=revision+1, updated_at=? WHERE id=?",
                (document.model_dump_json(), now(), pid),
            )
        return self.get(pid)

    def jobs(self, pid):
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 100", (pid,)
            ).fetchall()
        return [self.job_dict(r) for r in rows]

    @staticmethod
    def job_dict(row):
        return {
            **dict(row),
            "payload": json.loads(row["payload"]),
            "result": json.loads(row["result"]) if row["result"] else None,
        }

    def update_job(self, jid, status, progress, message, result=None):
        with self.connect() as db:
            db.execute(
                "UPDATE jobs SET status=?, progress=?, message=?, result=?, updated_at=? WHERE id=?",
                (status, progress, message, json.dumps(result) if result else None, now(), jid),
            )

    def asset_dir(self, pid):
        self.get(pid)
        path = self.media / pid
        path.mkdir(exist_ok=True)
        return path
