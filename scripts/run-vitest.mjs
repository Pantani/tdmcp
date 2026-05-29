import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const nodeOptions = process.env.NODE_OPTIONS ?? "";
const env = { ...process.env };

if (
  process.allowedNodeEnvironmentFlags.has("--no-experimental-webstorage") &&
  !nodeOptions.includes("--no-experimental-webstorage") &&
  !nodeOptions.includes("--localstorage-file")
) {
  env.NODE_OPTIONS = [nodeOptions, "--no-experimental-webstorage"].filter(Boolean).join(" ");
}

const result = spawnSync(process.execPath, [vitest, ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
