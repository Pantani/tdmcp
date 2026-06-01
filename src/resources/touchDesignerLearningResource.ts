import type { KnowledgeBase } from "../knowledge/index.js";
import { jsonContents, type ResourceRegistrar } from "./shared.js";

export interface TouchDesignerLearningModule {
  id: string;
  title: string;
  goal: string;
  promptTopic: string;
  operatorResources: string[];
  tutorialResources: string[];
  recipeResources: string[];
}

export interface TouchDesignerLearningResource {
  uri: "tdmcp://learning/touchdesigner";
  title: string;
  prompt: {
    name: "teach_touchdesigner";
    resourceUri: "tdmcp://prompts";
  };
  modules: TouchDesignerLearningModule[];
}

const CURATED_MODULES: TouchDesignerLearningModule[] = [
  {
    id: "operator-families",
    title: "Operator Families",
    goal: "Learn what TOP, CHOP, SOP, DAT, COMP and MAT operators contribute before building networks.",
    promptTopic: "TouchDesigner operator families",
    operatorResources: [
      "tdmcp://operators/TOP",
      "tdmcp://operators/CHOP",
      "tdmcp://operators/SOP",
      "tdmcp://operators/DAT",
      "tdmcp://operators/COMP",
      "tdmcp://operators/MAT",
    ],
    tutorialResources: [],
    recipeResources: [],
  },
  {
    id: "chop-control",
    title: "CHOP Control Signals",
    goal: "Understand time-varying control data, smoothing, and mapping before binding controls.",
    promptTopic: "CHOP control signals and parameter binding",
    operatorResources: ["tdmcp://operators/CHOP"],
    tutorialResources: ["tdmcp://tutorials/anatomy_of_a_chop"],
    recipeResources: ["tdmcp://recipes/audio_spectrum_bars"],
  },
  {
    id: "python-automation",
    title: "Python Automation",
    goal: "Use DAT/Python workflows to script repetitive TD edits without losing the visual graph.",
    promptTopic: "TouchDesigner Python automation",
    operatorResources: ["tdmcp://operators/DAT", "tdmcp://operators/COMP"],
    tutorialResources: ["tdmcp://tutorials/introduction_to_python_tutorial"],
    recipeResources: [],
  },
  {
    id: "interactive-ui",
    title: "Interactive UI",
    goal: "Build small panel systems and list-driven interfaces for performance control.",
    promptTopic: "TouchDesigner panel and List COMP UI",
    operatorResources: ["tdmcp://operators/COMP", "tdmcp://operators/DAT"],
    tutorialResources: ["tdmcp://tutorials/build_a_list_comp"],
    recipeResources: [],
  },
  {
    id: "glsl-shaders",
    title: "GLSL TOP Shaders",
    goal: "Understand GLSL TOP shader structure, uniforms and snippet assembly.",
    promptTopic: "GLSL TOP pixel shaders",
    operatorResources: ["tdmcp://operators/TOP"],
    tutorialResources: ["tdmcp://tutorials/write_a_glsl_top"],
    recipeResources: [],
  },
  {
    id: "video-streaming",
    title: "Video Streaming",
    goal: "Connect live video streams and understand the operator families involved.",
    promptTopic: "TouchDesigner video streaming",
    operatorResources: ["tdmcp://operators/TOP"],
    tutorialResources: ["tdmcp://tutorials/video_streaming_user_guide"],
    recipeResources: [],
  },
];

function existingModules(knowledge: KnowledgeBase): TouchDesignerLearningModule[] {
  const categories = new Set(knowledge.listOperatorCategories());
  return CURATED_MODULES.map((mod) => ({
    ...mod,
    operatorResources: mod.operatorResources.filter((uri) =>
      categories.has(uri.replace("tdmcp://operators/", "")),
    ),
    tutorialResources: mod.tutorialResources.filter((uri) =>
      Boolean(knowledge.getTutorial(uri.replace("tdmcp://tutorials/", ""))),
    ),
  })).filter(
    (mod) =>
      mod.operatorResources.length > 0 ||
      mod.tutorialResources.length > 0 ||
      mod.recipeResources.length > 0,
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
      resourceUri: "tdmcp://prompts",
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
