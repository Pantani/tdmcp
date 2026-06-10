#!/usr/bin/env python3
"""Optional LoRA/SFT training scaffold for ShowIntent JSON output.

This file intentionally imports the ML stack inside main() so normal tdmcp
installs can inspect or package the repository without GPU dependencies.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DEFAULT_TRAIN = ROOT / "data" / "splits" / "train.jsonl"
DEFAULT_VALIDATION = ROOT / "data" / "splits" / "validation.jsonl"


def env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    return int(value) if value else default


def env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    return float(value) if value else default


def target_modules() -> list[str] | None:
    raw = os.environ.get("LORA_TARGET_MODULES", "").strip()
    if not raw:
        return None
    return [item.strip() for item in raw.split(",") if item.strip()]


def main() -> None:
    from datasets import load_dataset
    from peft import LoraConfig
    from trl import SFTConfig, SFTTrainer

    base_model = os.environ.get("BASE_MODEL", "Qwen/Qwen2.5-0.5B-Instruct")
    train_path = Path(os.environ.get("TRAIN_JSONL", str(DEFAULT_TRAIN)))
    validation_path = Path(os.environ.get("VALIDATION_JSONL", str(DEFAULT_VALIDATION)))
    run_id = os.environ.get(
        "RUN_ID",
        datetime.now(timezone.utc).strftime("lora-%Y%m%d-%H%M%S"),
    )
    output_dir = ROOT / "out" / run_id

    if not train_path.exists():
        raise SystemExit(f"Missing train JSONL: {train_path}")
    if not validation_path.exists():
        raise SystemExit(f"Missing validation JSONL: {validation_path}")

    dataset = load_dataset(
        "json",
        data_files={"train": str(train_path), "validation": str(validation_path)},
    )
    dataset = dataset.map(
        lambda row: {"messages": row["messages"]},
        remove_columns=[name for name in dataset["train"].column_names if name != "messages"],
    )

    lora_kwargs = {}
    modules = target_modules()
    if modules:
        lora_kwargs["target_modules"] = modules

    peft_config = LoraConfig(
        r=env_int("LORA_R", 16),
        lora_alpha=env_int("LORA_ALPHA", 32),
        lora_dropout=env_float("LORA_DROPOUT", 0.05),
        bias="none",
        task_type="CAUSAL_LM",
        **lora_kwargs,
    )

    args = SFTConfig(
        output_dir=str(output_dir),
        learning_rate=env_float("LEARNING_RATE", 2.0e-4),
        num_train_epochs=env_float("NUM_TRAIN_EPOCHS", 1.0),
        per_device_train_batch_size=env_int("TRAIN_BATCH_SIZE", 1),
        per_device_eval_batch_size=env_int("EVAL_BATCH_SIZE", 1),
        gradient_accumulation_steps=env_int("GRADIENT_ACCUMULATION_STEPS", 8),
        logging_steps=env_int("LOGGING_STEPS", 10),
        save_strategy="epoch",
        eval_strategy="epoch",
        bf16=os.environ.get("BF16", "false").lower() == "true",
        fp16=os.environ.get("FP16", "false").lower() == "true",
    )

    trainer = SFTTrainer(
        model=base_model,
        args=args,
        train_dataset=dataset["train"],
        eval_dataset=dataset["validation"],
        peft_config=peft_config,
    )
    trainer.train()
    trainer.save_model(str(output_dir))
    metrics = trainer.evaluate()
    trainer.log_metrics("eval", metrics)
    trainer.save_metrics("eval", metrics)
    print(f"Saved LoRA adapter and metrics to {output_dir}")


if __name__ == "__main__":
    main()
