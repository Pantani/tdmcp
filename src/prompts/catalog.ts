export interface PromptCatalogEntry {
  name: string;
  title: string;
  description: string;
}

export const PROMPT_CATALOG: PromptCatalogEntry[] = [
  {
    name: "visual_artist_mode",
    title: "Visual artist mode",
    description: "High-level TouchDesigner visual-building workflow.",
  },
  {
    name: "debug_network",
    title: "Debug network",
    description: "Diagnose a broken TouchDesigner network.",
  },
  {
    name: "optimize_performance",
    title: "Optimize performance",
    description: "Find and reduce cook-time bottlenecks.",
  },
  {
    name: "explain_network",
    title: "Explain network",
    description: "Explain a network in artist-friendly language.",
  },
  {
    name: "remix_visual",
    title: "Remix visual",
    description: "Turn an existing visual into a new variation.",
  },
  {
    name: "beat_reactive_designer",
    title: "Beat reactive designer",
    description: "Wire visuals to audio and tempo signals.",
  },
  {
    name: "image_to_visual",
    title: "Image to visual",
    description: "Recreate a reference image as real TD nodes.",
  },
  {
    name: "tweak_visual",
    title: "Tweak visual",
    description: "Translate natural-language changes into concrete tool calls.",
  },
  {
    name: "critique_visual",
    title: "Critique visual",
    description: "Critique preview/topology/performance and suggest fixes.",
  },
  {
    name: "analyze_screenshot",
    title: "Analyze screenshot",
    description: "Diagnose a live preview with topology and node errors.",
  },
  {
    name: "vj_set_builder",
    title: "VJ set builder",
    description: "Plan a VJ set from tools, cues, and sections.",
  },
  {
    name: "fix_shader",
    title: "Fix shader",
    description: "Repair GLSL shader errors in TD context.",
  },
  {
    name: "text_to_shader",
    title: "Text to shader",
    description: "Author a GLSL TOP shader from text.",
  },
  {
    name: "audio_to_show",
    title: "Audio to show",
    description: "Plan a show from audio/tempo characteristics.",
  },
  {
    name: "auto_fix",
    title: "Auto fix",
    description: "Run a detect-fix-recheck loop for network errors.",
  },
  {
    name: "text_to_recipe",
    title: "Text to recipe",
    description: "Draft a schema-valid recipe JSON.",
  },
  {
    name: "style_reference",
    title: "Style reference",
    description: "Map a reference look to concrete tdmcp calls.",
  },
  {
    name: "fix_reactivity",
    title: "Fix reactivity",
    description: "Repair stale CHOP bindings, expressions, and reactive controls.",
  },
  {
    name: "recover_show",
    title: "Recover show",
    description: "Recover a live project with snapshots, checkpoints, and previews.",
  },
  {
    name: "auto_vj_director",
    title: "Auto VJ director",
    description: "Plan and wire an automated beat-driven VJ director.",
  },
  {
    name: "color_story",
    title: "Color story",
    description: "Create a coherent palette and grade arc across scenes.",
  },
  {
    name: "lyric_show",
    title: "Lyric show",
    description: "Stage kinetic lyric typography synced to music.",
  },
  {
    name: "setlist_planner",
    title: "Setlist planner",
    description: "Plan track sections, cues, and visual energy before building.",
  },
  {
    name: "visual_ab_compare",
    title: "Visual A/B compare",
    description: "Compare two visuals with previews, snapshots, errors, and performance.",
  },
  {
    name: "motion_critique",
    title: "Motion critique",
    description: "Critique rhythm, loop feel, motion reactivity, and pacing.",
  },
  {
    name: "explain_param",
    title: "Explain parameter",
    description: "Explain a parameter's current value, mode, docs, and visual impact.",
  },
];
