import { jsonContents, type ResourceRegistrar } from "./shared.js";

export interface CheatsheetEntry {
  id: string;
  title: string;
  when_to_use: string;
  steps: string[];
  resource_refs: string[];
}

export interface CheatsheetResource {
  uri: "tdmcp://cheatsheets";
  count: number;
  cheatsheets: CheatsheetEntry[];
}

const CHEATSHEETS: CheatsheetEntry[] = [
  {
    id: "operator-families",
    title: "Operator Families",
    when_to_use: "Before creating a network, pick the operator family that owns the data shape.",
    steps: [
      "Use TOPs for images/video, CHOPs for channels/control, SOPs for geometry, DATs for tables/text, MATs for materials, and COMPs for containers/UI.",
      "Search or read the operator category before naming a TD type.",
      "Prefer high-level tdmcp tools first, then drop to Layer 2/3 when the target topology is specific.",
    ],
    resource_refs: [
      "tdmcp://operators/TOP",
      "tdmcp://operators/CHOP",
      "tdmcp://operators/SOP",
      "tdmcp://operators/DAT",
      "tdmcp://operators/MAT",
      "tdmcp://operators/COMP",
    ],
  },
  {
    id: "debug-loop",
    title: "Create, Verify, Preview",
    when_to_use: "After any generated or edited visual network.",
    steps: [
      "Create the smallest useful network and keep the output path explicit.",
      "Run get_td_node_errors or summarize_td_errors before claiming success.",
      "Capture get_preview for TOP outputs; if preview is unavailable, surface the warning and the output path.",
    ],
    resource_refs: ["tdmcp://commands", "tdmcp://prompts", "tdmcp://learning/touchdesigner"],
  },
  {
    id: "glsl-top",
    title: "GLSL TOP Assembly",
    when_to_use: "When a visual needs custom fragment-shader logic.",
    steps: [
      "Read a vetted snippet before drafting shader code from scratch.",
      "Create a GLSL TOP and sibling Text DAT, then bind the DAT to pixeldat.",
      "Expose numeric uniforms through the Vectors sequence and drive time from absTime or a CHOP.",
    ],
    resource_refs: [
      "tdmcp://operators/TOP",
      "tdmcp://glsl-snippets",
      "tdmcp://glsl/raymarching_basic",
      "tdmcp://tutorials/write_a_glsl_top",
    ],
  },
  {
    id: "audio-reactive",
    title: "Audio Reactive Binding",
    when_to_use: "When visuals should move from music or control channels.",
    steps: [
      "Start from synthetic or existing CHOP sources when hardware is unavailable.",
      "Smooth and normalize channels before binding them to visible parameters.",
      "Separate percussive, tonal and broad energy controls when the composition needs nuance.",
    ],
    resource_refs: [
      "tdmcp://operators/CHOP",
      "tdmcp://tutorials/anatomy_of_a_chop",
      "tdmcp://recipes/audio_reactive_feedback",
    ],
  },
  {
    id: "vault-library",
    title: "Vault And Library",
    when_to_use: "When saving reusable looks, presets, recipes or performance notes.",
    steps: [
      "Run doctor first if vault tools fail; missing vault folders are repairable with doctor --fix.",
      "Prefer saved recipes/components over ad-hoc screenshots when the work should be reused.",
      "Use checksummed bundles for handoff or publishing flows.",
    ],
    resource_refs: ["tdmcp://commands", "tdmcp://recipes/search/feedback"],
  },
];

export function readCheatsheetResource(): CheatsheetResource {
  return {
    uri: "tdmcp://cheatsheets",
    count: CHEATSHEETS.length,
    cheatsheets: CHEATSHEETS,
  };
}

export const registerCheatsheetResource: ResourceRegistrar = (server) => {
  server.registerResource(
    "td-cheatsheets",
    "tdmcp://cheatsheets",
    {
      title: "tdmcp cheatsheets",
      description:
        "Compact KB-grounded reminders for common tdmcp workflows, with links to richer resources.",
      mimeType: "application/json",
    },
    async (uri) => jsonContents(uri, readCheatsheetResource()),
  );
};
