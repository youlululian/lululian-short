import json
from pathlib import Path

import pytest
from lululian import video, vision
from lululian.models import ProjectDocument, ProviderConfig, Settings, Shot
from lululian.providers import ProviderError


def base_review(**extra):
    return {"verdict": "pass", "score": 90, "summary": "画面符合分镜", "issues": [], **extra}


def mock_video(monkeypatch, tmp_path):
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"real-video-bytes")
    monkeypatch.setattr(vision, "media_duration", lambda p: 5)
    monkeypatch.setattr(
        vision, "run", lambda args: Path(args[-1]).write_bytes(b"proxy-video-bytes")
    )
    return path


def test_local_judge_sends_video_not_just_prompt(monkeypatch, tmp_path):
    path = mock_video(monkeypatch, tmp_path)
    calls = []

    def request(config, endpoint, payload):
        calls.append(payload)
        return {"choices": [{"message": {"content": json.dumps(base_review())}}]}

    monkeypatch.setattr(vision, "request", request)
    result = vision.judge_video(path, {"action": "拿起信"}, Settings(mode="live"))
    content = calls[0]["messages"][0]["content"]
    assert content[0]["type"] == "video_url"
    assert content[0]["video_url"]["url"].startswith("data:video/mp4;base64,")
    assert result["passed"] and result["audio_reviewed"] is False


def test_gemini_uses_native_media_and_header_key(monkeypatch, tmp_path):
    import httpx

    path = mock_video(monkeypatch, tmp_path)
    calls = []

    def post(url, **kwargs):
        calls.append((url, kwargs))
        return httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": json.dumps(base_review())}]}}]},
        )

    monkeypatch.setattr(vision.httpx, "post", post)
    config = Settings(
        mode="live",
        vision_backend="gemini",
        vision=ProviderConfig(
            base_url="https://generativelanguage.googleapis.com/v1beta",
            api_key="secret",
            model="test-gemini",
        ),
    )
    result = vision.judge_video(path, {"scene": "桌边"}, config)
    url, kwargs = calls[0]
    assert "secret" not in url
    assert kwargs["headers"]["x-goog-api-key"] == "secret"
    assert kwargs["json"]["contents"][0]["parts"][0]["inlineData"]["mimeType"] == "video/mp4"
    assert result["audio_reviewed"]


@pytest.mark.parametrize(
    "issue",
    [
        {"start": 0, "end": 8, "category": "action", "severity": "error", "evidence": "超时"},
        {
            "start": 0,
            "end": 1,
            "category": "audio",
            "severity": "error",
            "evidence": "视觉模型猜测音频",
        },
    ],
)
def test_invalid_judge_evidence_fails_closed(monkeypatch, tmp_path, issue):
    path = mock_video(monkeypatch, tmp_path)
    monkeypatch.setattr(
        vision,
        "request",
        lambda *a: {"choices": [{"message": {"content": json.dumps(base_review(issues=[issue]))}}]},
    )
    with pytest.raises(ProviderError, match="无效"):
        vision.judge_video(path, {}, Settings(mode="live"))


@pytest.mark.parametrize("backend", ["local", "minimax"])
def test_h3_submission_and_resume_without_double_post(monkeypatch, tmp_path, backend):
    calls = []

    def request(method, url, key, body=None):
        calls.append((method, url, body))
        if method == "POST":
            return {"id": "remote-task", "task_id": "remote-task"}
        return (
            {"status": "completed"}
            if backend == "local"
            else {
                "task": {"status": "succeeded", "content": {"url": "https://cdn.example/clip.mp4"}}
            }
        )

    monkeypatch.setattr(video, "http_json", request)
    monkeypatch.setattr(video, "download", lambda url, target, key="": target.write_bytes(b"video"))
    monkeypatch.setattr(video, "probe", lambda p: {"streams": [{"codec_type": "video"}]})
    monkeypatch.setattr("lululian.providers.public_media_url", lambda url: None)
    project = ProjectDocument(title="Test", premise="角色走进一家书店。")
    shot = Shot(visual="开门", duration=5)
    settings = Settings(
        mode="live",
        video_backend=backend,
        video=ProviderConfig(base_url="http://127.0.0.1/v1", model="MiniMax-H3", api_key="secret"),
    )
    video.generate_video(project, shot, settings, tmp_path, lambda msg: None)
    video.generate_video(project, shot, settings, tmp_path, lambda msg: None)
    assert len([x for x in calls if x[0] == "POST"]) == 1
    post = next(x for x in calls if x[0] == "POST")
    if backend == "minimax":
        assert post[2]["model"] == "MiniMax-H3"
        assert post[2]["content"][0]["type"] == "text"
    else:
        assert post[2]["task"] == "t2va"
