import hashlib
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from lululian import judge, pipeline, prompt_agent, providers, vision
from lululian.main import create_app
from lululian.models import ProjectDocument, Settings
from lululian.prompt_profiles import PipelinePrompts
from lululian.video import video_prompt


def test_legacy_approval_and_custom_profile_fingerprints():
    project = providers.demo_script(ProjectDocument(title="测试", premise="寻找明天的来信"))
    old = judge.creative_document(project)
    fingerprint = hashlib.sha256(
        json.dumps(old, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()
    assert judge.content_hash(project) == fingerprint
    project.pipeline_prompts.video = "固定镜头，动作放慢"
    assert judge.content_hash(project) != fingerprint
    project.pipeline_prompts = PipelinePrompts()
    assert judge.content_hash(project) == fingerprint


def test_profile_api_history_approval_and_job_snapshot(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        store = client.app.state.store
        document = providers.demo_script(ProjectDocument(title="测试", premise="寻找明天的来信"))
        document.approved_hash = judge.content_hash(document)
        row = store.create(document)
        url = f"/api/projects/{row['id']}"
        defaults = client.get("/api/prompt-defaults").json()
        document.pipeline_prompts.script_judge = "重点检查每个转折是否有前文伏笔"
        response = client.put(url, json={"revision": 1, "document": document.model_dump()})
        assert response.status_code == 200
        assert response.json()["content_hash"] != document.approved_hash
        assert client.post(url + "/jobs", json={"kind": "images"}).status_code == 409
        assert (
            client.put(url, json={"revision": 1, "document": document.model_dump()}).status_code
            == 409
        )
        for invalid in ({"script": " "}, {"script": "x" * 4001}, {"command": "shell"}):
            bad = document.model_dump()
            bad["pipeline_prompts"] = invalid
            assert client.put(url, json={"revision": 2, "document": bad}).status_code == 422
        job = client.post(url + "/jobs", json={"kind": "judge"}).json()
        for _ in range(200):
            jobs = client.get(url + "/jobs").json()
            if jobs[0]["status"] not in ("queued", "running"):
                break
            time.sleep(0.01)
        assert jobs[0]["status"] == "succeeded"
        events = client.get(url + f"/jobs/{job['id']}/events").json()
        profile = next(e["data"] for e in events if e["kind"] == "pipeline_prompt_profile")
        assert profile["prompts"] == document.pipeline_prompts.model_dump()
        assert client.post(url + "/approve").status_code == 200
        history = client.get(url + "/prompt-history").json()
        assert len(history) == 2
        assert history[0]["revision"] == 2 and history[1]["prompts"] == defaults
        current = client.get(url).json()
        current["document"]["pipeline_prompts"] = history[1]["prompts"]
        restored = client.put(
            url, json={"revision": current["revision"], "document": current["document"]}
        )
        assert restored.status_code == 200
        assert restored.json()["document"]["pipeline_prompts"] == defaults
        assert len(client.get(url + "/prompt-history").json()) == 3


def test_custom_instructions_reach_text_and_media_adapters(monkeypatch, tmp_path):
    project = providers.demo_script(ProjectDocument(title="测试", premise="寻找明天的来信"))
    for key in PipelinePrompts.model_fields:
        setattr(project.pipeline_prompts, key, f"定制阶段要求-{key}")
    settings = Settings(mode="live")
    shot = project.episodes[0].shots[0]
    pending = []

    def request(config, endpoint, payload):
        expected, output = pending.pop(0)
        assert expected in json.dumps(payload, ensure_ascii=False)
        assert "tools" not in payload
        if endpoint == "images/generations":
            return {"data": [{"b64_json": "eA=="}]}
        assert payload["response_format"] == {"type": "json_object"}
        assert "固定输出与权限约束" in payload["messages"][0]["content"]
        return {"choices": [{"message": {"content": json.dumps(output)}}]}

    for module in (providers, judge, pipeline, prompt_agent):
        monkeypatch.setattr(module, "request", request)
    pending.append(
        (project.pipeline_prompts.script, project.model_dump(include={"characters", "episodes"}))
    )
    assert providers.generate_script(project, settings).pipeline_prompts == project.pipeline_prompts
    pending.append(
        (project.pipeline_prompts.script_judge, {"score": 90, "summary": "通过", "findings": []})
    )
    judge.review_script(project, settings)
    pending.append(
        (
            project.pipeline_prompts.feedback_summary,
            {"retain_rules": [], "avoid_rules": [], "optimization_rules": ["放慢动作"]},
        )
    )
    summary = prompt_agent.summarize_feedback(
        [], settings, instructions=project.pipeline_prompts.feedback_summary
    )
    proposal = {"video_prompt": "固定镜头，慢慢打开来信", "change_summary": "放慢动作"}
    pending.append((project.pipeline_prompts.prompt_tune, proposal))
    prompt_agent.optimize_prompt(
        {}, {}, summary, settings, instructions=project.pipeline_prompts.prompt_tune
    )
    pending.append((project.pipeline_prompts.video_repair, proposal))
    pipeline.revise_prompt(project, shot, {}, settings)
    pending.append((project.pipeline_prompts.image, {}))
    monkeypatch.setattr("lululian.render.normalize_image", lambda *args: None)
    providers.generate_image(project, shot, settings, tmp_path)
    shot.video_prompt = "单镜头自定义动作"
    assert project.pipeline_prompts.video in video_prompt(project, shot)
    assert shot.video_prompt in video_prompt(project, shot)
    assert not pending


def test_video_judge_keeps_validation_with_custom_instructions(monkeypatch, tmp_path):
    path = tmp_path / "video.mp4"
    path.write_bytes(b"fixture")
    monkeypatch.setattr(vision, "media_duration", lambda p: 5)
    monkeypatch.setattr(vision, "run", lambda args: Path(args[-1]).write_bytes(b"proxy"))

    def request(config, endpoint, payload):
        text = payload["messages"][0]["content"][-1]["text"]
        assert "检查手部动作" in text and "固定输出与权限约束" in text
        assert "不允许评价读音" in text
        # Custom instructions do not bypass visual-only evidence validation.
        result = {
            "verdict": "pass",
            "score": 90,
            "summary": "通过",
            "issues": [
                {
                    "start": 0,
                    "end": 1,
                    "category": "audio",
                    "severity": "info",
                    "evidence": "听到声音",
                }
            ],
        }
        return {"choices": [{"message": {"content": json.dumps(result)}}]}

    monkeypatch.setattr(vision, "request", request)
    with pytest.raises(providers.ProviderError, match="不支持的音频判断"):
        vision.judge_video(path, {}, Settings(mode="live"), instructions="检查手部动作")
