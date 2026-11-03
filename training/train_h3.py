"""Plan/run H3 LoRA with an external, version-checked DiffSynth backend."""

import argparse
import json
import shlex
import subprocess
from pathlib import Path


def build_commands(config, data, output, backend):
    trainer = str(backend / "examples/minimax_h3/model_training/train.py")
    common = [
        "accelerate",
        "launch",
        trainer,
        "--height",
        str(config["height"]),
        "--width",
        str(config["width"]),
        "--num_frames",
        str(config["num_frames"]),
        "--data_file_keys",
        "video,input_audio",
        "--extra_inputs",
        "input_audio",
        "--learning_rate",
        str(config["learning_rate"]),
        "--lora_base_model",
        "dit",
        "--lora_rank",
        str(config["rank"]),
        "--lora_target_modules",
        "attn.qkv_proj,attn.out_proj,mlp.fc1,mlp.fc2",
        "--remove_prefix_in_ckpt",
        "pipe.dit.",
        "--use_gradient_checkpointing",
    ]
    cache = output / "cache"
    preprocessing = common + [
        "--task",
        "sft:data_process",
        "--dataset_base_path",
        str(data),
        "--dataset_metadata_path",
        str(data / "train.csv"),
        "--dataset_repeat",
        "1",
        "--num_epochs",
        "1",
        "--model_id_with_origin_paths",
        config["encoder_weights"],
        "--output_path",
        str(cache),
    ]
    training = common + [
        "--task",
        "sft:train",
        "--dataset_base_path",
        str(cache),
        "--dataset_repeat",
        str(config["repeat"]),
        "--num_epochs",
        str(config["epochs"]),
        "--model_id_with_origin_paths",
        config["transformer_weights"],
        "--output_path",
        str(output / "adapter"),
        "--find_unused_parameters",
    ]
    return [preprocessing, training]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path(__file__).parent / "h3-lora.json")
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path(".data/training/h3-lora"))
    parser.add_argument(
        "--backend",
        type=Path,
        required=True,
        help="External DiffSynth checkout; never vendored into this repository",
    )
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    data, output, backend = args.data.resolve(), args.output.resolve(), args.backend.resolve()
    for split in ("train", "validation"):
        if not (data / f"{split}.csv").is_file():
            raise ValueError("先运行 prepare.py --target h3，生成训练和留出集")
    commands = build_commands(config, data, output, backend)
    for command in commands:
        print(shlex.join(command))
    if not args.execute:
        print("Dry run only. No weights downloaded and no training started.")
        return
    revision = subprocess.check_output(
        ["git", "-C", str(backend), "rev-parse", "HEAD"], text=True
    ).strip()
    if revision != config["backend_revision"]:
        raise ValueError("DiffSynth 版本与配置不一致，请检出配置中的 commit 后再训练")
    output.mkdir(parents=True, exist_ok=True)
    (output / "run.json").write_text(json.dumps({"config": config, "commands": commands}, indent=2))
    for command in commands:
        subprocess.run(command, cwd=backend, check=True)
    print("训练完成。必须在 validation.csv 上生成样本并进行独立评审，再决定是否启用该 LoRA。")


if __name__ == "__main__":
    main()
