from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def new_id() -> str:
    return uuid4().hex


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Character(Model):
    id: str = Field(default_factory=new_id, pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    name: str = Field(min_length=1, max_length=80)
    role: str = Field(default="主角", max_length=100)
    appearance: str = Field(default="", max_length=2000)
    motivation: str = Field(default="", max_length=2000)


class Shot(Model):
    id: str = Field(default_factory=new_id, pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    title: str = Field(default="新镜头", max_length=120)
    scene: str = Field(default="", max_length=1000)
    visual: str = Field(default="", max_length=4000)
    narration: str = Field(default="", max_length=2000)
    image_prompt: str = Field(default="", max_length=6000)
    camera: Literal["static", "push", "pull"] = "push"
    duration: float = Field(default=5, ge=1, le=30)
    characters: list[str] = Field(default_factory=list, max_length=20)
    locked: bool = False
    image: str | None = None
    audio: str | None = None
    video: str | None = None
    video_prompt: str = Field(default="", max_length=8000)
    use_video_audio: bool = True

    @field_validator("image", "audio", "video")
    @classmethod
    def safe_asset(cls, value):
        import re

        if value and not re.fullmatch(r"[a-f0-9]{32}\.(png|jpg|mp3|wav|mp4)", value):
            raise ValueError("无效素材名称")
        return value


class Episode(Model):
    id: str = Field(default_factory=new_id, pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    title: str = Field(min_length=1, max_length=120)
    synopsis: str = Field(default="", max_length=6000)
    hook: str = Field(default="", max_length=2000)
    shots: list[Shot] = Field(default_factory=list, max_length=60)


class ProjectInput(Model):
    title: str = Field(min_length=1, max_length=100)
    premise: str = Field(min_length=5, max_length=12000)
    genre: str = Field(default="悬疑", max_length=40)
    style: str = Field(default="电影感漫画", max_length=100)
    aspect: Literal["9:16", "16:9", "1:1"] = "9:16"
    episode_count: int = Field(default=1, ge=1, le=12)


class ProjectDocument(ProjectInput):
    approved_hash: str = ""
    characters: list[Character] = Field(default_factory=list, max_length=30)
    episodes: list[Episode] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def unique_identifiers(self):
        ids = [c.id for c in self.characters] + [e.id for e in self.episodes]
        ids += [s.id for e in self.episodes for s in e.shots]
        if len(ids) != len(set(ids)):
            raise ValueError("角色、剧集和镜头 ID 必须唯一")
        cast = {c.id for c in self.characters}
        if any(set(s.characters) - cast for e in self.episodes for s in e.shots):
            raise ValueError("分镜引用了不存在的角色")
        return self


class SaveProject(Model):
    revision: int = Field(ge=1)
    document: ProjectDocument


class JobInput(Model):
    kind: Literal[
        "script",
        "judge",
        "images",
        "voice",
        "render",
        "asset_check",
        "videos",
        "video_judge",
        "pipeline",
        "prompt_tune",
    ]
    episode_id: str | None = None
    shot_id: str | None = None
    overwrite: bool = False
    max_rounds: int = Field(default=2, ge=1, le=4)
    max_calls: int = Field(default=20, ge=1, le=100)
    feedback_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")
    export_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")


class ProviderConfig(Model):
    base_url: str = "https://api.openai.com/v1"
    api_key: str = Field(default="", max_length=2000)
    model: str = Field(default="", max_length=200)

    @field_validator("base_url")
    @classmethod
    def valid_url(cls, value):
        from urllib.parse import urlparse

        url = urlparse(value)
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
            raise ValueError("请输入 http(s) API 地址，凭据请填写在 API Key 字段")
        if url.query or url.fragment:
            raise ValueError("API 地址不能包含查询参数或片段")
        return value.rstrip("/")


class Settings(Model):
    mode: Literal["demo", "live"] = "demo"
    text: ProviderConfig = Field(default_factory=ProviderConfig)
    image: ProviderConfig = Field(default_factory=ProviderConfig)
    voice: ProviderConfig = Field(default_factory=ProviderConfig)
    judge: ProviderConfig = Field(default_factory=ProviderConfig)
    vision: ProviderConfig = Field(
        default_factory=lambda: ProviderConfig(
            base_url="http://127.0.0.1:8001/v1", model="Qwen/Qwen3-VL-8B-Instruct"
        )
    )
    vision_backend: Literal["local", "gemini"] = "local"
    video: ProviderConfig = Field(
        default_factory=lambda: ProviderConfig(
            base_url="http://127.0.0.1:30010/v1", model="MiniMax-H3"
        )
    )
    video_backend: Literal["local", "minimax"] = "local"
    video_resolution: Literal["480P", "768P", "2K"] = "768P"
    voice_name: str = Field(default="alloy", max_length=100)
