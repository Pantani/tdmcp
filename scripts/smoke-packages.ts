import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const distIndex = resolve("dist/index.js");

interface SmokeCommand {
  name: string;
  args: string[];
}

const commands: SmokeCommand[] = [
  {
    name: "mediapipe dry-run",
    args: ["install", "mediapipe-touchdesigner", "--dry-run", "--json"],
  },
  { name: "raytk dry-run", args: ["install", "raytk", "--dry-run", "--json"] },
  { name: "shader park info", args: ["info", "shader-park-td", "--json"] },
  { name: "comfyui doctor", args: ["doctor", "comfyui-td", "--json"] },
];

if (process.env.TDMCP_INSTALL_LIVE === "1") {
  commands.push({
    name: "live import candidate",
    args: ["install", "sop-to-svg", "--json", "--yes"],
  });
}

if (!existsSync(distIndex)) {
  console.error("dist/index.js is missing. Run `npm run build` before `npm run smoke:packages`.");
  process.exit(1);
}

for (const command of commands) {
  const result = spawnSync(process.execPath, [distIndex, ...command.args], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`[FAIL] ${command.name}`);
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
    process.exit(result.status ?? 1);
  }
  try {
    JSON.parse(result.stdout);
  } catch (err) {
    console.error(`[FAIL] ${command.name}: stdout was not JSON`);
    console.error(result.stdout);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  console.log(`[PASS] ${command.name}`);
}

if (process.env.TDMCP_INSTALL_LIVE !== "1") {
  console.log("[UNVERIFIED] live package import skipped (set TDMCP_INSTALL_LIVE=1).");
}
