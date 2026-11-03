import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

from fastapi import HTTPException

from .feedback import FeedbackStore
from .judge import check_assets, content_hash, review_script
from .models import JobInput, ProjectDocument, new_id
from .pipeline import run_pipeline
from .production_contracts import expected_shot
from .prompt_agent import optimize_prompt, summarize_feedback
from .providers import ProviderError, generate_image, generate_script, generate_voice, load_settings
from .render import media_duration, render_episode
from .store import now
from .video import generate_video
from .vision import judge_video


class JobRunner:
    """Single-process worker with persisted state and explicit, user-controlled retries."""

    def __init__(self, store):
        self.store = store
        self.feedback = FeedbackStore(store)
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="studio")
        self.submit_lock = Lock()
        with store.connect() as db:
            db.execute(
                "UPDATE jobs SET status='failed', message=?, updated_at=? WHERE status IN ('queued','running')",
                ("服务曾中断。已生成的素材已保留，可重新提交剩余任务。", now()),
            )

    def submit(self, pid, task: JobInput):
        with self.submit_lock, self.store.connect():
            project = ProjectDocument.model_validate(self.store.get(pid)["document"])
            settings = load_settings(self.store.root)
            shots = [s for e in project.episodes for s in e.shots]
            if task.kind == "script":
                if shots and not task.overwrite:
                    raise HTTPException(409, "项目已有剧本；重新生成需要确认覆盖")
                if any(s.locked for s in shots):
                    raise HTTPException(409, "请先解锁所有分镜，再重新生成剧本")
            else:
                if not shots:
                    raise HTTPException(422, "请先生成剧本或添加分镜")
                if task.episode_id and task.episode_id not in {e.id for e in project.episodes}:
                    raise HTTPException(404, "剧集不存在")
                if task.shot_id and task.shot_id not in {s.id for s in shots}:
                    raise HTTPException(404, "镜头不存在")
                if task.kind in {"render", "pipeline"} and not task.episode_id:
                    raise HTTPException(422, "请选择要导出的剧集")
                if task.kind == "voice" and settings.mode == "demo":
                    raise HTTPException(422, "演示模式没有配音服务，请上传音频或配置真实配音接口")
                if task.kind in {
                    "images",
                    "voice",
                    "render",
                    "videos",
                    "pipeline",
                } and project.approved_hash != content_hash(project):
                    raise HTTPException(409, "请先执行剧本评审并人工确认当前版本，再生成素材或合成")
            if task.kind == "prompt_tune":
                if not task.feedback_id:
                    raise HTTPException(422, "请选择反馈记录")
                if settings.mode != "live":
                    raise HTTPException(422, "提示词调优需要真实文本模型")
                feedback = self.feedback.get(pid, task.feedback_id)
                self.feedback.assert_current(pid, feedback)
                if task.shot_id and task.shot_id != feedback["shot_id"]:
                    raise HTTPException(422, "反馈与目标镜头不一致")
                episode_id = next(
                    e.id
                    for e in project.episodes
                    if any(s.id == feedback["shot_id"] for s in e.shots)
                )
                if task.episode_id and task.episode_id != episode_id:
                    raise HTTPException(422, "反馈与目标剧集不一致")
                task.shot_id, task.episode_id = feedback["shot_id"], episode_id
                with self.store.connect() as db:
                    attempts = db.execute(
                        "SELECT COUNT(*) FROM jobs WHERE project_id=? AND kind='prompt_tune' AND json_extract(payload, '$.feedback_id')=?",
                        (pid, task.feedback_id),
                    ).fetchone()[0]
                if attempts >= 3:
                    raise HTTPException(
                        409, "此条反馈已达到 3 次调优上限，请查看结果并提交新的人工反馈"
                    )
            jid = new_id()
            try:
                with self.store.connect() as db:
                    db.execute(
                        "INSERT INTO jobs (id,project_id,kind,status,payload,created_at,updated_at) VALUES (?,?,?,'queued',?,?,?)",
                        (jid, pid, task.kind, task.model_dump_json(), now(), now()),
                    )
            except sqlite3.IntegrityError as exc:
                raise HTTPException(409, "此项目已有运行中的任务，请等待完成") from exc
            self.executor.submit(self.execute, jid, pid, task, project, settings)
            return {"id": jid, "status": "queued"}

    def execute(self, jid, pid, task, project, settings):
        def progress(value, message):
            self.store.update_job(jid, "running", value, message)

        try:
            self.store.event(
                jid,
                "pipeline_prompt_profile",
                {
                    "prompts": project.pipeline_prompts.model_dump(),
                    "content_hash": content_hash(project),
                },
            )
            progress(1, "正在准备任务")
            directory = self.store.asset_dir(pid)
            result = {"mode": settings.mode}
            if task.kind == "script":
                progress(
                    10, "正在创作剧本与分镜" if settings.mode == "live" else "正在载入演示故事"
                )
                project = generate_script(project, settings)
                self.store.save(pid, project, worker=True)
            elif task.kind == "judge":
                progress(20, "正在评审剧本与分镜")
                result = review_script(project, settings)
            elif task.kind == "asset_check":
                progress(20, "正在检查素材是否可解码")
                result = check_assets(project, directory)
            elif task.kind == "prompt_tune":
                feedback = self.feedback.get(pid, task.feedback_id)
                history = self.feedback.history(pid, feedback, task.feedback_limit)
                selected = [*history, feedback]
                counts = {
                    "history_requested": task.feedback_limit,
                    "history_used": len(history),
                    "total": len(selected),
                    "passed": sum(f["rating"] == "satisfied" for f in selected),
                    "failed": sum(f["rating"] == "unsatisfied" for f in selected),
                    "feedback_ids": [f["id"] for f in selected],
                }
                progress(10, f"正在总结 {len(selected)} 条人工通过/不通过标注")
                summary = summarize_feedback(
                    [{k: f[k] for k in ("rating", "notes", "edited_prompt")} for f in selected],
                    settings,
                    instructions=project.pipeline_prompts.feedback_summary,
                )
                self.store.event(
                    jid, "human_feedback_summarized", {"summary": summary, "annotations": counts}
                )
                progress(55, "正在依据人工标注总结优化视频提示词")
                proposal = optimize_prompt(
                    feedback["snapshot"]["script"],
                    {k: feedback[k] for k in ("rating", "notes", "edited_prompt")},
                    summary,
                    settings,
                    instructions=project.pipeline_prompts.prompt_tune,
                )
                proposal.update(feedback_summary=summary, annotations=counts)
                self.feedback.proposal(pid, task.feedback_id, proposal)
                self.store.event(
                    jid, "prompt_proposed", {"feedback_id": task.feedback_id, **proposal}
                )
                result = {
                    "feedback_id": task.feedback_id,
                    "proposal": proposal,
                    "revision": self.store.get(pid)["revision"],
                }
            elif task.kind == "pipeline":
                result = run_pipeline(
                    project,
                    task,
                    settings,
                    directory,
                    lambda doc: self.store.save(pid, doc, worker=True),
                    lambda kind, data: self.store.event(jid, kind, data),
                    progress,
                )
                result["revision"] = self.store.get(pid)["revision"]
            elif task.kind == "video_judge":
                reports = []
                if task.export_id:
                    exports = [
                        j
                        for j in self.store.jobs(pid)
                        if j["status"] == "succeeded"
                        and j["result"]
                        and j["result"].get("video") == f"{task.export_id}.mp4"
                    ]
                    if not exports:
                        raise ValueError("找不到该成片记录")
                    export = exports[0]["result"]
                    if export.get("revision") != self.store.get(pid)["revision"]:
                        raise ValueError("成片来自旧版本，请先重新合成当前版本再复核")
                    ep = next(e for e in project.episodes if e.id == export["episode_id"])
                    report = judge_video(
                        directory / export["video"],
                        {"episode": ep.model_dump()},
                        settings,
                        instructions=project.pipeline_prompts.video_judge,
                    )
                    reports.append({"video": export["video"], "review": report})
                else:
                    selected = [
                        s
                        for e in project.episodes
                        if not task.episode_id or task.episode_id == e.id
                        for s in e.shots
                        if not task.shot_id or task.shot_id == s.id
                    ]
                    if not selected or any(not s.video for s in selected):
                        raise ValueError("请先为所选镜头生成或上传视频")
                    if len(selected) > task.max_calls:
                        raise ValueError("所选镜头数量超过调用次数上限")
                    for i, shot in enumerate(selected):
                        progress(
                            round(i / len(selected) * 90) + 1,
                            f"正在评审镜头 {i + 1}/{len(selected)}",
                        )
                        report = judge_video(
                            directory / shot.video,
                            expected_shot(project, shot),
                            settings,
                            directory / shot.image if shot.image else None,
                            instructions=project.pipeline_prompts.video_judge,
                        )
                        item = {"shot_id": shot.id, "video": shot.video, "review": report}
                        reports.append(item)
                        self.store.event(jid, "video_review", item)
                result = {
                    "scope": "video",
                    "reports": reports,
                    "passed": all(r["review"]["passed"] for r in reports),
                    "revision": self.store.get(pid)["revision"],
                }
            elif task.kind == "render":
                episode = next(e for e in project.episodes if e.id == task.episode_id)
                result = {
                    **result,
                    **render_episode(project, episode, directory, progress),
                    "revision": self.store.get(pid)["revision"],
                }
            else:
                field = {"images": "image", "voice": "audio", "videos": "video"}[task.kind]
                shots = [
                    s
                    for e in project.episodes
                    if not task.episode_id or e.id == task.episode_id
                    for s in e.shots
                    if not s.locked
                    and (not task.shot_id or s.id == task.shot_id)
                    and (task.overwrite or not getattr(s, field))
                ]
                if not shots:
                    raise ValueError("没有待生成镜头：镜头可能已锁定、已有素材，或筛选范围为空")
                for index, shot in enumerate(shots):
                    progress(
                        round(index / len(shots) * 95) + 1,
                        f"正在生成镜头 {index + 1}/{len(shots)}：{shot.title}",
                    )
                    if task.kind == "images":
                        shot.image = generate_image(project, shot, settings, directory)
                    elif task.kind == "videos":
                        shot.video = generate_video(
                            project,
                            shot,
                            settings,
                            directory,
                            lambda msg: progress(round(index / len(shots) * 95) + 1, msg),
                            nonce=jid if task.overwrite else "",
                        )
                    else:
                        filename = generate_voice(shot, settings, directory)
                        duration = media_duration(directory / filename)
                        if duration > 120:
                            raise ValueError("配音超过 120 秒，请拆分该镜头台词")
                        shot.audio = filename
                    # Checkpoint after every asset: a later failure does not lose earlier work.
                    self.store.save(pid, project, worker=True)
                result["generated"] = len(shots)
            self.store.update_job(jid, "succeeded", 100, "任务完成", result)
        except (ProviderError, ValueError, RuntimeError) as exc:
            self.store.update_job(jid, "failed", 0, str(exc)[:400])
        except Exception:
            self.store.update_job(
                jid, "failed", 0, "任务执行失败，已完成素材保留。请检查配置与素材后重试。"
            )

    def shutdown(self):
        self.executor.shutdown(wait=True, cancel_futures=True)
