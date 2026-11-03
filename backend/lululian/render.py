import io
import json
import math
import shutil
import subprocess
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

from .models import new_id


def font(size):
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size=size)


def dimensions(aspect):
    return {"9:16": (720, 1280), "16:9": (1280, 720), "1:1": (960, 960)}[aspect]


def demo_image(shot, target, aspect):
    width, height = dimensions(aspect)
    image = Image.new("RGB", (width, height), "#111c23")
    draw = ImageDraw.Draw(image)
    for y in range(height):
        t = y / height
        draw.line((0, y, width, y), fill=(int(18 + 24 * t), int(32 + 35 * t), int(44 + 27 * t)))
    draw.ellipse(
        (width * 0.3, height * 0.12, width * 0.78, height * 0.12 + width * 0.48), fill="#a8b4a6"
    )
    for i in range(9):
        x = i * width / 8
        top = height * (0.5 + 0.10 * math.sin(i * 7))
        draw.rectangle((x, top, x + width / 10, height), fill=(15 + i, 26 + i, 32 + i))
    draw.text((42, 42), "LULULIAN / STORYBOARD", font=font(22), fill="#c9ac7f")
    draw.text((42, height * 0.68), shot.title, font=font(38), fill="#f5eee2")
    draw.text((42, height * 0.75), shot.scene, font=font(24), fill="#b7c6cc")
    draw.text((42, height - 70), "演示占位画面 · 非 AI 生成", font=font(22), fill="#94a4ac")
    image.save(target)


def normalize_image(data, target):
    with Image.open(io.BytesIO(data)) as image:
        if image.width * image.height > 40_000_000:
            raise ValueError("图片分辨率过大")
        image = ImageOps.exif_transpose(image).convert("RGB")
        image.thumbnail((4096, 4096))
        image.save(target, "PNG")


def run(args, timeout=240):
    try:
        result = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise RuntimeError("找不到 FFmpeg / ffprobe，请先安装后再合成") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("视频处理超时，请减少单集镜头数量后重试") from exc
    if result.returncode:
        raise RuntimeError("媒体处理失败，请确认素材可播放且 FFmpeg 支持 H.264/AAC")
    return result.stdout


def probe(path):
    return json.loads(
        run(
            ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
            30,
        )
    )


def media_duration(path):
    value = float(probe(path)["format"]["duration"])
    if not math.isfinite(value) or value <= 0 or value > 600:
        raise ValueError("素材时长应在 0 至 600 秒之间")
    return value


def subtitle_overlay(text, path, width, height):
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    size = max(24, int(width / 25))
    lines = textwrap.wrap(text.replace("\n", " "), width=max(10, int(width / size) - 4))
    # Voice length adjusts duration; show all lines rather than silently truncating dialogue.
    if len(lines) > 5:
        size = max(16, int(size * 5 / len(lines)))
        lines = textwrap.wrap(text.replace("\n", " "), width=max(10, int(width / size) - 4))
    y = height - len(lines) * (size + 10) - 70
    for line in lines:
        box = draw.textbbox((0, 0), line, font=font(size))
        x = (width - (box[2] - box[0])) / 2
        draw.text((x, y), line, font=font(size), fill="white", stroke_width=2, stroke_fill="black")
        y += size + 10
    layer.save(path)


def srt_timestamp(seconds):
    millis = round(seconds * 1000)
    hours, millis = divmod(millis, 3600000)
    minutes, millis = divmod(millis, 60000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


def render_episode(project, episode, directory, progress):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError("请先安装 FFmpeg，macOS 可运行 brew install ffmpeg")
    if not episode.shots:
        raise ValueError("该集还没有分镜")
    if any(not s.image and not s.video for s in episode.shots):
        raise ValueError("请先为本集每个镜头生成或上传图片／视频")
    export_id = new_id()
    work = directory / f"render-{export_id}"
    work.mkdir()
    width, height = dimensions(project.aspect)
    parts, subtitles, elapsed = [], [], 0.0
    try:
        for index, shot in enumerate(episode.shots):
            duration = shot.duration
            if shot.audio:
                duration = max(duration, media_duration(directory / shot.audio) + 0.15)
            if duration > 120:
                raise ValueError("单镜头配音过长，请拆分至 120 秒以内")
            source = directory / (shot.video or shot.image)
            overlay = work / f"sub-{index}.png"
            subtitle_overlay(shot.narration, overlay, width, height)
            args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
            if shot.video:
                args += ["-stream_loop", "-1", "-i", str(source)]
                visual_filter = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1,fps=24"
            else:
                args += ["-loop", "1", "-framerate", "24", "-i", str(source)]
                zoom = {
                    "static": "1",
                    "push": "min(1.12,1+on*0.0003)",
                    "pull": "max(1,1.12-on*0.0003)",
                }[shot.camera]
                visual_filter = (
                    f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},"
                    f"zoompan=z='{zoom}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s={width}x{height}:fps=24,setsar=1"
                )
            args += ["-loop", "1", "-i", str(overlay)]
            if shot.audio:
                args += ["-i", str(directory / shot.audio)]
            else:
                args += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
            output = work / f"clip-{index}.mp4"
            args += [
                "-filter_complex",
                f"[0:v]{visual_filter}[v];[v][1:v]overlay=0:0[out];[2:a]apad[a]",
                "-map",
                "[out]",
                "-map",
                "[a]",
                "-t",
                str(duration),
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-r",
                "24",
                "-c:a",
                "aac",
                "-ar",
                "44100",
                "-ac",
                "2",
                "-movflags",
                "+faststart",
                str(output),
            ]
            run(args)
            parts.append(output)
            if shot.narration:
                subtitles.append(
                    f"{len(subtitles) + 1}\n{srt_timestamp(elapsed)} --> {srt_timestamp(elapsed + duration)}\n{shot.narration}\n"
                )
            elapsed += duration
            progress(
                round((index + 1) / len(episode.shots) * 90),
                f"已合成 {index + 1}/{len(episode.shots)} 个镜头",
            )
        listing = work / "concat.txt"
        listing.write_text("\n".join(f"file '{p.name}'" for p in parts))
        filename = f"{export_id}.mp4"
        run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "concat",
                "-safe",
                "1",
                "-i",
                str(listing),
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                str(directory / filename),
            ]
        )
        subtitle_name = f"{export_id}.srt"
        (directory / subtitle_name).write_text("\n".join(subtitles), encoding="utf-8")
        return {
            "video": filename,
            "subtitles": subtitle_name,
            "duration": round(elapsed, 2),
            "episode_id": episode.id,
            "demo": any("演示" in ep.title for ep in project.episodes),
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)
