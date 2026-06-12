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

export const AiPartyCueSectionSchema = z.enum([
  "doors",
  "warmup",
  "build",
  "drop",
  "breakdown",
  "closing",
  "any",
]);
export type AiPartyCueSection = z.infer<typeof AiPartyCueSectionSchema>;

export const AiPartyCameraFxSchema = z.enum(["none", "warm", "cool", "mono", "duotone", "heat"]);
export type AiPartyCameraFx = z.infer<typeof AiPartyCameraFxSchema>;

export const AiPartyCueOutputsSchema = z
  .object({
    main: z.string().min(1),
    status: z.string().min(1),
    camera: z.string().min(1),
    crowd: z.string().min(1),
  })
  .partial();
export type AiPartyCueOutputs = z.infer<typeof AiPartyCueOutputsSchema>;

export const AiPartyCueSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  kind: AiPartyCueKindSchema,
  risk: AiPartyCueRiskSchema,
  preapproved: z.boolean(),
  description: z.string().min(1),
  section: AiPartyCueSectionSchema.optional(),
  default_intensity: z.number().min(0.2).max(0.85).optional(),
  flicker_risk: z.boolean().optional(),
  camera_fx: AiPartyCameraFxSchema.optional(),
  outputs: AiPartyCueOutputsSchema.optional(),
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
    section: "doors",
    default_intensity: 0.3,
    camera_fx: "cool",
    outputs: {
      main: "slow breathing gradient",
      status: "welcome line + clock",
      camera: "soft cool grade",
      crowd: "welcome message",
    },
  },
  {
    name: "premium_tropical",
    label: "Premium tropical",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "elegant tropical tech mood",
    section: "warmup",
    default_intensity: 0.56,
    camera_fx: "warm",
    outputs: {
      main: "tropical silhouettes + dusk gradient",
      status: "amber lyric lines",
      camera: "warm tone feed",
      crowd: "promoted suggestions as leaf cards",
    },
  },
  {
    name: "neon_pulse",
    label: "Neon pulse",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "higher-energy neon pulse",
    section: "build",
    default_intensity: 0.7,
    camera_fx: "cool",
    outputs: {
      main: "neon pulse layers",
      status: "keywords rising",
      camera: "edge-lit cool feed",
      crowd: "live suggestion ticker",
    },
  },
  {
    name: "brand_hero",
    label: "Brand hero moment",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "photogenic branded moment",
    section: "any",
    default_intensity: 0.55,
    camera_fx: "duotone",
    outputs: {
      main: "hero brand visual",
      status: "tagline",
      camera: "branded duotone feed",
      crowd: "photo frame moment",
    },
  },
  {
    name: "audio_reactive_main",
    label: "Audio reactive main",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "TD audio-reactive state; TD handles beat/energy locally",
    section: "drop",
    default_intensity: 0.75,
    camera_fx: "cool",
    outputs: {
      main: "audio reactive energy",
      status: "beat-synced words",
      camera: "motion glow feed",
      crowd: "energy meter",
    },
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
    flicker_risk: true,
  },
  {
    name: "panic_safe",
    label: "Panic safe",
    kind: "safe_state",
    risk: "safe",
    preapproved: true,
    description: "stable safe visual, no fog, no strobe, no sudden movement",
    section: "any",
    default_intensity: 0.2,
    camera_fx: "none",
  },
  {
    name: "slow_tide",
    label: "Slow tide",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "liquid petrol-blue gradient breathing in 12s cycles",
    section: "doors",
    default_intensity: 0.25,
    camera_fx: "cool",
    outputs: {
      main: "slow liquid waves",
      status: "thin type + doors open",
      camera: "desaturated vignette feed",
      crowd: "welcome + suggestion QR hint",
    },
  },
  {
    name: "dust_gold",
    label: "Dust & gold",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "golden particles falling in slow motion over warm black",
    section: "doors",
    default_intensity: 0.3,
    camera_fx: "warm",
    outputs: {
      main: "slow golden particles",
      status: "event name in gold serif",
      camera: "film grain feed",
      crowd: "subtle suggestion counter",
    },
  },
  {
    name: "soft_atlas",
    label: "Soft atlas",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "animated topographic lines drifting like a living map",
    section: "doors",
    default_intensity: 0.28,
    camera_fx: "mono",
    outputs: {
      main: "cyan topography",
      status: "night lineup",
      camera: "contour overlay feed",
      crowd: "the night map starts with you",
    },
  },
  {
    name: "velvet_grid",
    label: "Velvet grid",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "slow purple perspective grid pulsing with the groove",
    section: "warmup",
    default_intensity: 0.4,
    camera_fx: "duotone",
    outputs: {
      main: "perspective grid",
      status: "estimated BPM + mood",
      camera: "magenta tint feed",
      crowd: "names riding the grid",
    },
  },
  {
    name: "liquid_brass",
    label: "Liquid brass",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "amber liquid metal with slow specular highlights",
    section: "warmup",
    default_intensity: 0.5,
    camera_fx: "warm",
    outputs: {
      main: "flowing liquid metal",
      status: "embossed text",
      camera: "bronze duotone feed",
      crowd: "discreet ticker",
    },
  },
  {
    name: "polaroid_crowd",
    label: "Polaroid crowd",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "instant-photo frames revealing camera crops, soft fades only",
    section: "warmup",
    default_intensity: 0.42,
    camera_fx: "mono",
    outputs: {
      main: "polaroid collage",
      status: "smile, you are the visual",
      camera: "main subject feed",
      crowd: "latest suggestion as photo caption",
    },
  },
  {
    name: "neon_cascade",
    label: "Neon cascade",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "layered neon line curtains falling faster with intensity",
    section: "build",
    default_intensity: 0.6,
    camera_fx: "cool",
    outputs: {
      main: "cyan-pink cascade",
      status: "set keywords rising",
      camera: "motion edge glow feed",
      crowd: "suggestions falling with the cascade",
    },
  },
  {
    name: "pulse_lattice",
    label: "Pulse lattice",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "3D lattice expanding and contracting like accelerated breath",
    section: "build",
    default_intensity: 0.62,
    camera_fx: "duotone",
    outputs: {
      main: "breathing lattice",
      status: "scenes-to-drop countdown",
      camera: "feed inside lattice cells",
      crowd: "each suggestion lights a node",
    },
  },
  {
    name: "signal_bloom",
    label: "Signal bloom",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "controlled interference blooms opening from center, no fast flicker",
    section: "build",
    default_intensity: 0.65,
    camera_fx: "cool",
    outputs: {
      main: "interference blooms",
      status: "light typographic glitch",
      camera: "scanline feed",
      crowd: "transmission received + suggestion",
    },
  },
  {
    name: "chromatic_run",
    label: "Chromatic run",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "horizontal color bands running with growing chromatic aberration",
    section: "build",
    default_intensity: 0.68,
    camera_fx: "duotone",
    outputs: {
      main: "running color bands",
      status: "motion-stretched text",
      camera: "subtle RGB split feed",
      crowd: "top promoted suggestions leaderboard",
    },
  },
  {
    name: "crowd_heat",
    label: "Crowd heat",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "stylized faux heatmap of the floor; posterized thermal palette only",
    section: "build",
    default_intensity: 0.6,
    camera_fx: "heat",
    outputs: {
      main: "thermal floor view",
      status: "room energy rising",
      camera: "heat palette feed",
      crowd: "you are the visual now",
    },
  },
  {
    name: "lightning_veins",
    label: "Lightning veins (no strobe)",
    kind: "visual",
    risk: "approval",
    preapproved: false,
    description: "drawn lightning branches with glow, under 1 Hz, no full-screen flash",
    section: "build",
    default_intensity: 0.7,
    camera_fx: "cool",
    flicker_risk: true,
    outputs: {
      main: "glowing lightning branches",
      status: "charging storm",
      camera: "desaturated blue feed",
      crowd: "a bolt crosses on each suggestion",
    },
  },
  {
    name: "supernova_bloom",
    label: "Supernova bloom",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "radial particle burst with high bloom, peak luminance capped at 80%",
    section: "drop",
    default_intensity: 0.85,
    camera_fx: "cool",
    outputs: {
      main: "radial supernova",
      status: "single giant word",
      camera: "bloom + pulsed zoom feed",
      crowd: "promoted suggestions burst together",
    },
  },
  {
    name: "kinetic_type_storm",
    label: "Kinetic type storm",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "massive 3D typography rotating and breaking on rhythm",
    section: "drop",
    default_intensity: 0.8,
    camera_fx: "duotone",
    outputs: {
      main: "type storm",
      status: "same word in delayed echo",
      camera: "feed mapped inside letters",
      crowd: "promoted suggestion becomes the word",
    },
  },
  {
    name: "mirror_shatter",
    label: "Mirror shatter",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "mirrored kaleidoscope breaking and reassembling, cuts >= 500 ms",
    section: "drop",
    default_intensity: 0.82,
    camera_fx: "duotone",
    outputs: {
      main: "kaleidoscope shards",
      status: "artist name fragments",
      camera: "kaleidoscoped feed",
      crowd: "mosaic of last 12 suggestions",
    },
  },
  {
    name: "tunnel_surge",
    label: "Tunnel surge",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "infinite tunnel accelerating with pulsing FOV",
    section: "drop",
    default_intensity: 0.85,
    camera_fx: "cool",
    outputs: {
      main: "accelerating tunnel",
      status: "fake speedometer climbing",
      camera: "feed at tunnel end",
      crowd: "suggestions flying on the walls",
    },
  },
  {
    name: "crowd_mirror_max",
    label: "Crowd mirror max",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "posterized 4-color camera mirrored 4x with short delay feedback",
    section: "drop",
    default_intensity: 0.78,
    camera_fx: "heat",
    outputs: {
      main: "giant floor mirror",
      status: "this is you",
      camera: "posterized mirror source",
      crowd: "live suggestion frame",
    },
  },
  {
    name: "photoflash_wall",
    label: "Photoflash wall",
    kind: "visual",
    risk: "approval",
    preapproved: false,
    description: "paparazzi flash simulation, partial frames <= 40%, >= 600 ms apart",
    section: "drop",
    default_intensity: 0.75,
    camera_fx: "mono",
    flicker_risk: true,
    outputs: {
      main: "partial flash frames",
      status: "flash typography",
      camera: "high contrast B&W feed",
      crowd: "magazine cover frames",
    },
  },
  {
    name: "deep_sea_pause",
    label: "Deep sea pause",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "deep blue with slow god rays and rising particles",
    section: "breakdown",
    default_intensity: 0.35,
    camera_fx: "cool",
    outputs: {
      main: "deep ocean rays",
      status: "breathing typography",
      camera: "darkened feed with rays",
      crowd: "visual silence, pulsing logo",
    },
  },
  {
    name: "ember_field",
    label: "Ember field",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "floating embers over near-black",
    section: "breakdown",
    default_intensity: 0.4,
    camera_fx: "warm",
    outputs: {
      main: "floating embers",
      status: "lyrics line by line",
      camera: "orange-black duotone feed",
      crowd: "each suggestion lights an ember",
    },
  },
  {
    name: "breath_sync",
    label: "Breath sync",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "single circle expanding 4s and contracting 4s, inviting the room to breathe",
    section: "breakdown",
    default_intensity: 0.3,
    camera_fx: "mono",
    outputs: {
      main: "breathing circle",
      status: "inhale, hold, release",
      camera: "synced radial blur feed",
      crowd: "people breathing together counter",
    },
  },
  {
    name: "constellation_drift",
    label: "Constellation drift",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "starfield where constellations connect slowly",
    section: "breakdown",
    default_intensity: 0.38,
    camera_fx: "cool",
    outputs: {
      main: "connecting constellations",
      status: "night cue names as stars",
      camera: "starfield overlay feed",
      crowd: "promoted suggestions become constellations",
    },
  },
  {
    name: "golden_hour_fade",
    label: "Golden hour fade",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "golden gradient descending slowly like an inverted sunset",
    section: "closing",
    default_intensity: 0.35,
    camera_fx: "warm",
    outputs: {
      main: "golden fade",
      status: "multilingual thank you",
      camera: "sepia feed",
      crowd: "slow replay of best suggestions",
    },
  },
  {
    name: "thank_you_cascade",
    label: "Thank you cascade",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "cinema credits with the night's cues, approvals, and highlights",
    section: "closing",
    default_intensity: 0.4,
    camera_fx: "warm",
    outputs: {
      main: "rolling credits",
      status: "night statistics",
      camera: "grainy last dancers feed",
      crowd: "see yourselves in the credits",
    },
  },
  {
    name: "afterglow_archive",
    label: "Afterglow archive",
    kind: "visual",
    risk: "safe",
    preapproved: true,
    description: "mosaic of every cue palette played tonight, in order",
    section: "closing",
    default_intensity: 0.3,
    camera_fx: "mono",
    outputs: {
      main: "palette mosaic of the night",
      status: "rendered night timeline",
      camera: "slow fade out",
      crowd: "QR hint to receive the recap",
    },
  },
  {
    name: "brand_hero_prism",
    label: "Brand hero prism",
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: "logo refracted through a prism with slow caustics, ultra photogenic",
    section: "any",
    default_intensity: 0.55,
    camera_fx: "duotone",
    outputs: {
      main: "prism refraction",
      status: "tagline",
      camera: "discreet lens flare feed",
      crowd: "branded photo frame",
    },
  },
  {
    name: "fog_veil_sim",
    label: "Fog veil (visual sim)",
    kind: "visual",
    risk: "approval",
    preapproved: false,
    description: "volumetric fog look simulated on screen only; mirrors the physical gate",
    section: "any",
    default_intensity: 0.5,
    camera_fx: "mono",
    outputs: {
      main: "volumetric veil",
      status: "text emerging from fog",
      camera: "soft focus feed",
      crowd: "silhouettes",
    },
  },
] satisfies AiPartyCue[];

export function findAiPartyCue(
  name: string,
  catalog: readonly AiPartyCue[] = DEFAULT_AI_PARTY_CUE_CATALOG,
): AiPartyCue | undefined {
  return catalog.find((cue) => cue.name === name);
}

export function recommendedAiPartyCuesForSection(
  section: AiPartyCueSection,
  catalog: readonly AiPartyCue[] = DEFAULT_AI_PARTY_CUE_CATALOG,
  limit = 6,
): AiPartyCue[] {
  return catalog
    .filter((cue) => cue.risk === "safe" && cue.preapproved && !cue.flicker_risk)
    .filter((cue) => cue.kind !== "safe_state" && cue.kind !== "physical_effect")
    .filter((cue) => cue.section === section || cue.section === "any")
    .slice(0, Math.max(1, limit));
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

function displayPrompt(prompt: string): string {
  return cleanPrompt(prompt).replace(/[<>&]/g, " ").replace(/\s+/g, " ").trim();
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
  const safePrompt = displayPrompt(sourcePrompt);
  const index = Math.max(1, Math.floor(options.index));
  const generatedIntensity = intensityFromPrompt(sourcePrompt, options.currentIntensity);
  return AiPartyCueSchema.parse({
    name: `gen_${slug}_${String(index).padStart(2, "0")}`,
    label: `Generated: ${labelFromPrompt(safePrompt)}`,
    kind: "combined",
    risk: "safe",
    preapproved: true,
    description: `Temporary safe visual mood from: ${safePrompt}`,
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
  return [
    ...new Set(
      [cue.name, cue.label]
        .flatMap((value) => normalizedText(value).split(/[^a-z0-9]+/))
        .filter((term) => term.length > 2),
    ),
  ];
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
