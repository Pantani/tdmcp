import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { type AiPartyCue, AiPartyCueSchema } from "./cueCatalog.js";

const GeneratedCueStoreSchema = z.object({
  version: z.literal(1),
  cues: z.array(AiPartyCueSchema),
});

function isPersistableGeneratedCue(cue: AiPartyCue): boolean {
  return (
    cue.name.startsWith("gen_") &&
    cue.kind === "combined" &&
    cue.risk === "safe" &&
    cue.preapproved &&
    Boolean(cue.generated_mood) &&
    Boolean(cue.source_prompt)
  );
}

export function loadGeneratedCueStore(path: string): AiPartyCue[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const parsed = GeneratedCueStoreSchema.safeParse(raw);
  if (!parsed.success) return [];
  const seen = new Set<string>();
  const cues: AiPartyCue[] = [];
  for (const cue of parsed.data.cues) {
    if (!isPersistableGeneratedCue(cue) || seen.has(cue.name)) continue;
    seen.add(cue.name);
    cues.push(cue);
  }
  return cues;
}

export function saveGeneratedCueStore(path: string, cues: readonly AiPartyCue[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ version: 1, cues: cues.filter(isPersistableGeneratedCue) }, null, 2)}\n`,
    "utf8",
  );
}
