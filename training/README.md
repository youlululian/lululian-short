# 模型迭代与训练

两条独立训练线：H3 视频生成 LoRA、Qwen3-VL 视频 Judge LoRA。默认 dry run；仅在带 `--execute` 时加载权重并训练。训练代码与数据准备通过静态和小样本测试，真实 GPU 训练、收敛质量与显存需求尚未实测。

## 数据闭环

自动评审是候选标注，不是可靠真值。先读取工作台任务事件，人工修正 verdict、问题时间段和理由，再把具有训练使用权的原视频写入 JSONL。不要直接用某个 Judge 的评分训练同一个 Judge，再用它自己证明进步。

每行记录：

```json
{"project_id":"original-film-001","video":"clips/001.mp4","prompt":"角色在雨夜拿起桌上的信封。","origin":"user","human_reviewed":true,"rights_confirmed":true,"accepted":true,"review":{"verdict":"pass","score":90,"summary":"动作符合要求","issues":[]}}
```

`accepted` 用于 H3 数据筛选；`review` 用于 Judge 监督。示例字段必须由真实人工确认，不能为通过校验随意填写。视频预先裁剪至 4–15 秒；H3 训练还要求有效音轨。

```bash
uv run python training/prepare.py --source /path/to/annotations.jsonl --target h3 --output .data/datasets/h3
uv run python training/prepare.py --source /path/to/annotations.jsonl --target judge --output .data/datasets/judge
```

按 `project_id` 分组确定训练／验证集，避免同一项目的相邻镜头泄漏。重复视频会被拒绝。源文件 SHA256 与数据清单保存到 manifest。

MiniMax H3 的模型许可对用其权重或产物训练其他 AI 模型有限制。默认不接受 `origin=minimax_h3` 的素材进入 Qwen Judge 数据集；用自主拍摄、授权数据或许可允许的其他来源。H3 微调产物仍受 H3 许可约束。参见[模型许可证](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE)。

## H3 LoRA

GPU 环境独立安装 [DiffSynth-Studio](https://github.com/modelscope/DiffSynth-Studio)，检出 `h3-lora.json` 的固定 commit 并按该版本安装依赖。不要把依赖代码拷贝到本项目。

```bash
python training/train_h3.py --backend /opt/DiffSynth-Studio --data .data/datasets/h3
# 核验计划后，在 GPU 机器实际执行：
python training/train_h3.py --backend /opt/DiffSynth-Studio --data .data/datasets/h3 --execute
```

入口依次执行特征缓存和 LoRA 训练，配置记录到输出目录。该流程训练 T2VA 音视频联合生成，当前不是全参数训练。原始 H3 为蒸馏模型，超参数和训练适配方式需要在留出集上验证。当前脚本不默认加载可选 DeCFG 适配器。

训练完成后，使用训练后端的 LoRA 验证入口在 `validation.csv` 生成固定 seed 的样本，与基线在同一 Judge、同一人工标注标准下比较。服务后端必须支持对应 LoRA 格式；不能直接把 DiffSynth adapter 当完整 SGLang checkpoint。上线前需转换或选择支持该 adapter 的服务后端。

## Qwen Judge LoRA

在独立 CUDA Python 环境安装 `requirements-judge.txt`：

```bash
python training/train_judge.py --data .data/datasets/judge
python training/train_judge.py --data .data/datasets/judge --execute
```

训练只对 assistant 评审输出计算损失，冻结视觉编码器，使用 LoRA、BF16 和梯度检查点，按 epoch 保存与评估。默认 batch size 1，累积 8 步。不支持在本机无 CUDA 环境直接启动此训练。

在支持 Qwen3-VL LoRA 的 vLLM 环境中，可通过 `JUDGE_LORA_PATH=/path/to/adapter bash scripts/serve-local-judge.sh` 加载 adapter，并在工作台将视频 Judge 模型 ID 改为 `judge-lora`。仍需先通过实际推理兼容性测试；保持原模型名称即可回退。

## 评测与上线

将留出集推理结果存为 `{id, review}` JSONL，计算指标：

```bash
python training/evaluate.py --labels .data/datasets/judge/validation.jsonl --predictions /path/to/predictions.jsonl
```

输出判定准确率、需修改样本的 precision/recall/F1 和评分 MAE。该工具不测时间段定位精度，需另做人工复核；训练 loss 降低不代表评审质量提高。

上线顺序：固定数据版本 → 基线评测 → 训练 → 留出集与人工抽检 → 推理兼容测试 → 小流量替换 → 保留旧模型配置回退。生成模型的画质与风格进步必须与人物一致性、动作符合度、失败率和单镜耗时一起比较。
