"""Bounded model configuration controller. No generated code, shell or arbitrary tools.

The loop is a deterministic state machine: inspect -> discover -> select -> verify -> save.
Remote responses are data; only fixed, read-only provider endpoints are accessible.
"""

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from threading import RLock
from typing import Literal

import httpx
from fastapi import HTTPException
from pydantic import Field, SecretStr

from .models import Model, ProviderConfig, new_id
from .providers import load_settings, public_settings, save_settings
from .store import now


class SetupCredential(Model):
    api_key: SecretStr = Field(default_factory=lambda: SecretStr(""), max_length=2000)
    model: str = Field(default="", max_length=200, pattern=r"^[a-zA-Z0-9_./:-]*$")


class SetupInput(Model):
    profile: Literal["cloud", "local", "hybrid"] = "cloud"
    local_host: Literal["127.0.0.1", "host.docker.internal"] = "127.0.0.1"
    text_port: int = Field(default=8002, ge=1024, le=65535)
    vision_port: int = Field(default=8001, ge=1024, le=65535)
    video_port: int = Field(default=30010, ge=1024, le=65535)
    text: SetupCredential = Field(default_factory=SetupCredential)
    vision: SetupCredential = Field(default_factory=SetupCredential)
    video: SetupCredential = Field(default_factory=SetupCredential)


class ProbeError(Exception):
    def __init__(self, message, retryable=False):
        super().__init__(message)
        self.retryable = retryable


def read_catalog(url, key, gemini=False):
    headers = (
        {"x-goog-api-key": key} if gemini else {"Authorization": f"Bearer {key}"} if key else {}
    )
    started = time.monotonic()
    try:
        # No redirects, proxies, arbitrary methods or response-provided URLs.
        with httpx.Client(
            timeout=httpx.Timeout(12, connect=5), follow_redirects=False, trust_env=False
        ) as client:
            with client.stream("GET", url, headers=headers) as response:
                code = response.status_code
                if code in (401, 403):
                    raise ProbeError("密钥无效或没有访问权限，请更新对应 Key。")
                if code == 429:
                    raise ProbeError("服务商限流，请稍后重试。")
                if code >= 500:
                    raise ProbeError("服务暂时不可用。", retryable=True)
                if not response.is_success:
                    raise ProbeError(f"检测接口返回 HTTP {code}，请检查模型服务版本和部署端口。")
                content = bytearray()
                for chunk in response.iter_bytes():
                    if time.monotonic() - started > 15:
                        raise ProbeError("模型服务响应过慢，请稍后重试。")
                    content.extend(chunk)
                    if len(content) > 1024 * 1024:
                        raise ProbeError("模型服务返回的数据超出检测大小限制。")
        value = json.loads(content)
        if not isinstance(value, dict):
            raise ProbeError("模型服务未返回预期的对象。")
        return value
    except (httpx.TimeoutException, httpx.ConnectError) as exc:
        raise ProbeError("无法连接模型服务，请检查网络或启动本地模型。", retryable=True) from exc
    except (httpx.HTTPError, ValueError) as exc:
        raise ProbeError("检测响应无效，请检查服务是否支持对应协议。") from exc


def select_model(data, requested, role, gemini=False, secret=""):
    rows = data.get("models" if gemini else "data")
    if not isinstance(rows, list):
        raise ProbeError("服务未提供可识别的模型列表；请在高级设置中手动配置。")
    candidates = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        model = item.get("name" if gemini else "id", "")
        if not isinstance(model, str):
            continue
        if gemini:
            model = model.removeprefix("models/")
            if "generateContent" not in item.get("supportedGenerationMethods", []):
                continue
        if not re.fullmatch(r"[a-zA-Z0-9_./:-]{1,200}", model) or (secret and secret in model):
            continue
        candidates.append(model)
    if requested:
        if requested not in candidates:
            raise ProbeError("指定模型不在当前服务的模型列表中；清空模型名称后可尝试自动选择。")
        return requested
    eligible = candidates
    if role == "vision":
        eligible = [
            m
            for m in candidates
            if (
                (
                    "gemini" in m.lower()
                    and not any(
                        x in m.lower() for x in ("image", "tts", "audio", "live", "embedding")
                    )
                )
                if gemini
                else ("vl" in m.lower() or "vision" in m.lower())
            )
        ]
    elif role == "video":
        eligible = [m for m in candidates if "h3" in m.lower()]
    else:
        eligible = [
            m for m in candidates if not any(x in m.lower() for x in ("embedding", "rerank", "tts"))
        ]
    if not eligible:
        raise ProbeError("没有找到适合此步骤的模型，请手动指定模型名称。")
    # Prefer chat/Flash models without assuming a permanently valid provider model ID.
    return sorted(
        eligible,
        key=lambda m: (
            not any(x in m.lower() for x in ("chat", "flash")),
            "preview" in m.lower(),
            len(m),
            m,
        ),
    )[0]


class ModelAgent:
    def __init__(self, store):
        self.store = store
        self.lock = RLock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="model-setup")
        with store.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS model_setup_runs (
                id TEXT PRIMARY KEY, status TEXT NOT NULL, profile TEXT NOT NULL,
                steps TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL)""")
            db.execute(
                "UPDATE model_setup_runs SET status='failed', message=? WHERE status IN ('running','cancelling')",
                ("服务曾中断；未完成的配置不会自动应用，请重新检测。",),
            )

    def runs(self):
        with self.store.connect() as db:
            rows = db.execute(
                "SELECT * FROM model_setup_runs ORDER BY created_at DESC LIMIT 20"
            ).fetchall()
        return [{**dict(row), "steps": json.loads(row["steps"])} for row in rows]

    def ensure_idle(self):
        self.ensure_no_setup()
        with self.store.connect() as db:
            if db.execute("SELECT 1 FROM jobs WHERE status IN ('queued','running')").fetchone():
                raise HTTPException(409, "有制作任务正在运行，请完成后再修改模型设置。")

    def ensure_no_setup(self):
        with self.store.connect() as db:
            if db.execute(
                "SELECT 1 FROM model_setup_runs WHERE status IN ('running','cancelling')"
            ).fetchone():
                raise HTTPException(409, "配置助手正在运行，请等待完成或停止后再操作。")

    def start(self, task):
        with self.lock:
            self.ensure_idle()
            rid = new_id()
            with self.store.connect() as db:
                db.execute(
                    "INSERT INTO model_setup_runs VALUES (?,?,?,?,?,?,?)",
                    (rid, "running", task.profile, "[]", "准备配置方案", now(), now()),
                )
            self.executor.submit(self.execute, rid, task)
        return {"id": rid, "status": "running"}

    def update(self, rid, status, steps, message):
        with self.store.connect() as db:
            db.execute(
                "UPDATE model_setup_runs SET status=CASE WHEN status='cancelling' AND ?='running' THEN status ELSE ? END, steps=?, message=?, updated_at=? WHERE id=?",
                (status, status, json.dumps(steps, ensure_ascii=False), message, now(), rid),
            )

    def cancelled(self, rid):
        with self.store.connect() as db:
            row = db.execute("SELECT status FROM model_setup_runs WHERE id=?", (rid,)).fetchone()
        return not row or row[0] == "cancelling"

    def cancel(self, rid):
        with self.lock, self.store.connect() as db:
            row = db.execute("SELECT status FROM model_setup_runs WHERE id=?", (rid,)).fetchone()
            if not row:
                raise HTTPException(404, "配置任务不存在")
            if row[0] == "running":
                db.execute(
                    "UPDATE model_setup_runs SET status='cancelling', message=? WHERE id=?",
                    ("正在停止，等待当前只读检测结束；不会应用配置。", rid),
                )
        return {"status": "cancelling" if row[0] == "running" else row[0]}

    def execute(self, rid, task):
        steps = []
        try:
            old = load_settings(self.store.root)
            candidate = old.model_copy(deep=True)
            cloud = task.profile == "cloud"
            cloud_text = task.profile != "local"
            addresses = {
                "text": "https://api.deepseek.com"
                if cloud_text
                else f"http://{task.local_host}:{task.text_port}/v1",
                "vision": "https://generativelanguage.googleapis.com/v1beta"
                if cloud
                else f"http://{task.local_host}:{task.vision_port}/v1",
                "video": "https://api.minimax.io/v2"
                if cloud
                else f"http://{task.local_host}:{task.video_port}/v1",
            }
            for role, label in (
                ("text", "剧本生产与剧本 Judge"),
                ("vision", "视频 Judge"),
                ("video", "H3 视频生产"),
            ):
                if self.cancelled(rid):
                    self.update(rid, "cancelled", steps, "已停止，原模型配置保持不变。")
                    return
                entry = {
                    "role": role,
                    "label": label,
                    "status": "running",
                    "attempts": 0,
                    "message": "检查凭据与模型列表",
                    "base_url": addresses[role],
                }
                steps.append(entry)
                self.update(rid, "running", steps, f"正在检测：{label}")
                credential = getattr(task, role)
                previous = getattr(old, role)
                key = credential.api_key.get_secret_value() or (
                    previous.api_key if previous.base_url == addresses[role] else ""
                )
                needs_key = cloud if role != "text" else cloud_text
                if needs_key and not key:
                    entry.update(
                        status="failed", message="请填写此服务商的 API Key；未检测，也未保存配置。"
                    )
                    continue
                requested = credential.model
                # Never return credential-shaped input via model name or diagnostics.
                if key and key in requested:
                    entry.update(status="failed", message="模型名称不能包含密钥。")
                    continue
                for attempt in range(2):
                    entry["attempts"] = attempt + 1
                    try:
                        if cloud and role == "video":
                            data = read_catalog(
                                addresses[role] + "/query/video_generation?page_num=1&page_size=1",
                                key,
                            )
                            if not isinstance(data.get("items"), list):
                                raise ProbeError("视频服务未返回有效任务列表，请检查账户权限。")
                            if requested and requested != "MiniMax-H3":
                                raise ProbeError("此配置方案仅接入 MiniMax-H3 视频模型。")
                            model = "MiniMax-H3"
                        else:
                            data = read_catalog(
                                addresses[role] + "/models", key, cloud and role == "vision"
                            )
                            model = select_model(
                                data, requested, role, cloud and role == "vision", key
                            )
                        if self.cancelled(rid):
                            self.update(rid, "cancelled", steps, "已停止，原模型配置保持不变。")
                            return
                        setattr(
                            candidate,
                            role,
                            ProviderConfig(base_url=addresses[role], api_key=key, model=model),
                        )
                        entry.update(
                            status="succeeded",
                            model=model,
                            message="接口检测通过；已选择模型。生成效果与模型能力仍需实际任务验证。",
                        )
                        break
                    except ProbeError as exc:
                        entry.update(status="failed", message=str(exc))
                        if not exc.retryable or attempt == 1:
                            break
                        entry.update(status="running", message="连接暂时失败，自动重试一次。")
                        self.update(rid, "running", steps, f"正在重试：{label}")
                self.update(
                    rid,
                    "cancelling" if self.cancelled(rid) else "running",
                    steps,
                    f"已检测：{label}",
                )
            with self.lock:
                if self.cancelled(rid):
                    self.update(rid, "cancelled", steps, "已停止，原模型配置保持不变。")
                    return
                if any(s["status"] != "succeeded" for s in steps):
                    self.update(
                        rid, "failed", steps, "仍有配置需要处理，原设置未改变。修正后重新运行助手。"
                    )
                    return
                candidate.judge = candidate.text.model_copy(deep=True)
                candidate.vision_backend = "gemini" if cloud else "local"
                candidate.video_backend = "minimax" if cloud else "local"
                candidate.mode = "live"
                save_settings(self.store.root, candidate)
                self.update(
                    rid,
                    "succeeded",
                    steps,
                    "配置已保存并切换真实模式。请返回作品，从剧本生产开始；未自动调用任何生成接口。",
                )
        except Exception:
            self.update(
                rid, "failed", steps, "配置助手执行失败，未完成的检测不可作为可用依据，请重试。"
            )

    def shutdown(self):
        for run in self.runs():
            if run["status"] == "running":
                self.cancel(run["id"])
        self.executor.shutdown(wait=True, cancel_futures=True)

    def settings(self):
        return public_settings(load_settings(self.store.root))
