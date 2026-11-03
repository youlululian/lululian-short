"""Versioned human feedback and proposal application, independent of model calls."""

import json
from typing import Literal

from fastapi import HTTPException
from pydantic import Field

from .judge import content_hash
from .models import Model, ProjectDocument, new_id
from .production_contracts import expected_shot
from .store import now
from .video import video_prompt


class FeedbackInput(Model):
    revision: int = Field(ge=1)
    shot_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    rating: Literal["satisfied", "unsatisfied"]
    notes: str = Field(default="", max_length=3000)
    edited_prompt: str = Field(min_length=5, max_length=8000)


class ApplyFeedback(Model):
    revision: int = Field(ge=1)
    source: Literal["human", "agent"]


class FeedbackStore:
    def __init__(self, store):
        self.store = store
        with store.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS production_feedback (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, shot_id TEXT NOT NULL,
                revision INTEGER NOT NULL, rating TEXT NOT NULL, notes TEXT NOT NULL,
                edited_prompt TEXT NOT NULL, snapshot TEXT NOT NULL, proposal TEXT,
                applied_source TEXT, applied_revision INTEGER, created_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE)""")

    @staticmethod
    def decode(row):
        return {
            **dict(row),
            "snapshot": json.loads(row["snapshot"]),
            "proposal": json.loads(row["proposal"]) if row["proposal"] else None,
        }

    def list(self, pid):
        self.store.get(pid)
        with self.store.connect() as db:
            return [
                self.decode(row)
                for row in db.execute(
                    "SELECT * FROM production_feedback WHERE project_id=? ORDER BY created_at DESC LIMIT 100",
                    (pid,),
                )
            ]

    def history(self, pid, feedback, limit):
        """Select only earlier human labels for this shot and creative version."""
        with self.store.connect() as db:
            rows = db.execute(
                "SELECT * FROM production_feedback WHERE project_id=? AND shot_id=? AND id<>? "
                "AND created_at<=? AND json_extract(snapshot, '$.content_hash')=? "
                "ORDER BY created_at DESC LIMIT ?",
                (
                    pid,
                    feedback["shot_id"],
                    feedback["id"],
                    feedback["created_at"],
                    feedback["snapshot"]["content_hash"],
                    limit,
                ),
            ).fetchall()
        return [self.decode(row) for row in reversed(rows)]

    def get(self, pid, fid):
        with self.store.connect() as db:
            row = db.execute(
                "SELECT * FROM production_feedback WHERE id=? AND project_id=?", (fid, pid)
            ).fetchone()
        if not row:
            raise HTTPException(404, "反馈记录不存在")
        return self.decode(row)

    def idle(self, pid):
        with self.store.connect() as db:
            if db.execute(
                "SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running')", (pid,)
            ).fetchone():
                raise HTTPException(409, "请等待当前制作任务完成后再提交或采用反馈")

    def context(self, pid, revision, shot_id):
        record = self.store.get(pid)
        if record["revision"] != revision:
            raise HTTPException(409, "项目已变化，请刷新后重新查看镜头并反馈")
        project = ProjectDocument.model_validate(record["document"])
        shot = next((s for e in project.episodes for s in e.shots if s.id == shot_id), None)
        if not shot:
            raise HTTPException(404, "镜头不存在")
        return project, shot

    def create(self, pid, body):
        # Reentrant store lock keeps revision validation and insertion atomic.
        with self.store.connect() as db:
            self.idle(pid)
            project, shot = self.context(pid, body.revision, body.shot_id)
            if not shot.video:
                raise HTTPException(409, "请先生成或上传视频，再对实际产物反馈")
            snapshot = {
                "script": expected_shot(project, shot),
                "content_hash": content_hash(project),
                "video": shot.video,
                "prompt": video_prompt(project, shot),
            }
            fid = new_id()
            db.execute(
                "INSERT INTO production_feedback VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,?)",
                (
                    fid,
                    pid,
                    body.shot_id,
                    body.revision,
                    body.rating,
                    body.notes,
                    body.edited_prompt,
                    json.dumps(snapshot, ensure_ascii=False),
                    now(),
                ),
            )
        return self.get(pid, fid)

    def proposal(self, pid, fid, proposal):
        with self.store.connect() as db:
            db.execute(
                "UPDATE production_feedback SET proposal=? WHERE id=? AND project_id=?",
                (json.dumps(proposal, ensure_ascii=False), fid, pid),
            )

    def assert_current(self, pid, feedback):
        project, shot = self.context(pid, feedback["revision"], feedback["shot_id"])
        if shot.locked:
            raise HTTPException(409, "请先解锁镜头")
        if project.approved_hash != content_hash(project):
            raise HTTPException(409, "请先评审并确认当前剧本")
        return project, shot

    def apply(self, pid, fid, body):
        # Keep this transition separate from inference: no proposal is auto-applied.
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self.idle(pid)
            feedback = self.get(pid, fid)
            if body.revision != feedback["revision"] or feedback["applied_source"]:
                raise HTTPException(409, "此反馈已采用或来自旧版本，请重新反馈")
            project, shot = self.assert_current(pid, feedback)
            if body.source == "agent":
                if not feedback["proposal"]:
                    raise HTTPException(409, "尚无调优提案")
                shot.video_prompt = feedback["proposal"]["video_prompt"]
            else:
                shot.video_prompt = feedback["edited_prompt"]
            timestamp, next_revision = now(), body.revision + 1
            db.execute(
                "UPDATE projects SET document=?, revision=?, updated_at=? WHERE id=?",
                (project.model_dump_json(), next_revision, timestamp, pid),
            )
            db.execute(
                "INSERT INTO revisions VALUES (?,?,?,?)",
                (pid, next_revision, project.model_dump_json(), timestamp),
            )
            db.execute(
                "UPDATE production_feedback SET applied_source=?, applied_revision=? WHERE id=?",
                (body.source, next_revision, fid),
            )
        return self.store.get(pid)
