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
