"""Score held-out human labels against model reviews. Never use training loss as quality proof."""

import argparse
import json
from pathlib import Path


def evaluate(labels, predictions):
    gold = {r["id"]: r["review"] for r in labels}
    pred = {r["id"]: r["review"] for r in predictions}
    if not gold or set(gold) != set(pred):
        raise ValueError("预测 ID 必须与非空留出集完全匹配")
    tp = fp = fn = correct = 0
    score_error = 0
    for key, label in gold.items():
        result = pred[key]
        positive, found = label["verdict"] == "revise", result["verdict"] == "revise"
        tp += positive and found
        fp += not positive and found
        fn += positive and not found
        correct += label["verdict"] == result["verdict"]
        score_error += abs(label["score"] - result["score"])
    precision = tp / (tp + fp) if tp + fp else 0
    recall = tp / (tp + fn) if tp + fn else 0
    return {
        "samples": len(gold),
        "verdict_accuracy": correct / len(gold),
        "revise_precision": precision,
        "revise_recall": recall,
        "revise_f1": 2 * precision * recall / (precision + recall) if precision + recall else 0,
        "score_mae": score_error / len(gold),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", type=Path, required=True)
    parser.add_argument("--predictions", type=Path, required=True)
    args = parser.parse_args()

    def read(p):
        return [json.loads(line) for line in p.read_text().splitlines() if line]

    print(json.dumps(evaluate(read(args.labels), read(args.predictions)), indent=2))
