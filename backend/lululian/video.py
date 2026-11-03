"""H3 adapters. Remote task IDs are persisted before polling to avoid accidental resubmission."""

import base64
import hashlib
import json
import math
import time
from urllib.parse import quote

import httpx

from .models import new_id
from .providers import ProviderError
from .render import probe


def http_json(method, url, key, body=None):
    try:
        with httpx.Client(timeout=60, follow_redirects=False) as client:
            response = client.request(
                method, url, headers={"Authorization": f"Bearer {key}"} if key else {}, json=body
            )
        if not response.is_success:
            raise ProviderError(f"视频服务返回 HTTP {response.status_code}")
        return response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise ProviderError(
            "视频服务连接失败或响应格式无效。提交超时可能已创建远程任务，请先检查服务商任务记录"
        ) from exc


def download(url, target, key=""):
    try:
        with httpx.stream(
            "GET",
            url,
            headers={"Authorization": f"Bearer {key}"} if key else {},
            timeout=120,
            follow_redirects=False,
        ) as response:
            if not response.is_success:
                raise ProviderError(f"视频下载返回 HTTP {response.status_code}")
            total = 0
            with target.open("wb") as stream:
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > 200 * 1024 * 1024:
                        raise ProviderError("生成视频超过 200 MB 限制")
                    stream.write(chunk)
    except httpx.HTTPError as exc:
        raise ProviderError("生成视频下载失败，可重试下载已有任务") from exc


def video_prompt(project, shot):
    cast = "；".join(
        f"{c.name}：{c.appearance}" for c in project.characters if c.id in shot.characters
    )
    return (
        shot.video_prompt
        or f"风格：{project.style}。场景：{shot.scene}。角色：{cast}。画面：{shot.visual}。运镜：{shot.camera}。对白/旁白：{shot.narration}。"
    )


def generate_video(project, shot, settings, directory, progress, nonce=""):
    if settings.mode != "live":
        raise ProviderError("H3 视频生成需要真实模式和已配置的本地服务或 API")
    config = settings.video
    local = settings.video_backend == "local"
    if not local and not config.api_key:
        raise ProviderError("请先配置 MiniMax API Key")
    if not 4 <= shot.duration <= 15:
        raise ProviderError("H3 单镜头时长需要在 4–15 秒之间，请先修改并重新确认剧本")
    prompt = video_prompt(project, shot)
    duration = math.ceil(shot.duration)
    base = config.base_url.rstrip("/")
    if local:
        body = {
            "task": "t2va",
            "prompt": prompt,
            "conditions": [],
            "target": {
                "short_edge": 768,
                "aspect_ratio": project.aspect,
                "duration_seconds": duration,
            },
            "seed": 42,
        }
        create_url = f"{base}/videos"
    else:
        content = [{"type": "text", "text": prompt}]
        if shot.image:
            encoded = base64.b64encode((directory / shot.image).read_bytes()).decode()
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{encoded}"},
                    "role": "first_frame",
                }
            )
        body = {
            "model": config.model,
            "content": content,
            "resolution": settings.video_resolution,
            "duration": duration,
            "ratio": project.aspect,
        }
        create_url = f"{base}/video_generation"
    # A deliberate regeneration has a new nonce; a process restart resumes the existing request.
    fingerprint = hashlib.sha256(
        json.dumps([base, body, nonce], sort_keys=True).encode()
    ).hexdigest()
    journal = directory / f"task-{fingerprint}.json"
    if journal.exists():
        state = json.loads(journal.read_text())
        task_id = state["task_id"]
    else:
        response = http_json("POST", create_url, config.api_key, body)
        task_id = response.get("id") if local else response.get("task_id")
        if not task_id:
            raise ProviderError("视频服务未返回任务 ID")
        state = {"task_id": str(task_id), "backend": settings.video_backend, "model": config.model}
        temporary = journal.with_suffix(".tmp")
        temporary.write_text(json.dumps(state))
        temporary.replace(journal)
    escaped = quote(str(task_id), safe="")
    status_url = f"{base}/videos/{escaped}" if local else f"{base}/query/video_generation/{escaped}"
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        status = http_json("GET", status_url, config.api_key)
        status = status if local else status.get("task", {})
        phase = str(status.get("status", "")).lower()
        progress(f"MiniMax H3 · {phase or '等待中'} · 任务 {task_id}")
        if phase in {"completed", "succeeded", "success"}:
            filename = f"{new_id()}.mp4"
            target = directory / filename
            if local:
                download(f"{base}/videos/{escaped}/content", target, config.api_key)
            else:
                from .providers import public_media_url

                url = status.get("content", {}).get("url", "")
                public_media_url(url)
                download(url, target)
            metadata = probe(target)
            if not any(s.get("codec_type") == "video" for s in metadata["streams"]):
                target.unlink(missing_ok=True)
                raise ProviderError("H3 返回结果没有有效视频流")
            return filename
        if phase in {"failed", "cancelled", "canceled", "expired"}:
            journal.unlink(missing_ok=True)
            raise ProviderError(f"H3 任务 {task_id} 已{phase}，检查服务商任务详情后重试")
        time.sleep(3)
    raise ProviderError(f"H3 任务 {task_id} 仍未完成；重试会继续查询该任务，不重新提交")
