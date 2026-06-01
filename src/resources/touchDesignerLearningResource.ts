import type { KnowledgeBase } from "../knowledge/index.js";
import { jsonContents, type ResourceRegistrar } from "./shared.js";

export interface TouchDesignerLearningModule {
  id: string;
  title: string;
  goal: string;
  prompt_topic: string;
  operator_resources: string[];
  tutorial_resources: string[];
  recipe_resources: string[];
}

export interface TouchDesignerLearningResource {
  uri: "tdmcp://learning/touchdesigner";
  title: string;
  prompt: {
    name: "teach_touchdesigner";
    resource_uri: "tdmcp://prompts";
  };
  modules: TouchDesignerLearningModule[];
}

const CURATED_MODULES: TouchDesignerLearningModule[] = [
  {
    id: "operator-families",
    title: "Operator Families",
    goal: "Learn what TOP, CHOP, SOP, DAT, COMP and MAT operators contribute before building networks.",
    prompt_topic: "TouchDesigner operator families",
    operator_resources: [
      "tdmcp://operators/TOP",
      "tdmcp://operators/CHOP",
      "tdmcp://operators/SOP",
      "tdmcp://operators/DAT",
      "tdmcp://operators/COMP",
      "tdmcp://operators/MAT",
    ],
    tutorial_resources: [],
    recipe_resources: [],
  },
  {
    id: "chop-control",
    title: "CHOP Control Signals",
    goal: "Understand time-varying control data, smoothing, and mapping before binding controls.",
    prompt_topic: "CHOP control signals and parameter binding",
    operator_resources: ["tdmcp://operators/CHOP"],
    tutorial_resources: ["tdmcp://tutorials/anatomy_of_a_chop"],
    recipe_resources: ["tdmcp://recipes/audio_spectrum_bars"],
  },
  {
    id: "python-automation",
    title: "Python Automation",
    goal: "Use DAT/Python workflows to script repetitive TD edits without losing the visual graph.",
    prompt_topic: "TouchDesigner Python automation",
    operator_resources: ["tdmcp://operators/DAT", "tdmcp://operators/COMP"],
    tutorial_resources: ["tdmcp://tutorials/introduction_to_python_tutorial"],
    recipe_resources: [],
  },
  {
    id: "interactive-ui",
    title: "Interactive UI",
    goal: "Build small panel systems and list-driven interfaces for performance control.",
    prompt_topic: "TouchDesigner panel and List COMP UI",
    operator_resources: ["tdmcp://operators/COMP", "tdmcp://operators/DAT"],
    tutorial_resources: ["tdmcp://tutorials/build_a_list_comp"],
    recipe_resources: [],
  },
  {
    id: "glsl-shaders",
    title: "GLSL TOP Shaders",
    goal: "Understand GLSL TOP shader structure, uniforms and snippet assembly.",
    prompt_topic: "GLSL TOP pixel shaders",
    operator_resources: ["tdmcp://operators/TOP"],
    tutorial_resources: ["tdmcp://tutorials/write_a_glsl_top"],
    recipe_resources: [],
  },
  {
    id: "video-streaming",
    title: "Video Streaming",
    goal: "Connect live video streams and understand the operator families involved.",
    prompt_topic: "TouchDesigner video streaming",
    operator_resources: ["tdmcp://operators/TOP"],
    tutorial_resources: ["tdmcp://tutorials/video_streaming_user_guide"],
    recipe_resources: [],
  },
];

function existingModules(knowledge: KnowledgeBase): TouchDesignerLearningModule[] {
  const categories = new Set(knowledge.listOperatorCategories());
  return CURATED_MODULES.map((mod) => ({
    ...mod,
    operator_resources: mod.operator_resources.filter((uri) =>
      categories.has(uri.replace("tdmcp://operators/", "")),
    ),
    tutorial_resources: mod.tutorial_resources.filter((uri) =>
      Boolean(knowledge.getTutorial(uri.replace("tdmcp://tutorials/", ""))),
    ),
  })).filter(
    (mod) =>
      mod.operator_resources.length > 0 ||
      mod.tutorial_resources.length > 0 ||
      mod.recipe_resources.length > 0,
  );
}

export function readTouchDesignerLearningResource(
  knowledge: KnowledgeBase,
): TouchDesignerLearningResource {
  return {
    uri: "tdmcp://learning/touchdesigner",
    title: "TouchDesigner Learning Path",
    prompt: {
      name: "teach_touchdesigner",
      resource_uri: "tdmcp://prompts",
    },
    modules: existingModules(knowledge),
  };
}

export const registerTouchDesignerLearningResource: ResourceRegistrar = (server, ctx) => {
  server.registerResource(
    "td-learning-touchdesigner",
    "tdmcp://learning/touchdesigner",
    {
      title: "TouchDesigner learning path",
      description:
        "A curated learning path that pairs the teach_touchdesigner prompt with embedded operator and tutorial resources.",
      mimeType: "application/json",
    },
    async (uri) => jsonContents(uri, readTouchDesignerLearningResource(ctx.knowledge)),
  );
};
