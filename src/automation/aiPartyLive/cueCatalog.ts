import { z } from "zod";

export const AiPartyCueKindSchema = z.enum([
  "visual",
  "lighting",
  "combined",
  "physical_effect",
  "safe_state",
]);
export type AiPartyCueKind = z.infer<typeof AiPartyCueKindSchema>;

export const AiPartyCueRiskSchema = z.enum(["safe", "approval"]);
export type AiPartyCueRisk = z.infer<typeof AiPartyCueRiskSchema>;

export const AiPartyCueSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  kind: AiPartyCueKindSchema,
  risk: AiPartyCueRiskSchema,
  preapproved: z.boolean(),
  description: z.string().min(1),
  generated_mood: z.string().min(1).optional(),
  generated_intensity: z.number().min(0).max(0.85).optional(),
  source_prompt: z.string().min(1).optional(),
  created_at: z.string().min(1).optional(),
  favorite: z.boolean().optional(),
});
export type AiPartyCue = z.infer<typeof AiPartyCueSchema>;

export const DEFAULT_AI_PARTY_CUE_CATALOG = [
  {
    name: "doors_idle",
    label: "Doors / ambient arrival",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "calm generative welcome visual",
  },
  {
    name: "premium_tropical",
    label: "Premium tropical",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "elegant tropical tech mood",
  },
  {
    name: "neon_pulse",
    label: "Neon pulse",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "higher-energy neon pulse",
  },
  {
    name: "brand_hero",
    label: "Brand hero moment",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "photogenic branded moment",
  },
  {
    name: "audio_reactive_main",
    label: "Audio reactive main",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "TD audio-reactive state; TD handles beat/energy locally",
  },
  {
    name: "fog_short_burst",
    label: "Short fog burst",
    kind: "physical_effect",
    risk: "approval",
    preapproved: false,
    description: "short fog burst, max 3 seconds, approval required",
  },
  {
    name: "hazer_light",
    label: "Light hazer",
    kind: "physical_effect",
    risk: "approval",
    preapproved: false,
    description: "low haze cue, approval required",
  },
  {
    name: "strobe_soft_sim",
    label: "Soft strobe simulation",
    kind: "visual",
    risk: "approval",
    preapproved: false,
    description: "simulated visual strobe, approval required",
  },
  {
    name: "panic_safe",
    label: "Panic safe",
    kind: "safe_state",
    risk: "safe",
    preapproved: true,
    description: "stable safe visual, no fog, no strobe, no sudden movement",
  },
] satisfies AiPartyCue[];

export function findAiPartyCue(
  name: string,
  catalog: readonly AiPartyCue[] = DEFAULT_AI_PARTY_CUE_CATALOG,
): AiPartyCue | undefined {
  return catalog.find((cue) => cue.name === name);
}

const GENERATED_CUE_UNSAFE =
  /\b(raw_dmx|raw dmx|raw_python|raw python|python|endpoint|fixture|channel|dmx|fog|fumaca|fumaça|smoke|hazer|haze|strobe|strobo|blackout|freeze|laser|moving head|moving_head|mixer|pa mute|audio routing|ignore previous rules|bypass policy)\b/i;

export function isAiPartyGeneratedCuePromptUnsafe(prompt: string): boolean {
  return GENERATED_CUE_UNSAFE.test(prompt);
}

export interface CreateAiPartyGeneratedCueOptions {
  index: number;
  now?: Date;
  currentIntensity?: number;
}

function cleanPrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 140);
}

function slugifyPrompt(prompt: string): string {
  const slug = prompt
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .split("_")
    .filter(Boolean)
    .slice(0, 4)
    .join("_");
  return slug || "vibe";
}

function labelFromPrompt(prompt: string): string {
  const words = prompt.split(" ").filter(Boolean).slice(0, 6).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function intensityFromPrompt(prompt: string, fallback = 0.55): number {
  const normalized = prompt
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  let value = fallback;
  if (/\b(calm|calma|ambient|soft|leve|minimal|quieto)\b/.test(normalized)) value = 0.38;
  if (/\b(premium|elegante|warmup|groove)\b/.test(normalized)) value = 0.56;
  if (/\b(build|energia|pulse|pulso|neon|dance|disco)\b/.test(normalized)) value = 0.68;
  if (/\b(drop|hype|explosivo|peak|pico|max)\b/.test(normalized)) value = 0.8;
  return Number(Math.max(0.2, Math.min(0.85, value)).toFixed(2));
}

export function createAiPartyGeneratedCue(
  prompt: string,
  options: CreateAiPartyGeneratedCueOptions,
): AiPartyCue {
  const sourcePrompt = cleanPrompt(prompt);
  if (sourcePrompt.length < 3) throw new Error("Cue prompt must have at least 3 characters.");
  if (isAiPartyGeneratedCuePromptUnsafe(sourcePrompt)) {
    throw new Error("Generated cues can only describe safe visual moods.");
  }
  const slug = slugifyPrompt(sourcePrompt);
  const index = Math.max(1, Math.floor(options.index));
  const generatedIntensity = intensityFromPrompt(sourcePrompt, options.currentIntensity);
  return AiPartyCueSchema.parse({
    name: `gen_${slug}_${String(index).padStart(2, "0")}`,
    label: `Generated: ${labelFromPrompt(sourcePrompt)}`,
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: `Temporary safe visual mood from: ${sourcePrompt}`,
    generated_mood: slug,
    generated_intensity: generatedIntensity,
    source_prompt: sourcePrompt,
    created_at: (options.now ?? new Date()).toISOString(),
  });
}

function normalizedText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function cueSearchTerms(cue: AiPartyCue): string[] {
  return [cue.name, cue.label]
    .flatMap((value) => normalizedText(value).split(/[^a-z0-9]+/))
    .filter((term) => term.length > 2);
}

export function shouldAutoGenerateAiPartyCue(
  prompt: string,
  catalog: readonly AiPartyCue[] = DEFAULT_AI_PARTY_CUE_CATALOG,
): boolean {
  const cleaned = cleanPrompt(prompt);
  if (cleaned.length < 3) return false;
  if (cleaned.startsWith("/") || cleaned.startsWith("cue:")) return false;
  if (isAiPartyGeneratedCuePromptUnsafe(cleaned)) return false;
  const normalized = normalizedText(cleaned);
  const words = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length < 2) return false;
  const matchesKnownCue = catalog.some((cue) => {
    const terms = cueSearchTerms(cue);
    if (terms.length === 0) return false;
    return terms.filter((term) => normalized.includes(term)).length >= Math.min(2, terms.length);
  });
  return !matchesKnownCue;
}
