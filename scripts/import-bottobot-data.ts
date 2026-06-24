/**
 * Imports the TouchDesigner knowledge base from `@bottobot/td-mcp` into
 * `src/knowledge/data/`. Safe to re-run. If the package is missing, writes an
 * empty-but-valid structure and exits 0 (build/test must never break on this).
 *
 *   npm run import:bottobot
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeGlsl,
  normalizePatterns,
  toOperatorSummary,
  toPythonSummary,
  toTutorialSummary,
} from "../src/knowledge/normalize.js";
import type { OperatorDoc, PythonClass, Tutorial } from "../src/knowledge/types.js";
import { bottobotPackageDir } from "../src/utils/paths.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src/knowledge/data");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

function readExistingMeta(): {
  importedAt?: string;
  source?: string;
  bottobotVersion?: string;
  counts?: unknown;
} {
  const metaPath = join(outDir, "meta.json");
  if (!existsSync(metaPath)) return {};
  try {
    return readJson(metaPath) as {
      importedAt?: string;
      source?: string;
      bottobotVersion?: string;
      counts?: unknown;
    };
  } catch {
    return {};
  }
}

function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
}

function freshDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function countRecord(value: unknown): number {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).length
    : 0;
}

function writeEmptyVersions(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "version-manifest.json"), {
    schemaVersion: "1.0",
    versions: [],
    versionOrder: [],
    currentStable: null,
    pythonVersionMap: {},
  });
  writeJson(join(dir, "release-highlights.json"), {
    schemaVersion: "1.0",
    releases: {},
  });
  writeJson(join(dir, "operator-compatibility.json"), {
    schemaVersion: "1.0",
    operators: {},
  });
  writeJson(join(dir, "python-api-compatibility.json"), {
    schemaVersion: "1.0",
    classes: {},
  });
  writeJson(join(dir, "experimental-builds.json"), {
    schemaVersion: "1.0",
    currentExperimentalSeries: null,
    buildSeries: [],
  });
}

function writeEmptyDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function patchTechniqueTextFile(
  techniquesOut: string,
  file: string,
  patch: (text: string) => string,
): void {
  const path = join(techniquesOut, file);
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  const patched = patch(text);
  if (patched !== text) writeFileSync(path, patched);
}

function jsonStringContent(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

function jsonSnippetLines(lines: string[]): string {
  return jsonStringContent(lines.join("\n"));
}

function patchGpuComputePack(techniquesOut: string): void {
  patchTechniqueTextFile(techniquesOut, "gpu-compute.json", (text) => {
    if (text.toLowerCase().includes("pseudocode")) return text;
    return text.replace(
      "// Minimal CUDA TOP Plugin skeleton\\n// Inherits from TOP_CPlusPlusBase (Derivative SDK)",
      "// Minimal CUDA TOP Plugin skeleton\\n// Pseudocode: d_dst and d_src represent CUDA-mapped TD input/output buffers.\\n// Inherits from TOP_CPlusPlusBase (Derivative SDK)",
    );
  });
}

function patchMediaPipePoseText(text: string): string {
  const channelSetupBlock = [
    "",
    "",
    "# Channel setup \u2014 called to define output channels",
    "def onSetupParameters(scriptOp):",
    "    # Add all landmark channels",
    "    for name in LANDMARK_NAMES:",
    "        for axis in ['x', 'y', 'z', 'vis']:",
    "            scriptOp.appendChan(f'{name}_{axis}')",
  ].join("\\n");
  const patched = text.replace(channelSetupBlock, "");
  if (patched.includes("Add all landmark channels once")) return patched;
  return patched.replace(
    "def onSetupParameters(scriptOp):\\n    global _pose\\n",
    "def onSetupParameters(scriptOp):\\n    global _pose\\n    # Add all landmark channels once while the Script CHOP initializes.\\n    for name in LANDMARK_NAMES:\\n        for axis in ['x', 'y', 'z', 'vis']:\\n            scriptOp.appendChan(f'{name}_{axis}')\\n",
  );
}

function patchBodyTrackText(text: string): string {
  const oldBlock = [
    "def detect_hands_raised(bodyTrackChop, person_index=0):",
    "    joints = get_skeleton_joints(bodyTrackChop, person_index)",
    "    if 'left_wrist' in joints and 'left_shoulder' in joints:",
    "        left_raised = joints['left_wrist'][1] > joints['left_shoulder'][1]",
    "        right_raised = joints['right_wrist'][1] > joints['right_shoulder'][1]",
    "        return left_raised and right_raised",
    "    return False",
  ].join("\\n");
  const newBlock = [
    "def detect_hands_raised(bodyTrackChop, person_index=0):",
    "    joints = get_skeleton_joints(bodyTrackChop, person_index)",
    "    required = {'left_wrist', 'left_shoulder', 'right_wrist', 'right_shoulder'}",
    "    if not required.issubset(joints):",
    "        return False",
    "    left_raised = joints['left_wrist'][1] > joints['left_shoulder'][1]",
    "    right_raised = joints['right_wrist'][1] > joints['right_shoulder'][1]",
    "    return left_raised and right_raised",
  ].join("\\n");
  return text.replace(oldBlock, newBlock);
}

function patchMachineLearningPack(techniquesOut: string): void {
  patchTechniqueTextFile(techniquesOut, "machine-learning.json", (text) => {
    return patchBodyTrackText(patchMediaPipePoseText(text));
  });
}

function patchAsyncioText(text: string): string {
  let patched = text.replace(
    jsonStringContent("_bg_loop = None\n_bg_thread = None\n_results = {}"),
    jsonStringContent(
      "_bg_loop = None\n_bg_thread = None\n_bg_loop_ready = threading.Event()\n_results = {}",
    ),
  );
  const oldStart = jsonSnippetLines([
    "def start_background_loop():",
    '    """Start a background asyncio event loop in a daemon thread."""',
    "    global _bg_loop, _bg_thread",
    "    ",
    "    def run_loop():",
    "        global _bg_loop",
    "        _bg_loop = asyncio.new_event_loop()",
    "        asyncio.set_event_loop(_bg_loop)",
    "        _bg_loop.run_forever()",
    "    ",
    "    _bg_thread = threading.Thread(target=run_loop, daemon=True)",
    "    _bg_thread.start()",
    "    print('[Async] Background event loop started')",
  ]);
  const newStart = jsonSnippetLines([
    "def start_background_loop():",
    '    """Start a background asyncio event loop in a daemon thread."""',
    "    global _bg_loop, _bg_thread",
    "    if _bg_thread and _bg_thread.is_alive():",
    "        return",
    "    _bg_loop_ready.clear()",
    "    ",
    "    def run_loop():",
    "        global _bg_loop",
    "        _bg_loop = asyncio.new_event_loop()",
    "        asyncio.set_event_loop(_bg_loop)",
    "        _bg_loop_ready.set()",
    "        _bg_loop.run_forever()",
    "    ",
    "    _bg_thread = threading.Thread(target=run_loop, daemon=True)",
    "    _bg_thread.start()",
    "    if not _bg_loop_ready.wait(timeout=2.0):",
    "        raise RuntimeError('Background event loop did not start')",
    "    print('[Async] Background event loop started')",
  ]);
  patched = patched.replace(oldStart, newStart);
  const oldFetch = jsonSnippetLines([
    "def fetch_url(url, key='last'):",
    '    """Schedule an async fetch from TD code (non-blocking)."""',
    "    if _bg_loop is None:",
    "        start_background_loop()",
    "    asyncio.run_coroutine_threadsafe(fetch_url_async(url, key), _bg_loop)",
  ]);
  const newFetch = jsonSnippetLines([
    "def fetch_url(url, key='last'):",
    '    """Schedule an async fetch from TD code (non-blocking)."""',
    "    if _bg_loop is None:",
    "        start_background_loop()",
    "    elif not _bg_loop_ready.wait(timeout=2.0):",
    "        raise RuntimeError('Background event loop is not ready')",
    "    if _bg_loop is None:",
    "        raise RuntimeError('Background event loop is unavailable')",
    "    asyncio.run_coroutine_threadsafe(fetch_url_async(url, key), _bg_loop)",
  ]);
  return patched.replace(oldFetch, newFetch);
}

function patchPythonAdvancedPack(techniquesOut: string): void {
  patchTechniqueTextFile(techniquesOut, "python-advanced.json", (text) => {
    return patchAsyncioText(text);
  });
}

function patchImportedTechniqueKnowledge(techniquesOut: string): void {
  patchGpuComputePack(techniquesOut);
  patchMachineLearningPack(techniquesOut);
  patchPythonAdvancedPack(techniquesOut);
}

function writeEmpty(): void {
  freshDir(outDir);
  mkdirSync(join(outDir, "operators"), { recursive: true });
  mkdirSync(join(outDir, "python-api"), { recursive: true });
  mkdirSync(join(outDir, "tutorials"), { recursive: true });
  writeJson(join(outDir, "operators", "index.json"), []);
  writeJson(join(outDir, "python-api", "index.json"), []);
  writeJson(join(outDir, "tutorials", "index.json"), []);
  writeJson(join(outDir, "patterns.json"), []);
  writeJson(join(outDir, "glsl.json"), []);
  writeEmptyVersions(join(outDir, "versions"));
  writeEmptyDir(join(outDir, "techniques"));
  writeEmptyDir(join(outDir, "td-classes"));
  writeJson(join(outDir, "meta.json"), {
    source: "empty",
    importedAt: new Date().toISOString(),
  });
}

function main(): void {
  const bb = bottobotPackageDir();
  const existingMeta = readExistingMeta();
  if (!bb) {
    console.warn(
      "[import] @bottobot/td-mcp not found. Run `npm install @bottobot/td-mcp`, then re-run `npm run import:bottobot`.",
    );
    console.warn("[import] Wrote empty knowledge structure so build/test still pass.");
    writeEmpty();
    return;
  }

  const processedDir = join(bb, "wiki/data/processed");
  const pythonDir = join(bb, "wiki/data/python-api");
  const tutorialsDir = join(bb, "wiki/data/tutorials");
  const versionsDir = join(bb, "wiki/data/versions");
  const experimentalDir = join(bb, "wiki/data/experimental");
  const classesDir = join(bb, "wiki/data/classes");

  freshDir(outDir);

  // Operators — copy verbatim, then build a summary index.
  const opOut = join(outDir, "operators");
  cpSync(processedDir, opOut, { recursive: true });
  const opIndex = [];
  for (const file of listJson(opOut)) {
    const doc = readJson(join(opOut, file)) as OperatorDoc;
    if (doc?.name) opIndex.push(toOperatorSummary(file.replace(/\.json$/, ""), doc));
  }
  writeJson(join(opOut, "index.json"), opIndex);

  // Python API.
  const pyOut = join(outDir, "python-api");
  cpSync(pythonDir, pyOut, { recursive: true });
  const pyIndex = [];
  for (const file of listJson(pyOut)) {
    const cls = readJson(join(pyOut, file)) as PythonClass;
    if (cls?.className) pyIndex.push(toPythonSummary(cls));
  }
  writeJson(join(pyOut, "index.json"), pyIndex);

  // Tutorials.
  const tutOut = join(outDir, "tutorials");
  cpSync(tutorialsDir, tutOut, { recursive: true });
  const tutIndex = [];
  for (const file of listJson(tutOut)) {
    const tut = readJson(join(tutOut, file)) as Tutorial;
    const id = tut?.id ?? file.replace(/\.json$/, "");
    const name = tut?.name ?? id;
    tutIndex.push(toTutorialSummary({ ...tut, id, name }));
  }
  writeJson(join(tutOut, "index.json"), tutIndex);

  // Patterns + GLSL (single normalized files).
  const patterns = normalizePatterns(readJson(join(bb, "data/patterns.json")));
  writeJson(join(outDir, "patterns.json"), patterns);
  const glsl = normalizeGlsl(readJson(join(bb, "wiki/data/experimental/glsl.json")));
  writeJson(join(outDir, "glsl.json"), glsl);

  // Technique packs + TD class reference pages. Keep source JSON intact.
  const techniquesOut = join(outDir, "techniques");
  if (existsSync(experimentalDir)) {
    cpSync(experimentalDir, techniquesOut, { recursive: true });
    patchImportedTechniqueKnowledge(techniquesOut);
  } else {
    writeEmptyDir(techniquesOut);
  }
  const classesOut = join(outDir, "td-classes");
  if (existsSync(classesDir)) {
    cpSync(classesDir, classesOut, { recursive: true });
  } else {
    writeEmptyDir(classesOut);
  }

  // TD release / compatibility data. Keep the source JSON shape intact so future
  // upstream fields remain available without importer churn.
  const versionsOut = join(outDir, "versions");
  if (existsSync(versionsDir)) {
    cpSync(versionsDir, versionsOut, { recursive: true });
  } else {
    writeEmptyVersions(versionsOut);
  }
  const versionManifest = readJson(join(versionsOut, "version-manifest.json")) as {
    versions?: unknown[];
  };
  const releaseHighlights = readJson(join(versionsOut, "release-highlights.json")) as {
    releases?: unknown;
  };
  const operatorCompatibility = readJson(join(versionsOut, "operator-compatibility.json")) as {
    operators?: unknown;
  };
  const pythonApiCompatibility = readJson(join(versionsOut, "python-api-compatibility.json")) as {
    classes?: unknown;
  };
  const experimentalBuilds = readJson(join(versionsOut, "experimental-builds.json")) as {
    buildSeries?: unknown[];
  };
  const techniquePacks = listJson(techniquesOut)
    .map((file) => readJson(join(techniquesOut, file)) as { techniques?: unknown[] })
    .filter((pack) => Array.isArray(pack.techniques));

  let bottobotVersion = "unknown";
  try {
    const pkg = readJson(join(bb, "package.json")) as { version?: string };
    bottobotVersion = pkg.version ?? "unknown";
  } catch {
    // ignore
  }

  const counts = {
    operators: opIndex.length,
    pythonClasses: pyIndex.length,
    tutorials: tutIndex.length,
    patterns: patterns.length,
    glsl: glsl.length,
    tdVersions: Array.isArray(versionManifest.versions) ? versionManifest.versions.length : 0,
    releaseHighlights: countRecord(releaseHighlights.releases),
    operatorCompatibility: countRecord(operatorCompatibility.operators),
    pythonApiCompatibility: countRecord(pythonApiCompatibility.classes),
    experimentalBuildSeries: Array.isArray(experimentalBuilds.buildSeries)
      ? experimentalBuilds.buildSeries.length
      : 0,
    techniquePacks: techniquePacks.length,
    techniques: techniquePacks.reduce((total, pack) => total + (pack.techniques?.length ?? 0), 0),
    tdClasses: listJson(classesOut).length,
  };
  const unchangedMeta =
    existingMeta.source === "bottobot" &&
    existingMeta.bottobotVersion === bottobotVersion &&
    JSON.stringify(existingMeta.counts) === JSON.stringify(counts);
  writeJson(join(outDir, "meta.json"), {
    source: "bottobot",
    bottobotVersion,
    importedAt: unchangedMeta ? existingMeta.importedAt : new Date().toISOString(),
    counts,
  });

  console.log(`[import] Imported from @bottobot/td-mcp@${bottobotVersion}:`, counts);
}

main();
