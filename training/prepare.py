"""Validate human-curated records and prepare leak-free splits for H3 and Qwen Judge."""

import argparse
import csv
import hashlib
import json
import shutil
import subprocess
from pathlib import Path


def prepare(source: Path, output: Path, target: str):
    records = [json.loads(line) for line in source.read_text().splitlines() if line.strip()]
    prepared = {"train": [], "validation": []}
    hashes = set()
    output.mkdir(parents=True, exist_ok=True)
    media_dir = output / "media"
    media_dir.mkdir(exist_ok=True)
    for record in records:
        if record.get("human_reviewed") is not True or record.get("rights_confirmed") is not True:
            raise ValueError("每条记录必须经过人工确认，并明确训练使用权")
        if not record.get("project_id") or not record.get("prompt"):
            raise ValueError("缺少 project_id 或 prompt")
        if target == "judge" and record.get("origin") == "minimax_h3":
            raise ValueError(
                "H3 产物不得默认用于训练非 H3 模型；请使用具有相应权利的真实拍摄或其他来源数据"
            )
        video = Path(record["video"])
        if not video.is_absolute():
            video = source.parent / video
        if not video.is_file():
            raise ValueError(f"视频不存在：{video}")
        digest = hashlib.sha256(video.read_bytes()).hexdigest()
        if digest in hashes:
            raise ValueError("发现重复视频，避免同一素材重复进入训练数据")
        hashes.add(digest)
        metadata = json.loads(
            subprocess.check_output(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_format",
                    "-show_streams",
                    "-of",
                    "json",
                    str(video),
                ]
            )
        )
        duration = float(metadata["format"]["duration"])
        if not 4 <= duration <= 15:
            raise ValueError("训练片段需预先裁剪至 4–15 秒")
        # All shots of the same project share a split; do not leak near-duplicate characters/scenes.
        bucket = int(hashlib.sha256(record["project_id"].encode()).hexdigest()[:8], 16) % 5
        split = "validation" if bucket == 0 else "train"
        destination = media_dir / f"{digest}.mp4"
        shutil.copyfile(video, destination)
        item = {
            "id": digest,
            "project_id": record["project_id"],
            "video": str(destination.resolve()),
            "prompt": record["prompt"],
            "origin": record.get("origin", "user"),
            "human_reviewed": True,
            "rights_confirmed": True,
        }
        if target == "judge":
            label = record.get("review")
            if not isinstance(label, dict) or label.get("verdict") not in {
                "pass",
                "revise",
                "uncertain",
            }:
                raise ValueError("Judge 训练需要人工修订过的 review 标签")
            if not isinstance(label.get("score"), int) or not 0 <= label["score"] <= 100:
                raise ValueError("Judge 标签需有 0–100 整数 score")
            if not label.get("summary") or not isinstance(label.get("issues"), list):
                raise ValueError("Judge 标签缺少 summary 或 issues")
            item["review"] = label
        else:
            if record.get("accepted") is not True:
                raise ValueError("H3 生成模型只接收人工验收通过的素材")
            if not any(s.get("codec_type") == "audio" for s in metadata["streams"]):
                raise ValueError("H3 音视频联合训练需要带音轨的素材")
            audio = destination.with_suffix(".wav")
            subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(destination),
                    "-vn",
                    "-ar",
                    "32000",
                    "-ac",
                    "2",
                    str(audio),
                ],
                check=True,
            )
            item["input_audio"] = str(audio.resolve())
        prepared[split].append(item)
    if not prepared["train"] or not prepared["validation"]:
        raise ValueError(
            "数据必须覆盖训练集与验证集。请增加不同 project_id 的真实项目，不要复制同一项目凑数"
        )
    for split, items in prepared.items():
        (output / f"{split}.jsonl").write_text(
            "\n".join(json.dumps(x, ensure_ascii=False) for x in items) + "\n"
        )
        if target == "h3":
            with (output / f"{split}.csv").open("w", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=["video", "input_audio", "prompt"])
                writer.writeheader()
                writer.writerows({k: item[k] for k in writer.fieldnames} for item in items)
    summary = {
        "target": target,
        "train": len(prepared["train"]),
        "validation": len(prepared["validation"]),
        "split_unit": "project_id",
        "input_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    }
    (output / "manifest.json").write_text(json.dumps(summary, indent=2))
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target", choices=["h3", "judge"], required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source, args.output, args.target), indent=2))
