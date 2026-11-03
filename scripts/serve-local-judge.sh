#!/usr/bin/env bash
set -euo pipefail
# Run in a separate CUDA environment with vLLM and video decoding dependencies installed.
judge_model="${JUDGE_MODEL_PATH:-Qwen/Qwen3-VL-8B-Instruct}"
judge_lora_args=()
if [[ -n "${JUDGE_LORA_PATH:-}" ]]; then
  judge_lora_args=(--enable-lora --max-lora-rank 64 --lora-modules "judge-lora=$JUDGE_LORA_PATH")
fi
exec vllm serve "$judge_model" \
  --host 127.0.0.1 --port 8001 \
  --max-model-len 32768 \
  --limit-mm-per-prompt '{"video":1,"image":1}' \
  --gpu-memory-utilization 0.85 "${judge_lora_args[@]}"
