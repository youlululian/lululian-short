import copy

import pytest
from lululian import pipeline
from lululian.models import Episode, JobInput, ProjectDocument, Settings, Shot
from lululian.providers import ProviderError


def fixture_project():
    return ProjectDocument(
        title="测试",
        premise="女孩在桌上找到一封信。",
        approved_hash="approved",
        episodes=[Episode(title="第一集", shots=[Shot(title="开场", visual="拿起信", duration=5)])],
    )


def review(passed=True):
    return {
        "passed": passed,
        "verdict": "pass" if passed else "revise",
        "score": 90 if passed else 40,
        "issues": [],
        "summary": "ok",
    }


def setup_fakes(monkeypatch, reports):
    generated = []

    def generate(*args, **kwargs):
        name = f"{len(generated) + 1:032x}.mp4"
        generated.append(name)
        return name

    iterator = iter(reports)
    monkeypatch.setattr(pipeline, "generate_video", generate)
    monkeypatch.setattr(pipeline, "judge_video", lambda *a, **k: next(iterator))
    monkeypatch.setattr(
        pipeline,
        "revise_prompt",
        lambda *a: {"video_prompt": "明确展示手指拿起信封", "change_summary": "强化动作"},
    )
    monkeypatch.setattr(
        pipeline, "render_episode", lambda *a: {"video": "final.mp4", "episode_id": a[1].id}
    )
    return generated


def test_repair_only_failed_shot_and_keep_history(monkeypatch, tmp_path):
    generated = setup_fakes(monkeypatch, [review(False), review(), review()])
    project = fixture_project()
    events, saved = [], []
    task = JobInput(kind="pipeline", episode_id=project.episodes[0].id, max_calls=6)
    result = pipeline.run_pipeline(
        project,
        task,
        Settings(mode="live"),
        tmp_path,
        lambda p: saved.append(copy.deepcopy(p)),
        lambda k, d: events.append((k, d)),
        lambda *a: None,
    )
    assert result["deliverable"] and result["model_calls"] == 6
    assert len(generated) == 2
    revision = next(d for k, d in events if k == "prompt_revised")
    assert revision["old_video"] == generated[0]
    assert saved[0].episodes[0].shots[0].video == generated[0]


def test_budget_stops_before_an_extra_provider_call(monkeypatch, tmp_path):
    generated = setup_fakes(monkeypatch, [review(False)])
    project = fixture_project()
    with pytest.raises(ProviderError, match="调用上限"):
        pipeline.run_pipeline(
            project,
            JobInput(kind="pipeline", episode_id=project.episodes[0].id, max_calls=2),
            Settings(mode="live"),
            tmp_path,
            lambda p: None,
            lambda *a: None,
            lambda *a: None,
        )
    assert len(generated) == 1


def test_locked_failure_and_uncertainty_never_rewrite(monkeypatch, tmp_path):
    generated = setup_fakes(monkeypatch, [review(False)])
    project = fixture_project()
    project.episodes[0].shots[0].locked = True
    project.episodes[0].shots[0].video = "a" * 32 + ".mp4"
    with pytest.raises(ProviderError, match="人工处理"):
        pipeline.run_pipeline(
            project,
            JobInput(kind="pipeline", episode_id=project.episodes[0].id),
            Settings(mode="live"),
            tmp_path,
            lambda p: None,
            lambda *a: None,
            lambda *a: None,
        )
    assert not generated


def test_failed_final_review_does_not_mark_deliverable(monkeypatch, tmp_path):
    setup_fakes(monkeypatch, [review(), review(False)])
    project = fixture_project()
    events = []
    with pytest.raises(ProviderError, match="成片一致性复核未通过"):
        pipeline.run_pipeline(
            project,
            JobInput(kind="pipeline", episode_id=project.episodes[0].id),
            Settings(mode="live"),
            tmp_path,
            lambda p: None,
            lambda k, d: events.append((k, d)),
            lambda *a: None,
        )
    assert any(k == "episode_rendered" for k, _ in events)
    assert any(k == "final_review" for k, _ in events)


def test_restart_marks_interrupted_jobs_failed(tmp_path):
    from lululian.jobs import JobRunner
    from lululian.store import Store, now

    store = Store(tmp_path)
    project = store.create(fixture_project())
    with store.connect() as db:
        db.execute(
            "INSERT INTO jobs (id,project_id,kind,status,payload,created_at,updated_at) VALUES (?,?,?,'running','{}',?,?)",
            ("job1", project["id"], "videos", now(), now()),
        )
    runner = JobRunner(store)
    assert store.jobs(project["id"])[0]["status"] == "failed"
    runner.shutdown()
