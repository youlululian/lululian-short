import csv
import json
from pathlib import Path

import pytest

from training.evaluate import evaluate
from training.train_h3 import build_commands


def test_training_eval_does_not_hide_missing_predictions():
    labels = [{"id": "one", "review": {"verdict": "revise", "score": 40}}]
    with pytest.raises(ValueError):
        evaluate(labels, [])
    metrics = evaluate(labels, [{"id": "one", "review": {"verdict": "pass", "score": 90}}])
    assert metrics["verdict_accuracy"] == 0
    assert metrics["revise_recall"] == 0
    assert metrics["score_mae"] == 50


def test_h3_training_plan_separates_cache_and_training(tmp_path):
    config = json.loads(Path("training/h3-lora.json").read_text())
    first, second = build_commands(
        config, tmp_path / "data", tmp_path / "output", tmp_path / "backend"
    )
    assert "sft:data_process" in first and "sft:train" in second
    assert "--dataset_metadata_path" in first
    assert str(tmp_path / "output" / "cache") in second
    assert not any("validation" in arg for arg in first + second)


def test_training_entrypoints_dry_run_without_gpu(tmp_path):
    import subprocess
    import sys

    sample = {
        "id": "sample",
        "project_id": "train-project",
        "video": "not-loaded-in-dry-run.mp4",
        "prompt": "角色拿起信封",
        "origin": "user",
        "human_reviewed": True,
        "rights_confirmed": True,
        "review": {"verdict": "pass", "score": 90, "summary": "ok", "issues": []},
    }
    (tmp_path / "train.jsonl").write_text(json.dumps(sample))
    (tmp_path / "validation.jsonl").write_text(
        json.dumps({**sample, "project_id": "different-project"})
    )
    for split in ("train", "validation"):
        with (tmp_path / f"{split}.csv").open("w") as stream:
            writer = csv.writer(stream)
            writer.writerow(["video", "input_audio", "prompt"])
            writer.writerow(["clip.mp4", "clip.wav", "A character picks up a letter"])
    for entry, extra in [
        ("train_judge.py", []),
        ("train_h3.py", ["--backend", str(tmp_path / "external-backend")]),
    ]:
        result = subprocess.run(
            [sys.executable, "training/" + entry, "--data", str(tmp_path), *extra],
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert result.returncode == 0, result.stderr
        assert "dry run" in result.stdout.lower()
