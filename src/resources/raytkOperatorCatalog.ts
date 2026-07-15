import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

/**
 * RayTK (t3kt/raytk) operator (ROP) knowledge catalog — a committed, hand-verified dataset
 * so the AI can pick the right RayTK operator before instancing one with `create_raytk_op` /
 * `create_raytk_scene`. Sourced entirely from `_workspace/raytk-integration/01_map.md` (Wave
 * W0 cartographer output), whose taxonomy was read from the authoritative `src/operators/`
 * tree of the pinned release (build-046 / library 0.46), NOT the unreliable docs homepage.
 *
 * This is intentionally a curated subset of the ~300 ROP masters (the verified per-category
 * examples), not an exhaustive dump. `runtimeMasterPath` is deliberately absent: the master
 * COMP path is install-dependent and must be probed live from the loaded RayTK library, never
 * hardcoded (map §Instancing & Wiring / Risks #1). Op params are not inventoried here (map
 * UNVERIFIED — parse `<op>_params.txt`/`.yaml` in a later wave).
 */

export type RaytkDataType = "Sdf" | "float" | "vec4" | "Ray" | "Light" | "mixed";

export interface RaytkCategory {
  /** Actual folder name under RayTK's `src/operators/`. */
  category: string;
  /** What the category is for. */
  description: string;
  /** Human-readable connector shape (inputs → output data type). */
  connectorShape: string;
  /** Primary output data type flowing out of these ROPs' Definition DAT connector. */
  outputType: RaytkDataType;
  /** Verified example op masters (a curated subset, not exhaustive). */
  ops: string[];
  /** Extra notes / gotchas from the map. */
  note?: string;
}

export interface RaytkOperatorCatalog {
  uri: "tdmcp://raytk/operators";
  toolkit: "raytk";
  release: "build-046";
  libraryVersion: "0.46";
  releaseDate: "2025-08-26";
  source: string;
  /** Hard TD build gate for this release (map §Target Release & Version Gate). */
  versionGate: {
    minBuild: "2025.30770";
    reason: string;
    fallback: string;
  };
  /** Data types that flow through RayTK connectors (typed inputs are constrained by these). */
  dataTypes: RaytkDataType[];
  /** Op-status model — expose stable ops by default (map §Operator Taxonomy). */
  opStatuses: string[];
  /** The smallest chain that yields a rendered TOP (map §Minimal Renderable Chain). */
  minimalChain: {
    description: string;
    chain: string[];
    rendererInputs: { connectorIndex: number; rendererInput: number; role: string }[];
  };
  categoryCount: number;
  categories: RaytkCategory[];
  /** Things the map flagged as out-of-scope or unverified. */
  caveats: string[];
}

/** The verified taxonomy (map §Operator Taxonomy, 18 folders under `src/operators/`). */
const RAYTK_CATEGORIES: RaytkCategory[] = [
  {
    category: "sdf",
    description: "Core 3D signed-distance geometry primitives + fractals (equivalent to SOPs).",
    connectorShape: "optional field inputs (float) → out: Sdf (vec3)",
    outputType: "Sdf",
    ops: [
      "sphereSdf",
      "boxSdf",
      "boxFrameSdf",
      "torusSdf",
      "capsuleSdf",
      "coneSdf",
      "mandelbulbSdf",
      "apollonianSdf",
      "gyroidSdf",
      "sopSdf",
    ],
    note: "69 masters total. sphereSdf has an optional radiusField float input.",
  },
  {
    category: "sdf2d",
    description: "2D signed-distance primitives.",
    connectorShape: "out: Sdf (vec2)",
    outputType: "Sdf",
    ops: ["arcSdf2d", "archSdf2d", "arrowSdf2d", "bezierSdf2d", "arbitraryPolygonSdf2d"],
    note: "imageSdf2d (new in 0.46) converts a TOP to a 2D SDF.",
  },
  {
    category: "field",
    description: "Scalar/vector fields that drive params of other ROPs.",
    connectorShape: "out: float/vec4",
    outputType: "vec4",
    ops: [
      "atmosphereField",
      "axisDistanceField",
      "bandField",
      "bezierCurveField",
      "blackbodyColorField",
      "buildField",
    ],
  },
  {
    category: "combine",
    description: "Boolean/blend combiners taking multiple inputs to one output.",
    connectorShape: "multi-input Sdf → single out Sdf",
    outputType: "Sdf",
    ops: [
      "combine",
      "simpleUnion",
      "simpleIntersect",
      "simpleDiff",
      "composeSdf",
      "shapedCombine",
      "mixFields",
      "switch",
      "iterationSwitch",
    ],
    note: "`combine` has a Combine menu: simple/smooth/round/chamfer × union/intersect/diff.",
  },
  {
    category: "filter",
    description: "Inline modifiers inserted into a chain (e.g. twist between an SDF and render).",
    connectorShape: "in: ROP → out: same type, modified",
    outputType: "mixed",
    ops: [
      "applyTransform",
      "adjustColor",
      "assignColor",
      "assignUV",
      "assignAttribute",
      "assignTransparency",
      "twist",
    ],
  },
  {
    category: "camera",
    description: "Cameras that feed the renderer's Camera input.",
    connectorShape: "out: Ray",
    outputType: "Ray",
    ops: [
      "basicCamera",
      "lookAtCamera",
      "orthoCamera",
      "fisheyeCamera",
      "isoCamera",
      "fieldCamera",
      "linkedCamera",
      "splitCamera",
      "cameraRemap",
    ],
  },
  {
    category: "material",
    description: "Materials/contributions inserted inline before the renderer.",
    connectorShape: "in: SDF chain → out: SDF + material",
    outputType: "Sdf",
    ops: [
      "basicMat",
      "ambientOcclusionContrib",
      "backgroundFieldContrib",
      "curvatureContrib",
      "colorizeSdf2d",
    ],
    note: "`*Contrib` ops compose into materials.",
  },
  {
    category: "light",
    description: "Lights that feed the renderer's Light input.",
    connectorShape: "out: Light",
    outputType: "Light",
    ops: [
      "pointLight",
      "directionalLight",
      "ambientLight",
      "spotLight",
      "axisLight",
      "ringLight",
      "multiLight",
      "hardShadow",
      "softShadow",
      "instanceLight",
    ],
    note: "multiLight gained color/translate in 0.46.",
  },
  {
    category: "output",
    description: "Output ROPs — build+run the shader in a GLSL TOP (analogous to a Render TOP).",
    connectorShape: "multi-input → GLSL TOP image",
    outputType: "mixed",
    ops: [
      "raymarchRender3D",
      "experimentalRaymarchRender3D",
      "render2D",
      "fieldRender",
      "customRender",
      "functionGraphRender",
      "pointMapRender",
      "raymarchObject",
      "sopExport",
      "renderSelect",
      "raymarchPreviewPanel",
    ],
    note: "raymarchRender3D is the main renderer: input 1=scene, 2=Camera, 3=Light; uses a built-in camera+light by default. Shader compiles on a background thread — the first frame may be black.",
  },
  {
    category: "convert",
    description: "Dimension/space conversions.",
    connectorShape: "type → type",
    outputType: "mixed",
    ops: ["coordTo2D", "coordTo3D", "crossSection", "extrude", "extrudeLine"],
  },
  {
    category: "pattern",
    description: "Procedural patterns.",
    connectorShape: "out: float/vec4",
    outputType: "vec4",
    ops: [
      "checkerPattern",
      "gridPattern",
      "brickPattern",
      "hexagonalGridPattern",
      "blobRingPattern",
      "hexagonalTruchetPattern",
    ],
  },
  {
    category: "function",
    description: "Math/curve functions driving params.",
    connectorShape: "value → value",
    outputType: "float",
    ops: [
      "addFn",
      "easeFn",
      "chopFn",
      "colorPaletteFn",
      "almostIdentityFn",
      "cubicPulseFn",
      "crossFn",
    ],
  },
  {
    category: "time",
    description: "Time-based drivers.",
    connectorShape: "out: float",
    outputType: "float",
    ops: ["timeField", "lfoField", "timeShift"],
  },
  {
    category: "post",
    description: "Extra output buffers/passes taken off a render.",
    connectorShape: "render → TOP",
    outputType: "mixed",
    ops: ["depthMap", "stepMap", "worldPosMap", "nearHitMap", "objectIdMask"],
  },
  {
    category: "utility",
    description: "Plumbing/debug/variable ops.",
    connectorShape: "mixed",
    outputType: "mixed",
    ops: [
      "exposeValue",
      "getAttribute",
      "injectGlobalPosition",
      "injectObjectId",
      "extractDebugValues",
    ],
  },
  {
    category: "geo",
    description: "Hybrid path: RayTK ROPs as a TD GLSL Material for rasterized geometry.",
    connectorShape: "GLSL Material-style",
    outputType: "mixed",
    ops: ["geoMaterial", "pixelStage", "vertexStage"],
  },
  {
    category: "pop",
    description: "Placeholder for TD POPs — stub/empty (no user ops yet). Out of scope.",
    connectorShape: "—",
    outputType: "mixed",
    ops: [],
    note: "Only index.tox — effectively no user ops.",
  },
  {
    category: "custom",
    description: "Scaffold for authoring your own ROP.",
    connectorShape: "user-defined",
    outputType: "mixed",
    ops: ["customOp"],
  },
];

/** Builds the full RayTK operator catalog (pure; no I/O). */
export function readRaytkOperatorCatalog(): RaytkOperatorCatalog {
  return {
    uri: "tdmcp://raytk/operators",
    toolkit: "raytk",
    release: "build-046",
    libraryVersion: "0.46",
    releaseDate: "2025-08-26",
    source:
      "t3kt/raytk src/operators tree @ build-046 — see _workspace/raytk-integration/01_map.md (Wave W0).",
    versionGate: {
      minBuild: "2025.30770",
      reason:
        "RayTK 0.46 (build-046) requires the TouchDesigner 2025.30770 experimental build and is NOT compatible with the 2023.x releases.",
      fallback: "On a 2023.x TouchDesigner build, pin RayTK <=0.45 instead of the latest release.",
    },
    dataTypes: ["Sdf", "float", "vec4", "Ray", "Light", "mixed"],
    opStatuses: ["default", "Alpha", "Beta", "Deprecated"],
    minimalChain: {
      description:
        "Smallest scene that yields a rendered TOP. raymarchRender3D uses a built-in camera+light by default, so SDF → render → Null TOP is genuinely the minimum.",
      chain: ["sphereSdf", "raymarchRender3D", "nullTOP"],
      // `connectorIndex` is 0-based (matches TouchDesigner inputConnectors[] and create_raytk_op's
      // `input_index`); `rendererInput` is the 1-based label RayTK docs use. Both are embedded to
      // avoid off-by-one wiring mistakes.
      rendererInputs: [
        { connectorIndex: 0, rendererInput: 1, role: "scene (the SDF / ROP chain)" },
        { connectorIndex: 1, rendererInput: 2, role: "camera (e.g. lookAtCamera)" },
        { connectorIndex: 2, rendererInput: 3, role: "light (e.g. pointLight)" },
      ],
    },
    categoryCount: RAYTK_CATEGORIES.length,
    categories: RAYTK_CATEGORIES,
    caveats: [
      "Curated subset of ~300 masters, not exhaustive — verify against the loaded library.",
      "Master COMP paths are install-dependent — probe live, never hardcode (create_raytk_op does this).",
      "Volumes/Abstractions are Patreon addons, NOT in the free release — there is no core `volume` category.",
      "Op params are not inventoried here; parse <op>_params.txt/.yaml when needed.",
      "sdf2d full primitive names + convert revolve/sweep were partially truncated in the map (UNVERIFIED).",
    ],
  };
}

export const registerRaytkOperatorCatalogResource: ResourceRegistrar = (server) => {
  // Whole-catalog resource.
  server.registerResource(
    "raytk-operators",
    "tdmcp://raytk/operators",
    {
      title: "RayTK operator (ROP) catalog",
      description:
        "The RayTK raymarching/SDF toolkit operator taxonomy (18 categories, verified op masters, typed Sdf/float/vec4/Ray/Light connectors, the TD 2025.30770 version gate, and the minimal renderable chain). Consult before create_raytk_op / create_raytk_scene to pick the right ROP. Complementary to the GLSL create_raymarch_scene.",
      mimeType: "application/json",
    },
    async (uri) => jsonContents(uri, readRaytkOperatorCatalog()),
  );

  // Per-category resource: tdmcp://raytk/operators/{category}
  const template = new ResourceTemplate("tdmcp://raytk/operators/{category}", {
    list: async () => ({
      resources: readRaytkOperatorCatalog().categories.map((entry) => ({
        uri: `tdmcp://raytk/operators/${entry.category}`,
        name: `RayTK: ${entry.category}`,
        description: entry.description,
        mimeType: "application/json",
      })),
    }),
    complete: {
      category: async (value) =>
        readRaytkOperatorCatalog()
          .categories.map((entry) => entry.category)
          .filter((name) => name.startsWith(value))
          .slice(0, 50),
    },
  });

  server.registerResource(
    "raytk-operator-category",
    template,
    {
      title: "RayTK operators by category",
      description:
        "Read one RayTK category (sdf, combine, camera, light, material, output, filter, …) to list its verified op masters and connector shape.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const category = firstVar(variables.category).toLowerCase();
      const catalog = readRaytkOperatorCatalog();
      const entry = catalog.categories.find((item) => item.category === category);
      if (!entry) {
        return jsonContents(uri, {
          error: `Unknown RayTK category "${category}".`,
          available: catalog.categories.map((item) => item.category),
        });
      }
      return jsonContents(uri, entry);
    },
  );
};
