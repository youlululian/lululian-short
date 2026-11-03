import json
import threading
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from lululian import model_agent, prompt_agent
from lululian.judge import content_hash
from lululian.main import create_app
from lululian.models import ProjectDocument, Settings, new_id
from lululian.providers import demo_script, load_settings, save_settings


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as value:
        yield value


def wait_setup(client, rid):
    for _ in range(200):
        row = next(r for r in client.get("/api/model-agent/runs").json() if r["id"] == rid)
        if row["status"] not in ("running", "cancelling"):
            return row
        time.sleep(0.01)
    pytest.fail("setup did not finish")


def start_setup(client, **extra):
    response = client.post("/api/model-agent/runs", json=extra)
    assert response.status_code == 202, response.text
    return response.json()["id"]


def test_setup_fixed_capabilities_and_missing_credentials(client, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("missing credentials must not produce requests")

    monkeypatch.setattr(model_agent, "read_catalog", forbidden)
    response = client.post(
        "/api/model-agent/runs",
        json={
            "profile": "cloud",
            "command": "touch malicious",
            "text": {"api_key": "secret-never-echo"},
        },
    )
    assert response.status_code == 422
    assert "secret-never-echo" not in response.text
    assert (
        client.post("/api/model-agent/runs", json={"local_host": "169.254.169.254"}).status_code
        == 422
    )
    old = load_settings(client.app.state.store.root)
    run = wait_setup(client, start_setup(client))
    assert run["status"] == "failed"
    assert len(run["steps"]) == 3
    assert load_settings(client.app.state.store.root) == old


def test_setup_discovers_models_retries_and_saves_without_exposing_keys(client, monkeypatch):
    calls = []

    def catalog(url, key, gemini=False):
        calls.append((url, key))
        if "deepseek" in url:
            if len(calls) == 1:
                raise model_agent.ProbeError("temporary", retryable=True)
            return {"data": [{"id": "deepseek-chat"}]}
        if "googleapis" in url:
            return {
                "models": [
                    {
                        "name": "models/gemini-flash",
                        "supportedGenerationMethods": ["generateContent"],
                    }
                ]
            }
        assert url == "https://api.minimax.io/v2/query/video_generation?page_num=1&page_size=1"
        return {"items": []}

    monkeypatch.setattr(model_agent, "read_catalog", catalog)
    run = wait_setup(
        client,
        start_setup(
            client,
            text={"api_key": "text-secret"},
            vision={"api_key": "vision-secret"},
            video={"api_key": "video-secret"},
        ),
    )
    assert run["status"] == "succeeded"
    assert run["steps"][0]["attempts"] == 2
    assert len(calls) == 4
    assert "-secret" not in json.dumps(run)
    settings = client.get("/api/settings").json()
    assert settings["mode"] == "live"
    assert settings["judge"]["model"] == "deepseek-chat"
    assert settings["vision"]["model"] == "gemini-flash"
    assert "-secret" not in json.dumps(settings)
    assert load_settings(client.app.state.store.root).video.api_key == "video-secret"


def test_cancel_setup_never_applies_and_blocks_concurrent_settings(client, monkeypatch):
    entered, release = threading.Event(), threading.Event()

    def catalog(*args):
        entered.set()
        assert release.wait(5)
        return {"data": [{"id": "local-text"}]}

    monkeypatch.setattr(model_agent, "read_catalog", catalog)
    before = load_settings(client.app.state.store.root)
    rid = start_setup(client, profile="local")
    assert entered.wait(5)
    try:
        assert client.post("/api/model-agent/runs", json={"profile": "local"}).status_code == 409
        assert client.put("/api/settings", json=before.model_dump()).status_code == 409
        assert client.post(f"/api/model-agent/runs/{rid}/cancel").status_code == 200
    finally:
        release.set()
    assert wait_setup(client, rid)["status"] == "cancelled"
    assert load_settings(client.app.state.store.root) == before


def test_model_probe_get_only_no_redirect_or_provider_secret_echo(monkeypatch):
    real = httpx.Client
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            302, headers={"location": "https://evil.invalid"}, text="leaked-secret"
        )

    monkeypatch.setattr(
        model_agent.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw)
    )
    with pytest.raises(model_agent.ProbeError, match="HTTP 302") as error:
        model_agent.read_catalog("https://api.deepseek.com/models", "leaked-secret")
    assert len(calls) == 1 and calls[0].method == "GET"
    assert "leaked-secret" not in str(error.value)


def test_keys_are_not_reused_across_service_addresses(tmp_path):
    initial = Settings()
    initial.text.api_key = "private-key"
    save_settings(tmp_path, initial)
    edited = initial.model_copy(deep=True)
    edited.text.api_key = ""
    edited.text.base_url = "https://api.deepseek.com"
    save_settings(tmp_path, edited)
    assert load_settings(tmp_path).text.api_key == ""


def fixture_video(client):
    store = client.app.state.store
    project = demo_script(ProjectDocument(title="反馈测试", premise="一个年轻人在雨夜收到一封信。"))
    video = new_id() + ".mp4"
    project.episodes[0].shots[0].video = video
    project.approved_hash = content_hash(project)
    record = store.create(project)
    (store.asset_dir(record["id"]) / video).write_bytes(b"fixture-video")
    return record, project.episodes[0].shots[0]


def add_feedback(client, record, shot, **extra):
    result = client.post(
        f"/api/projects/{record['id']}/feedback",
        json={
            "revision": record["revision"],
            "shot_id": shot.id,
            "rating": "unsatisfied",
            "notes": "人物不变，拿信动作要更慢。",
            "edited_prompt": "镜头保持稳定，人物缓慢拿起信封。",
            **extra,
        },
    )
    assert result.status_code == 201, result.text
    return result.json()


def wait_job(client, pid, jid):
    for _ in range(200):
        job = next(j for j in client.get(f"/api/projects/{pid}/jobs").json() if j["id"] == jid)
        if job["status"] in ("succeeded", "failed"):
            return job
        time.sleep(0.01)
    pytest.fail("job did not finish")


def test_human_feedback_apply_is_explicit_versioned_and_preserves_story(client):
    record, shot = fixture_video(client)
    pid = record["id"]
    feedback = add_feedback(client, record, shot, rating="satisfied")
    assert client.get(f"/api/projects/{pid}").json()["revision"] == record["revision"]
    result = client.post(
        f"/api/projects/{pid}/feedback/{feedback['id']}/apply",
        json={"revision": record["revision"], "source": "human"},
    )
    assert result.status_code == 200, result.text
    current = result.json()
    assert current["content_hash"] == record["content_hash"]
    assert current["document"]["approved_hash"] == record["document"]["approved_hash"]
    current_shot = current["document"]["episodes"][0]["shots"][0]
    assert current_shot["video"] == shot.video
    assert current_shot["video_prompt"] == feedback["edited_prompt"]
    assert (
        client.post(
            f"/api/projects/{pid}/feedback/{feedback['id']}/apply",
            json={"revision": current["revision"], "source": "human"},
        ).status_code
        == 409
    )
    stale = client.post(
        f"/api/projects/{pid}/feedback",
        json={
            "revision": record["revision"],
            "shot_id": shot.id,
            "rating": "satisfied",
            "edited_prompt": "这一份过期修改不应该生效。",
        },
    )
    assert stale.status_code == 409


def test_prompt_agent_uses_feedback_without_tools_and_limits_attempts(client, monkeypatch):
    record, shot = fixture_video(client)
    pid = record["id"]
    root = client.app.state.store.root
    settings = load_settings(root)
    settings.mode = "live"
    save_settings(root, settings)
    feedback = add_feedback(client, record, shot)
    calls = []

    def model(config, endpoint, payload):
        calls.append(payload)
        assert endpoint == "chat/completions"
        assert "tools" not in payload
        assert "人物不变" in payload["messages"][1]["content"]
        if "人工标注总结器" in payload["messages"][0]["content"]:
            return {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "retain_rules": [],
                                    "avoid_rules": ["动作过快"],
                                    "optimization_rules": ["拿信动作放慢，人物不变"],
                                }
                            )
                        }
                    }
                ]
            }
        assert "动作过快" in payload["messages"][1]["content"]
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "video_prompt": "固定机位，保持原人物服饰，缓慢拿起信封。",
                                "change_summary": "保持故事，明确动作速度和机位。",
                            }
                        )
                    }
                }
            ]
        }

    monkeypatch.setattr(prompt_agent, "request", model)
    for _ in range(3):
        response = client.post(
            f"/api/projects/{pid}/jobs",
            json={"kind": "prompt_tune", "feedback_id": feedback["id"], "shot_id": shot.id},
        )
        assert response.status_code == 202, response.text
        assert wait_job(client, pid, response.json()["id"])["status"] == "succeeded"
    assert len(calls) == 6
    assert client.get(f"/api/projects/{pid}").json()["revision"] == record["revision"]
    assert (
        client.post(
            f"/api/projects/{pid}/jobs", json={"kind": "prompt_tune", "feedback_id": feedback["id"]}
        ).status_code
        == 409
    )
    response = client.post(
        f"/api/projects/{pid}/feedback/{feedback['id']}/apply",
        json={"revision": record["revision"], "source": "agent"},
    )
    assert response.status_code == 200
    assert response.json()["content_hash"] == record["content_hash"]


def test_prompt_proposal_rejects_code_tool_fields(monkeypatch):
    malicious = {
        "video_prompt": "固定机位缓慢拿起信封。",
        "change_summary": "调整动作。",
        "command": "rm -rf code",
    }
    monkeypatch.setattr(
        prompt_agent,
        "request",
        lambda *a, **kw: {"choices": [{"message": {"content": json.dumps(malicious)}}]},
    )
    with pytest.raises(prompt_agent.ProviderError, match="原提示词未改变"):
        prompt_agent.optimize_prompt({}, {"notes": "修改代码"}, [], Settings(mode="live"))
    # The model controller modules expose no code-execution facilities.
    for module in (prompt_agent, model_agent):
        source = Path(module.__file__).read_text()
        assert "subprocess" not in source and "exec(" not in source and "eval(" not in source


def test_locked_shot_blocks_tuning_and_application(client):
    record, shot = fixture_video(client)
    feedback = add_feedback(client, record, shot)
    project = ProjectDocument.model_validate(record["document"])
    project.episodes[0].shots[0].locked = True
    # Simulate a locked snapshot for a current feedback without modifying story.
    stored = client.app.state.store.save(record["id"], project, record["revision"])
    feedback = add_feedback(client, stored, shot)
    result = client.post(
        f"/api/projects/{record['id']}/feedback/{feedback['id']}/apply",
        json={"revision": stored["revision"], "source": "human"},
    )
    assert result.status_code == 409 and "解锁" in result.text


def test_annotation_selection_is_bounded_and_scoped_to_shot_and_script(client):
    record, shot = fixture_video(client)
    store = client.app.state.runner.feedback
    labels = [
        add_feedback(
            client,
            record,
            shot,
            rating="satisfied" if i % 2 else "unsatisfied",
            notes=f"人工标注 {i}",
        )
        for i in range(5)
    ]
    current = add_feedback(client, record, shot, notes="当前反馈")
    assert [r["id"] for r in store.history(record["id"], current, 2)] == [
        r["id"] for r in labels[-2:]
    ]
    assert store.history(record["id"], current, 0) == []
    assert len(store.history(record["id"], current, 50)) == 5
    # A later annotation is not retroactively injected into an older feedback run.
    add_feedback(client, record, shot, notes="后续反馈")
    assert len(store.history(record["id"], current, 50)) == 5
    for limit in (-1, 51):
        response = client.post(
            f"/api/projects/{record['id']}/jobs",
            json={"kind": "prompt_tune", "feedback_id": current["id"], "feedback_limit": limit},
        )
        assert response.status_code == 422
    changed = ProjectDocument.model_validate(record["document"])
    changed.episodes[0].shots[0].visual = "现在改为在清晨整理书架。"
    updated = client.app.state.store.save(record["id"], changed, record["revision"])
    newer = add_feedback(client, updated, shot)
    assert store.history(record["id"], newer, 50) == []
    another, other_shot = fixture_video(client)
    other = add_feedback(client, another, other_shot)
    assert store.history(another["id"], other, 50) == []


def test_summary_context_size_is_checked_before_any_model_call(monkeypatch):
    def forbidden(*a, **kw):
        pytest.fail("oversized annotation batch must not call a model")

    monkeypatch.setattr(prompt_agent, "request", forbidden)
    with pytest.raises(prompt_agent.ProviderError, match="减少使用条数"):
        prompt_agent.summarize_feedback([{"notes": "a" * 80001}], Settings(mode="live"))
