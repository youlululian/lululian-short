"""LoRA SFT for a local Qwen3-VL video judge. Batch size 1; assistant-only loss."""

import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--model", default="Qwen/Qwen3-VL-8B-Instruct")
    parser.add_argument("--output", type=Path, default=Path(".data/training/judge-lora"))
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument(
        "--execute", action="store_true", help="Actually load model weights and train on GPU"
    )
    args = parser.parse_args()
    rows = [
        json.loads(line) for line in (args.data / "train.jsonl").read_text().splitlines() if line
    ]
    validation = [
        json.loads(line)
        for line in (args.data / "validation.jsonl").read_text().splitlines()
        if line
    ]
    if (
        not rows
        or not validation
        or any(
            not r.get("human_reviewed") or not r.get("rights_confirmed") for r in rows + validation
        )
    ):
        raise ValueError("训练与验证集必须非空且经人工确认")
    if {r["project_id"] for r in rows} & {r["project_id"] for r in validation}:
        raise ValueError("训练与验证项目重叠")
    if any(r.get("origin") == "minimax_h3" for r in rows + validation):
        raise ValueError("不能将 H3 产物用于训练非 H3 模型")
    plan = {
        **vars(args),
        "data": str(args.data),
        "output": str(args.output),
        "train_samples": len(rows),
        "validation_samples": len(validation),
    }
    print(json.dumps(plan, indent=2))
    if not args.execute:
        print("Dry run complete. Add --execute on a CUDA training machine to start.")
        return
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForImageTextToText, AutoProcessor, Trainer, TrainingArguments

    if not torch.cuda.is_available():
        raise RuntimeError("此训练入口要求 CUDA GPU；当前机器没有可用 CUDA")
    processor = AutoProcessor.from_pretrained(args.model)
    model = AutoModelForImageTextToText.from_pretrained(args.model, torch_dtype=torch.bfloat16)
    model = get_peft_model(
        model,
        LoraConfig(
            r=args.rank,
            lora_alpha=args.rank * 2,
            lora_dropout=0.05,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
            task_type="CAUSAL_LM",
        ),
    )
    # Freeze visual encoder even if its projection names matched the LoRA selector.
    for name, parameter in model.named_parameters():
        if "visual" in name:
            parameter.requires_grad = False
    model.enable_input_require_grads()
    model.config.use_cache = False

    def collate(batch):
        row = batch[0]
        conversation = [
            {
                "role": "user",
                "content": [
                    {"type": "video", "video": row["video"], "fps": 2, "max_pixels": 256 * 28 * 28},
                    {
                        "type": "text",
                        "text": "对照以下分镜检查实际视频，只返回 verdict、score、summary、issues 的 JSON。仅评画面，不评音轨。\n"
                        + row["prompt"],
                    },
                ],
            }
        ]
        prefix = processor.apply_chat_template(
            conversation,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        )
        conversation.append(
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": json.dumps(row["review"], ensure_ascii=False)}
                ],
            }
        )
        inputs = processor.apply_chat_template(
            conversation,
            tokenize=True,
            add_generation_prompt=False,
            return_dict=True,
            return_tensors="pt",
        )
        labels = inputs["input_ids"].clone()
        prefix_length = prefix["input_ids"].shape[1]
        if prefix_length >= labels.shape[1]:
            raise ValueError("没有可训练的 assistant tokens")
        labels[:, :prefix_length] = -100
        labels[inputs["attention_mask"] == 0] = -100
        inputs["labels"] = labels
        return inputs

    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "run.json").write_text(json.dumps(plan, indent=2))
    trainer = Trainer(
        model=model,
        args=TrainingArguments(
            output_dir=str(args.output),
            per_device_train_batch_size=1,
            per_device_eval_batch_size=1,
            gradient_accumulation_steps=8,
            learning_rate=args.learning_rate,
            num_train_epochs=args.epochs,
            bf16=True,
            gradient_checkpointing=True,
            gradient_checkpointing_kwargs={"use_reentrant": False},
            logging_steps=5,
            eval_strategy="epoch",
            save_strategy="epoch",
            save_total_limit=2,
            remove_unused_columns=False,
            report_to="none",
            seed=42,
        ),
        train_dataset=rows,
        eval_dataset=validation,
        data_collator=collate,
    )
    trainer.train()
    trainer.save_model(str(args.output / "adapter"))
    processor.save_pretrained(args.output / "adapter")
    (args.output / "eval.json").write_text(json.dumps(trainer.evaluate(), indent=2))


if __name__ == "__main__":
    main()
