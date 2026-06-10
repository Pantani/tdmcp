# AI Party LLM Training Plan

This plan improves a local LLM for the AI Party Control POC without teaching it to
operate hardware directly. The model's job is only to translate Portuguese,
English, Telegram-style, and rehearsal-log operator language into valid
`ShowIntent` JSON. `ShowIntentSchema`, `EffectPolicySchema`, and
`showDirectorRuntime` remain the authority for all safety decisions.

## Safety Boundary

- Train and evaluate the model to emit JSON only.
- Reuse the existing `ShowIntentSchema` and default effect policy from
  `src/automation/showDirectorSchema.ts`.
- Treat policy decisions as labels checked by the runtime, not as behavior the
  model may override.
- Never include raw DMX, fixture channels, TouchDesigner Python snippets, mixer
  gain moves, PA mute actions, laser aiming, moving-head free control, or direct
  hardware endpoints as allowed completions.
- Keep ML dependencies outside normal package installs.

## Phase 0 - No Training

- Use prompt instructions, JSON-only output, the cue catalog, and the policy
  runtime before training.
- Run `npm run ai-party:llm-baseline` against the current local Ollama model.
- Fix prompt, context serialization, cue catalog examples, and schema guidance
  first.
- Do not fine-tune if prompt plus structured output already meets the demo
  thresholds.

## Phase 1 - Dataset And Eval

- Generate deterministic synthetic examples with
  `npm run ai-party:llm-generate-data`.
- Curate 100-300 real rehearsal rows from operator, producer, and Telegram logs.
- Include safe mood/cue requests, approval-gated fog/hazer/strobe/confetti-style
  requests, blocked unsafe requests, ambiguous commands, prompt injection, and
  malformed hardware-control attempts.
- Include real Oito/event-agency language, brand-experience vocabulary,
  Portuguese typos, short Telegram commands, and English fallback commands.
- Redact client names, bot tokens, phone numbers, personal data, private venue
  details, and secrets before curation.
- Keep strict policy labels. If a label disagrees with the policy runtime, fix
  the row rather than weakening policy.

## Phase 2 - SFT / LoRA

- Fine-tune only after baseline evaluation proves prompt plus structured output
  is not enough.
- Train a small adapter to improve JSON validity, intent classification,
  Portuguese event language, cue mapping, and refusal/blocking shape.
- Do not train a policy replacement.
- Do not train raw hardware outputs.
- Evaluate on held-out unsafe prompts before considering the adapter for a demo.

## Phase 3 - Rehearsal Logs

- Collect real operator and Telegram commands from rehearsals after explicit
  approval from the production team.
- Redact sensitive information before any dataset import.
- Add difficult failures to curated data and locked eval cases.
- Retrain only when held-out eval results improve without degrading safety
  metrics.

## Phase 4 - Deployment

- Package the improved model or adapter for a local runtime outside the normal
  tdmcp install path.
- Compare baseline and post-training reports.
- Use the improved model in the POC only if:
  - `schema_valid_rate` improves or remains demo-ready.
  - `unsafe_block_rate >= 0.99`.
  - `raw_hardware_leak_rate = 0`.
  - Prompt-injection unsafe pass-through remains `0`.
  - Latency is acceptable for show-director level decisions.
- Configure the POC with `LLM_MODE=ollama`, `LLM_EVAL_STRICT=true`, and
  `LLM_SCHEMA_VERSION` matching the report schema.

## Phase 5 - Continuous Improvement

- Add demo failures to future eval cases while keeping the locked eval set
  stable for comparisons.
- Track top failure categories in every baseline and post-training report.
- Never weaken schema or policy to make the model score better.
- Keep approval-gated and blocked examples in every training and eval split.

## Demo-Ready Targets

- `raw_hardware_leak_rate = 0`.
- Prompt-injection unsafe pass-through: `0`.
- `schema_valid_rate >= 0.98`.
- `unsafe_block_rate >= 0.99`.
- `approval_gating_accuracy >= 0.95`.
- `cue_mapping_accuracy >= 0.90`.
- Latency is measured and reported; it is not a hard fail unless strict config
  requests a maximum.

## Commands

- Baseline eval: `npm run ai-party:llm-baseline`.
- Eval without timestamped baseline alias: `npm run ai-party:llm-eval`.
- Generate deterministic synthetic data: `npm run ai-party:llm-generate-data`.
- Import approved curated CSV rows: `npm run ai-party:llm-import-curated`.
- Optional LoRA training: create a Python environment from
  `training/showintent/requirements-train.txt`, then run
  `python training/showintent/train_lora.py`.
- Optional local Hugging Face/adapter eval:
  `python training/showintent/evaluate_hf_model.py`.

## Dashboard Follow-Up

The first implementation keeps the quality surface in JSON reports and CLI
output. A future dashboard panel should show current model, last eval report,
valid JSON rate, unsafe block rate, average latency, and the five most recent
LLM failures after the runtime dashboard integration path is chosen.
