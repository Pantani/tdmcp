import {
  type DeferredPackage,
  DeferredPackageSchema,
  type PackageManifest,
  PackageManifestSchema,
} from "./types.js";

export { PackageManifestSchema } from "./types.js";

export const FULL_SUPPORT_PACKAGE_IDS = [
  "mediapipe-touchdesigner",
  "raytk",
  "functionstore-tools",
  "touchdesigner-shared",
  "shader-park-td",
  "sop-to-svg",
  "augmenta-touchdesigner",
  "simplemixer",
] as const;

function manifest(input: PackageManifest): PackageManifest {
  return PackageManifestSchema.parse(input);
}

function github(
  repo: string,
  defaultRef = "main",
): { type: "github"; url: string; repo: string; defaultRef: string } {
  return { type: "github", url: `https://github.com/${repo}`, repo, defaultRef };
}

const commonSecurity = [
  "Downloaded archives are staged locally; package scripts are not executed by tdmcp.",
  "Python dependencies, model downloads, GPU setup, and external app setup require explicit manual action.",
];

export const PACKAGE_MANIFESTS: PackageManifest[] = [
  manifest({
    id: "mediapipe-touchdesigner",
    aliases: ["mediapipe", "torinmb-mediapipe", "mediapipe-td"],
    displayName: "MediaPipe TouchDesigner",
    description: "TouchDesigner MediaPipe tracker and components for pose/body tracking workflows.",
    homepage: "https://github.com/torinmb/mediapipe-touchdesigner",
    source: github("torinmb/mediapipe-touchdesigner"),
    license: "MIT",
    tags: ["tracking", "mediapipe", "body", "camera"],
    packageType: "component",
    supportLevel: "full",
    platforms: ["macos", "windows"],
    tdVersionRange: "2022+",
    requiresTouchDesignerBridge: false,
    externalDependencies: [
      {
        name: "Camera permission",
        kind: "hardware",
        required: false,
        notes: "macOS may prompt for camera access when the MediaPipe component starts.",
      },
    ],
    installStrategy: {
      mode: "tox-import",
      preferReleaseAsset: true,
      importableExtensions: [".tox"],
      manualSteps: ["Drag or import the MediaPipe .tox if the bridge is offline."],
    },
    healthChecks: [
      {
        id: "mediapipe-tox",
        description: "Verify a MediaPipe .tox artifact is present after staging.",
        severity: "required",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: ["MediaPipe.tox", "mediapipe.tox"],
      manualSteps: ["Use setup_body_tracking after staging to build a pose skeleton network."],
    },
    uninstallStrategy: {
      mode: "delete-staged",
      notes: "Remove the staged files and delete any imported COMP manually from TouchDesigner.",
    },
    securityNotes: commonSecurity,
  }),
  manifest({
    id: "raytk",
    aliases: ["raymarching-toolkit", "t3kt-raytk"],
    displayName: "RayTK",
    description: "Raymarching and signed-distance-field toolkit for TouchDesigner.",
    homepage: "https://github.com/t3kt/raytk",
    source: github("t3kt/raytk", "master"),
    license: "See source repository",
    tags: ["raymarching", "sdf", "shader", "toolkit"],
    packageType: "toolkit",
    supportLevel: "full",
    platforms: ["macos", "windows"],
    tdVersionRange: "2022+",
    requiresTouchDesignerBridge: false,
    externalDependencies: [],
    installStrategy: {
      mode: "tox-import",
      preferReleaseAsset: true,
      importableExtensions: [".tox", ".toe"],
      manualSteps: ["Stage RayTK and import the package/tox files that match your TD version."],
    },
    healthChecks: [
      {
        id: "raytk-artifacts",
        description: "Verify RayTK staged at least one .tox or .toe artifact.",
        severity: "warning",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: ["raytk.tox", "RayTK.tox"],
      manualSteps: ["For full RayTK projects, open the staged project/template directly."],
    },
    uninstallStrategy: {
      mode: "delete-staged",
      notes:
        "Remove staged files; imported RayTK COMPs should be deleted in TD if no longer needed.",
    },
    securityNotes: commonSecurity,
  }),
  manifest({
    id: "functionstore-tools",
    aliases: ["functionstore", "function-store-tools", "FunctionStore_tools"],
    displayName: "Function Store Tools",
    description: "Function Store productivity and workflow tools for TouchDesigner.",
    homepage: "https://github.com/function-store/FunctionStore_tools",
    source: github("function-store/FunctionStore_tools", "master"),
    license: "See source repository",
    tags: ["workflow", "tools", "productivity", "tox"],
    packageType: "collection",
    supportLevel: "full",
    platforms: ["macos", "windows"],
    requiresTouchDesignerBridge: false,
    externalDependencies: [],
    installStrategy: {
      mode: "tox-import",
      preferReleaseAsset: false,
      importableExtensions: [".tox"],
      manualSteps: ["Import individual staged .tox tools as needed."],
    },
    healthChecks: [
      {
        id: "functionstore-tox",
        description: "Verify at least one Function Store .tox was staged.",
        severity: "warning",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: [],
      manualSteps: ["Use `tdmcp info functionstore-tools --json` to inspect staged artifacts."],
    },
    uninstallStrategy: {
      mode: "delete-staged",
      notes: "Delete staged files and any imported tools you placed in the TD project.",
    },
    securityNotes: commonSecurity,
  }),
  manifest({
    id: "touchdesigner-shared",
    aliases: ["td-shared", "dbraun-touchdesigner-shared", "TouchDesigner_Shared"],
    displayName: "TouchDesigner Shared",
    description:
      "Large shared collection of TouchDesigner components, examples, and reusable networks.",
    homepage: "https://github.com/DBraun/TouchDesigner_Shared",
    source: github("DBraun/TouchDesigner_Shared", "master"),
    license: "See source repository",
    tags: ["collection", "examples", "components"],
    packageType: "collection",
    supportLevel: "full",
    platforms: ["macos", "windows"],
    requiresTouchDesignerBridge: false,
    externalDependencies: [],
    installStrategy: {
      mode: "stage-only",
      preferReleaseAsset: false,
      importableExtensions: [".tox", ".toe"],
      manualSteps: [
        "Do not import the full collection blindly; inspect staged artifacts and import subcomponents selectively.",
      ],
    },
    healthChecks: [
      {
        id: "shared-stage",
        description: "Verify the collection is staged and searchable from disk.",
        severity: "info",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: [],
      manualSteps: [
        "Use package info/search output to pick a subcomponent before importing it into a project.",
      ],
    },
    uninstallStrategy: {
      mode: "delete-staged",
      notes: "Remove the staged collection; delete imported subcomponents manually.",
    },
    securityNotes: commonSecurity,
  }),
  manifest({
    id: "shader-park-td",
    aliases: ["shader-park", "shader-park-touchdesigner", "shaderpark"],
    displayName: "Shader Park TouchDesigner",
    description: "Shader Park integration and components for TouchDesigner shader workflows.",
    homepage: "https://github.com/shader-park/shader-park-touchdesigner",
    source: github("shader-park/shader-park-touchdesigner"),
    license: "See source repository",
    tags: ["shader", "glsl", "creative-coding"],
    packageType: "component",
    supportLevel: "full",
    platforms: ["macos", "windows"],
    requiresTouchDesignerBridge: false,
    externalDependencies: [],
    installStrategy: {
      mode: "tox-import",
      preferReleaseAsset: false,
      importableExtensions: [".tox"],
      manualSteps: ["Import the staged Shader Park .tox into your project."],
    },
    healthChecks: [
      {
        id: "shaderpark-tox",
        description: "Verify a Shader Park .tox artifact is present.",
        severity: "warning",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: ["ShaderPark.tox", "shader_park.tox"],
      manualSteps: ["Open the staged README for Shader Park authoring notes."],
    },
    uninstallStrategy: {
      mode: "delete-staged",
      notes: "Remove staged files and any imported Shader Park COMP.",
    },
    securityNotes: commonSecurity,
  }),
  manifest({
    id: "sop-to-svg",
    aliases: ["touchdesigner-sop-to-svg", "sop-svg", "raganmd-sop-to-svg"],
    displayName: "SOP to SVG",
    description: "Small SOP-to-SVG export utility for fabrication and plotter workflows.",
    homepage: "https://github.com/raganmd/touchdesigner-sop-to-svg",
    source: github("raganmd/touchdesigner-sop-to-svg", "master"),
    license: "See source repository",
    tags: ["sop", "svg", "plotter", "fabrication"],
    packageType: "component",
    supportLevel: "full",
    platforms: ["macos", "windows"],
    requiresTouchDesignerBridge: false,
    externalDependencies: [],
    installStrategy: {
      mode: "tox-import",
      preferReleaseAsset: false,
      importableExtensions: [".tox"],
      manualSteps: ["Import the staged SOP-to-SVG .tox into your project."],
    },
    healthChecks: [
      {
        id: "sop-svg-tox",
        description: "Verify the SOP-to-SVG component file is present.",
        severity: "warning",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: ["SOPtoSVG.tox", "sop_to_svg.tox"],
      manualSteps: ["Wire a SOP into the component and test export in TouchDesigner."],
    },
    uninstallStrategy: {
      mode: "delete-staged",
      notes: "Remove staged files and any imported SOP-to-SVG COMP.",
    },
    securityNotes: commonSecurity,
  }),
  manifest({
    id: "augmenta-touchdesigner",
    aliases: ["augmenta", "augmenta-td", "Augmenta-TouchDesigner"],
    displayName: "Augmenta TouchDesigner",
    description: "Augmenta OSC/TUIO protocol adapter and TouchDesigner integration components.",
    homepage: "https://github.com/Augmenta-tech/Augmenta-TouchDesigner",
    source: github("Augmenta-tech/Augmenta-TouchDesigner", "master"),
    license: "See source repository",
    tags: ["osc", "tuio", "tracking", "installation"],
    packageType: "external-adapter",
    supportLevel: "full",
    platforms: ["macos", "windows"],
    requiresTouchDesignerBridge: false,
    externalDependencies: [
      {
        name: "Augmenta sensor or simulator",
        kind: "hardware",
        required: false,
        notes: "Needed for live tracking data; staged TD components can be inspected without it.",
      },
    ],
    installStrategy: {
      mode: "tox-import",
      preferReleaseAsset: false,
      importableExtensions: [".tox", ".toe"],
      manualSteps: ["Configure OSC/TUIO endpoints after staging/import."],
    },
    healthChecks: [
      {
        id: "augmenta-endpoint",
        description: "Confirm the intended OSC/TUIO source and port before going live.",
        severity: "warning",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: [],
      manualSteps: ["Set your Augmenta host/port values in the imported component."],
    },
    uninstallStrategy: {
      mode: "delete-staged",
      notes: "Remove staged files and imported adapter components.",
    },
    securityNotes: commonSecurity,
  }),
  manifest({
    id: "simplemixer",
    aliases: ["simple-mixer", "richard-burns-simplemixer"],
    displayName: "SimpleMixer",
    description: "VJ/performance mixer project template for TouchDesigner.",
    homepage: "https://github.com/Richard-Burns/SimpleMixer",
    source: github("Richard-Burns/SimpleMixer", "master"),
    license: "See source repository",
    tags: ["vj", "mixer", "performance", "template"],
    packageType: "project-template",
    supportLevel: "full",
    platforms: ["macos", "windows"],
    requiresTouchDesignerBridge: false,
    externalDependencies: [],
    installStrategy: {
      mode: "project-template",
      preferReleaseAsset: false,
      importableExtensions: [".toe", ".tox"],
      manualSteps: ["Open the staged .toe project/template directly instead of importing blindly."],
    },
    healthChecks: [
      {
        id: "simplemixer-template",
        description: "Verify a .toe project/template or documented startup file is staged.",
        severity: "warning",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: [],
      manualSteps: [
        "Open the staged project in TouchDesigner and save your own copy before editing.",
      ],
    },
    uninstallStrategy: {
      mode: "delete-staged",
      notes: "Remove staged template files; TouchDesigner projects saved elsewhere are user-owned.",
    },
    securityNotes: commonSecurity,
  }),
  manifest({
    id: "td-yolo",
    aliases: ["tdyolo", "td-yolo-object-detection"],
    displayName: "TDYolo",
    description: "YOLO object detection workflow for TouchDesigner.",
    homepage: "https://github.com/patrickhartono/TDYolo",
    source: github("patrickhartono/TDYolo", "master"),
    license: "See source repository",
    tags: ["ai", "object-detection", "yolo", "gpu"],
    packageType: "doctor-only",
    supportLevel: "doctor-only",
    platforms: ["windows"],
    requiresTouchDesignerBridge: false,
    externalDependencies: [
      {
        name: "YOLO runtime/models",
        kind: "model",
        required: true,
        notes:
          "Model files and runtime setup must be installed manually; tdmcp does not download models.",
      },
      {
        name: "Python/GPU dependencies",
        kind: "python",
        required: true,
        notes: "Install only after reviewing the upstream instructions for your machine.",
      },
    ],
    installStrategy: {
      mode: "manual",
      preferReleaseAsset: false,
      importableExtensions: [".tox", ".toe"],
      manualSteps: ["Run `tdmcp doctor td-yolo --json` and follow upstream model/runtime setup."],
    },
    healthChecks: [
      {
        id: "no-hidden-model-download",
        description: "Confirm model/runtime downloads are explicit and user-approved.",
        severity: "required",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: [],
      manualSteps: ["After manual setup, stage TD files and wire model paths in TouchDesigner."],
    },
    uninstallStrategy: { mode: "manual", notes: "Remove model/runtime dependencies manually." },
    securityNotes: commonSecurity,
  }),
  manifest({
    id: "td-depth-anything",
    aliases: ["tddepthanything", "depth-anything-td"],
    displayName: "TDDepthAnything",
    description: "Monocular depth workflow for TouchDesigner using Depth Anything models.",
    homepage: "https://github.com/olegchomp/TDDepthAnything",
    source: github("olegchomp/TDDepthAnything", "main"),
    license: "See source repository",
    tags: ["ai", "depth", "gpu", "model"],
    packageType: "doctor-only",
    supportLevel: "doctor-only",
    platforms: ["windows"],
    requiresTouchDesignerBridge: false,
    externalDependencies: [
      {
        name: "Depth Anything model files",
        kind: "model",
        required: true,
        notes: "Models are not downloaded by tdmcp; choose and install them explicitly.",
      },
      {
        name: "CUDA/TensorRT runtime",
        kind: "gpu",
        required: true,
        notes: "GPU runtime setup is machine-specific and stays manual.",
      },
    ],
    installStrategy: {
      mode: "manual",
      preferReleaseAsset: false,
      importableExtensions: [".tox", ".toe"],
      manualSteps: ["Run doctor and follow upstream CUDA/TensorRT/model setup instructions."],
    },
    healthChecks: [
      {
        id: "depth-runtime",
        description: "Check model and GPU runtime prerequisites before import.",
        severity: "required",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: [],
      manualSteps: ["Only import after model/runtime paths are configured manually."],
    },
    uninstallStrategy: { mode: "manual", notes: "Remove model/runtime dependencies manually." },
    securityNotes: commonSecurity,
  }),
  manifest({
    id: "comfyui-td",
    aliases: ["comfyui-touchdesigner", "ComfyUI-TD"],
    displayName: "ComfyUI-TD",
    description: "TouchDesigner adapter for talking to an external ComfyUI service.",
    homepage: "https://github.com/JiSenHua/ComfyUI-TD",
    source: github("JiSenHua/ComfyUI-TD", "main"),
    license: "See source repository",
    tags: ["ai", "comfyui", "adapter", "service"],
    packageType: "external-adapter",
    supportLevel: "doctor-only",
    platforms: ["macos", "windows", "linux"],
    requiresTouchDesignerBridge: false,
    externalDependencies: [
      {
        name: "ComfyUI service",
        kind: "service",
        required: true,
        notes:
          "tdmcp can stage TD-side files, but ComfyUI itself must be installed and running separately.",
      },
    ],
    installStrategy: {
      mode: "manual",
      preferReleaseAsset: false,
      importableExtensions: [".tox", ".toe"],
      manualSteps: ["Configure a ComfyUI endpoint such as http://127.0.0.1:8188 before live use."],
    },
    healthChecks: [
      {
        id: "comfyui-endpoint",
        description: "Verify the ComfyUI HTTP endpoint and workflow paths.",
        severity: "required",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: [],
      manualSteps: ["Set the ComfyUI endpoint in the TD-side adapter after staging."],
    },
    uninstallStrategy: { mode: "manual", notes: "Remove adapter files and ComfyUI separately." },
    securityNotes: commonSecurity,
  }),
  manifest({
    id: "touchdiffusion",
    aliases: ["touch-diffusion"],
    displayName: "TouchDiffusion",
    description: "Real-time diffusion workflow for TouchDesigner.",
    homepage: "https://github.com/olegchomp/TouchDiffusion",
    source: github("olegchomp/TouchDiffusion", "main"),
    license: "See source repository",
    tags: ["ai", "diffusion", "gpu", "model"],
    packageType: "doctor-only",
    supportLevel: "doctor-only",
    platforms: ["windows"],
    requiresTouchDesignerBridge: false,
    externalDependencies: [
      {
        name: "Diffusion model files",
        kind: "model",
        required: true,
        notes: "Models are never auto-installed by tdmcp.",
      },
      {
        name: "GPU inference runtime",
        kind: "gpu",
        required: true,
        notes: "Install runtime dependencies manually from upstream guidance.",
      },
    ],
    installStrategy: {
      mode: "manual",
      preferReleaseAsset: false,
      importableExtensions: [".tox", ".toe"],
      manualSteps: ["Use doctor first; do not auto-install model or GPU dependencies."],
    },
    healthChecks: [
      {
        id: "touchdiffusion-models",
        description: "Confirm model/runtime setup is explicit before use.",
        severity: "required",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: [],
      manualSteps: ["Only wire the TD project after manual model/runtime setup."],
    },
    uninstallStrategy: { mode: "manual", notes: "Remove external models/runtime manually." },
    securityNotes: commonSecurity,
  }),
  manifest({
    id: "geopix",
    aliases: ["geopix-td", "enviral-geopix"],
    displayName: "GeoPix",
    description: "Lighting and pixel-mapping application ecosystem built around TouchDesigner.",
    homepage: "https://github.com/EnviralDesign/GeoPix",
    source: github("EnviralDesign/GeoPix", "master"),
    license: "See source repository",
    tags: ["lighting", "pixel-mapping", "application"],
    packageType: "project-template",
    supportLevel: "stage-only",
    platforms: ["windows"],
    requiresTouchDesignerBridge: false,
    externalDependencies: [
      {
        name: "Lighting hardware / show network",
        kind: "hardware",
        required: false,
        notes: "Project setup depends on the target lighting network.",
      },
    ],
    installStrategy: {
      mode: "project-template",
      preferReleaseAsset: false,
      importableExtensions: [".toe", ".tox"],
      manualSteps: ["Stage as an application/template; open upstream project files manually."],
    },
    healthChecks: [
      {
        id: "geopix-template",
        description: "Verify project files are staged and read upstream setup notes.",
        severity: "warning",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: [],
      manualSteps: ["Treat GeoPix as an app/template, not a small component import."],
    },
    uninstallStrategy: { mode: "delete-staged", notes: "Remove staged app/template files." },
    securityNotes: commonSecurity,
  }),
  manifest({
    id: "td-ableton",
    aliases: ["tdableton", "touchdesigner-ableton", "ableton"],
    displayName: "TDAbleton",
    description: "Official TouchDesigner integration for Ableton Live workflows.",
    homepage: "https://docs.derivative.ca/TDAbleton",
    source: {
      type: "official-docs",
      url: "https://docs.derivative.ca/TDAbleton",
      defaultRef: "official",
    },
    license: "Official Derivative integration",
    tags: ["ableton", "daw", "music", "external"],
    packageType: "external-adapter",
    supportLevel: "doctor-only",
    platforms: ["macos", "windows"],
    requiresTouchDesignerBridge: false,
    externalDependencies: [
      {
        name: "Ableton Live",
        kind: "daw",
        required: true,
        notes: "Ableton Live must be installed and configured outside tdmcp.",
      },
      {
        name: "Max for Live / Ableton scripts",
        kind: "application",
        required: true,
        notes: "Follow the official TDAbleton setup; tdmcp does not copy scripts into Ableton.",
      },
    ],
    installStrategy: {
      mode: "manual",
      preferReleaseAsset: false,
      importableExtensions: [],
      manualSteps: ["Follow the official TDAbleton setup in TouchDesigner and Ableton Live."],
    },
    healthChecks: [
      {
        id: "ableton-installed",
        description: "Confirm Ableton Live and required scripts are installed manually.",
        severity: "required",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: [],
      manualSteps: ["Do not report a complete install unless Ableton-side setup is present."],
    },
    uninstallStrategy: { mode: "manual", notes: "Remove Ableton/Max scripts manually if needed." },
    securityNotes: commonSecurity,
  }),
  manifest({
    id: "td-bitwig",
    aliases: ["tdbitwig", "touchdesigner-bitwig", "bitwig"],
    displayName: "TDBitwig",
    description: "Official TouchDesigner integration for Bitwig Studio workflows.",
    homepage: "https://docs.derivative.ca/TDBitwig",
    source: {
      type: "official-docs",
      url: "https://docs.derivative.ca/TDBitwig",
      defaultRef: "official",
    },
    license: "Official Derivative integration",
    tags: ["bitwig", "daw", "music", "external"],
    packageType: "external-adapter",
    supportLevel: "doctor-only",
    platforms: ["macos", "windows", "linux"],
    requiresTouchDesignerBridge: false,
    externalDependencies: [
      {
        name: "Bitwig Studio",
        kind: "daw",
        required: true,
        notes: "Bitwig Studio must be installed and configured outside tdmcp.",
      },
      {
        name: "Bitwig controller extension",
        kind: "application",
        required: true,
        notes: "Follow official TDBitwig setup; tdmcp does not modify Bitwig configuration.",
      },
    ],
    installStrategy: {
      mode: "manual",
      preferReleaseAsset: false,
      importableExtensions: [],
      manualSteps: ["Follow the official TDBitwig setup in TouchDesigner and Bitwig Studio."],
    },
    healthChecks: [
      {
        id: "bitwig-installed",
        description: "Confirm Bitwig and required controller extension setup manually.",
        severity: "required",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: [],
      manualSteps: ["Do not report a complete install unless Bitwig-side setup is present."],
    },
    uninstallStrategy: { mode: "manual", notes: "Remove Bitwig integration files manually." },
    securityNotes: commonSecurity,
  }),
];

function deferred(input: DeferredPackage): DeferredPackage {
  return DeferredPackageSchema.parse(input);
}

export const DEFERRED_PACKAGES: DeferredPackage[] = [
  deferred({
    id: "kantan-mapper",
    aliases: ["kantan", "camschnappr", "stoner", "projectorblend", "projector-blend"],
    displayName: "Kantan Mapper / CamSchnappr / Stoner / ProjectorBlend",
    reason:
      "Official or built-in TouchDesigner projection mapping tools, not third-party package-manager targets.",
  }),
  deferred({
    id: "opencv-onnx",
    aliases: ["opencv", "onnx", "onnx-workflows"],
    displayName: "OpenCV / ONNX workflows",
    reason:
      "Workflow/API capability, not one installable TD library; better suited to recipes/templates later.",
  }),
  deferred({
    id: "nvidia-rtx-video-top",
    aliases: ["rtx-video-top", "nvidia-rtx"],
    displayName: "NVIDIA RTX Video TOP",
    reason:
      "Official/native/GPU-specific operator integration, not a normal community library install.",
  }),
  deferred({
    id: "touchengine-unreal",
    aliases: ["touchengine", "unreal", "touchengine-for-unreal"],
    displayName: "TouchEngine for Unreal Engine",
    reason:
      "Unreal Engine plugin, not a TouchDesigner package install target; could become an external-tool doctor later.",
  }),
  deferred({
    id: "pytorchtop",
    aliases: ["pytorch-top", "pythorchop"],
    displayName: "PyTorchTOP",
    reason: "C++/CUDA custom-operator example; too heavy and risky for the MVP package manager.",
  }),
  deferred({
    id: "other-mcp-servers",
    aliases: ["embody", "touchdesigner-mcp", "touchdesigner-mcp-variants"],
    displayName: "Other MCP servers / Embody / touchdesigner-mcp variants",
    reason: "Alternative/control-layer systems, not TouchDesigner plugins to install inside tdmcp.",
  }),
];

export function normalizePackageId(value: string): string {
  return value
    .trim()
    .replace(/^@/, "")
    .replace(/\.git$/i, "")
    .replace(/_/g, "-")
    .replace(/\s+/g, "-")
    .toLowerCase();
}

function candidateKeys(pkg: Pick<PackageManifest, "id" | "aliases">): string[] {
  return [pkg.id, ...pkg.aliases].map(normalizePackageId);
}

export function resolvePackage(idOrAlias: string): PackageManifest | undefined {
  const needle = normalizePackageId(idOrAlias);
  return PACKAGE_MANIFESTS.find((pkg) => candidateKeys(pkg).includes(needle));
}

export function getDeferredPackage(idOrAlias: string): DeferredPackage | undefined {
  const needle = normalizePackageId(idOrAlias);
  return DEFERRED_PACKAGES.find((pkg) =>
    [pkg.id, ...pkg.aliases].map(normalizePackageId).includes(needle),
  );
}

export function searchPackages(query = ""): PackageManifest[] {
  const q = normalizePackageId(query);
  if (!q) return [...PACKAGE_MANIFESTS];
  return PACKAGE_MANIFESTS.filter((pkg) => {
    const haystack = [
      pkg.id,
      pkg.displayName,
      pkg.description,
      pkg.packageType,
      pkg.supportLevel,
      ...pkg.aliases,
      ...pkg.tags,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

export function listPackages(_opts: { available?: boolean } = {}): PackageManifest[] {
  return [...PACKAGE_MANIFESTS];
}

export function createAdHocGithubManifest(repo: string): PackageManifest {
  const normalizedRepo = repo
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const repoName = normalizedRepo.split("/")[1] ?? normalizedRepo;
  return manifest({
    id: normalizePackageId(repoName),
    aliases: [normalizedRepo, repoName],
    displayName: repoName,
    description:
      "Ad-hoc GitHub TouchDesigner package staged by owner/repo for backward compatibility.",
    homepage: `https://github.com/${normalizedRepo}`,
    source: github(normalizedRepo),
    license: "See source repository",
    tags: ["ad-hoc", "github"],
    packageType: "collection",
    supportLevel: "stage-only",
    platforms: ["macos", "windows"],
    requiresTouchDesignerBridge: false,
    externalDependencies: [],
    installStrategy: {
      mode: "stage-only",
      preferReleaseAsset: true,
      importableExtensions: [".tox", ".toe"],
      manualSteps: ["Inspect staged files before importing them into TouchDesigner."],
    },
    healthChecks: [
      {
        id: "adhoc-stage",
        description: "Verify staged files and upstream README before use.",
        severity: "warning",
      },
    ],
    importHints: {
      namespace: "/project1/tdmcp_packages",
      preferredArtifacts: [],
      manualSteps: ["Import only trusted artifacts after reading the upstream project."],
    },
    uninstallStrategy: { mode: "delete-staged", notes: "Remove staged ad-hoc package files." },
    securityNotes: commonSecurity,
  });
}
