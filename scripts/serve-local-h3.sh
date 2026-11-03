#!/usr/bin/env bash
set -euo pipefail
# Run in a separate SGLang Diffusion environment. Weights are downloaded only when you run this.
h3_model="${H3_MODEL_PATH:-MiniMaxAI/MiniMax-H3}"
h3_gpus="${H3_NUM_GPUS:-4}"
exec sglang serve \
  --model-path "$h3_model" --num-gpus "$h3_gpus" \
  --ulysses-degree "$h3_gpus" --performance-mode speed \
  --host 127.0.0.1 --port 30010 --model-variant fl2va
