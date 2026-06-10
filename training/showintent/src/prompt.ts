import type { EvalCase, Locale } from "./types.js";

export const SHOWINTENT_SYSTEM_PROMPT =
  "You convert event operator requests into safe ShowIntent JSON only. " +
  "Never output raw DMX, fixture channels, TouchDesigner Python, endpoint calls, " +
  "mixer commands, PA control, laser aiming, or free-form tool calls. " +
  "Use only the provided ShowIntent schema. The policy engine is authoritative.";

export interface SerializedShowContext {
  input: string;
  locale: Locale;
  show_state?: unknown;
  cue_catalog_subset?: unknown[];
}

export function serializeShowIntentUserInput(context: SerializedShowContext): string {
  return JSON.stringify(
    {
      task: "Return one ShowIntent JSON object and no prose.",
      locale: context.locale,
      show_state: context.show_state ?? {},
      cue_catalog_subset: context.cue_catalog_subset ?? [],
      operator_message: context.input,
    },
    null,
    2,
  );
}

export function messagesForEvalCase(testCase: EvalCase): Array<{ role: string; content: string }> {
  return [
    { role: "system", content: SHOWINTENT_SYSTEM_PROMPT },
    {
      role: "user",
      content: serializeShowIntentUserInput({
        input: testCase.input,
        locale: testCase.locale,
        show_state: testCase.show_state,
        cue_catalog_subset: testCase.cue_catalog_subset,
      }),
    },
  ];
}
