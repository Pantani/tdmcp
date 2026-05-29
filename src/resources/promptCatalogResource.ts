import { jsonContents, type ResourceRegistrar } from "./shared.js";

/**
 * A flat, human/agent-readable catalog of the MCP prompts tdmcp registers. Prompts
 * are powerful creative recipes but invisible to clients that don't surface MCP
 * prompts (notably the local `tdmcp chat` copilot), so this resource lets any model
 * discover them by name + one-line purpose. Keep in sync with
 * `src/prompts/index.ts` (the authoritative registrations).
 */
const PROMPT_CATALOG: ReadonlyArray<{ name: string; summary: string }> = [
  {
    name: "visual_artist_mode",
    summary: "Adopt a VJ/visual-artist working style for the session.",
  },
  { name: "debug_network", summary: "Walk a network's errors and propose fixes." },
  { name: "optimize_performance", summary: "Find cook-time bottlenecks and reduce them." },
  { name: "explain_network", summary: "Explain what an existing network does, stage by stage." },
  { name: "remix_visual", summary: "Take an existing look and remix it into variations." },
  {
    name: "beat_reactive_designer",
    summary: "Wire audio features / the beat into a visual's parameters.",
  },
  {
    name: "image_to_visual",
    summary: "Recreate a reference image's look in real nodes (multimodal).",
  },
  { name: "tweak_visual", summary: "Plain-language adjustments → the right parameter changes." },
  {
    name: "critique_visual",
    summary: "Aesthetic + performance critique of one output, with fixes.",
  },
  {
    name: "analyze_screenshot",
    summary: "Preview + topology + errors → diagnose 'why is it black?'.",
  },
  { name: "vj_set_builder", summary: "Assemble a full reactive set from a description." },
  { name: "fix_shader", summary: "Diagnose a GLSL TOP compile error against TD conventions." },
  { name: "text_to_shader", summary: "Author + validate a GLSL TOP from a description." },
  { name: "audio_to_show", summary: "Plan a full reactive set from a track." },
  { name: "auto_fix", summary: "Detect → diagnose → fix → re-check loop until it cooks clean." },
  { name: "text_to_recipe", summary: "Author a schema-valid recipe JSON from a description." },
  {
    name: "style_reference",
    summary: "Recreate a reference look as an ordered plan of tool calls.",
  },
  {
    name: "fix_reactivity",
    summary: "Diagnose a wired-but-dead reactive signal (paused/silent/flat).",
  },
  { name: "recover_show", summary: "Fast mid-show panic recovery — get a picture back NOW." },
  {
    name: "auto_vj_director",
    summary: "Hands-free AI VJ: fire cues/transitions on the event stream.",
  },
  { name: "color_story", summary: "Design a cohesive palette + grade arc across a set." },
  { name: "setlist_planner", summary: "Turn a tracklist/BPM curve into a scene-per-track plan." },
  {
    name: "explain_param",
    summary: "Plain-language 'what does this knob do?', grounded in the KB.",
  },
  {
    name: "visual_ab_compare",
    summary: "Capture two looks/cues and judge which better fits a goal.",
  },
  {
    name: "lyric_show",
    summary: "Lyrics/credits + vibe → a timed, beat-synced kinetic-text layer.",
  },
  {
    name: "genre_visual_language",
    summary: "Pick idiomatic looks for a music genre (not generic ones).",
  },
  {
    name: "motion_critique",
    summary: "Judge a look's MOTION over time, not a single still frame.",
  },
  {
    name: "match_reference_loop",
    summary: "Converge to a reference image as a scored build→score→adjust loop.",
  },
];

export const registerPromptCatalogResource: ResourceRegistrar = (server) => {
  server.registerResource(
    "td-prompts",
    "tdmcp://prompts",
    {
      title: "tdmcp prompt catalog",
      description:
        "The MCP prompts tdmcp offers (name + one-line purpose), so a model — including the local copilot — can discover the creative recipes available even when the client doesn't surface MCP prompts.",
      mimeType: "application/json",
    },
    async (uri) =>
      jsonContents(uri, {
        count: PROMPT_CATALOG.length,
        note: "Invoke these as MCP prompts. The local `tdmcp chat` copilot can't call them directly, but you can follow the named recipe's intent.",
        prompts: PROMPT_CATALOG,
      }),
  );
};
