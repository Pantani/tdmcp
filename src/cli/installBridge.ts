import { cpSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bridgeModulesDir } from "../utils/paths.js";

/**
 * `tdmcp install-bridge [--dir <path>]`
 *
 * Copies the packaged TouchDesigner bridge modules (`td/modules`) to a friendly,
 * stable folder on disk and prints the two things the artist needs to turn the
 * bridge on inside TouchDesigner. This is what makes the `npx` flow work without
 * cloning the repo: the modules live in the npm cache otherwise.
 */
export function runInstallBridge(args: string[]): void {
  const dirFlag = args.indexOf("--dir");
  const explicitDir = dirFlag !== -1 ? args[dirFlag + 1] : undefined;
  const targetRoot = explicitDir ?? join(homedir(), "tdmcp-bridge");
  const dest = join(targetRoot, "modules");

  const src = bridgeModulesDir();
  if (!existsSync(src)) {
    console.error(
      `[tdmcp] Could not find the bridge modules to copy (looked in ${src}).\n` +
        "If you're running from source, build first with `npm run build`.",
    );
    process.exitCode = 1;
    return;
  }

  cpSync(src, dest, { recursive: true });

  const oneLiner = "from mcp import install; install.run()";
  const noPrefs = `import sys; sys.path.insert(0, ${JSON.stringify(dest)})\n${oneLiner.replace("install.run()", `install.run(modules_dir=${JSON.stringify(dest)})`)}`;

  console.log(
    [
      "",
      "  tdmcp bridge installed.",
      `  Modules copied to:  ${dest}`,
      "",
      "  Now switch the bridge on inside TouchDesigner:",
      "",
      "  1. Open Preferences (Edit > Preferences, or the TouchDesigner menu on macOS).",
      '     In "Python 64-bit Module Path", add this folder:',
      "",
      `       ${dest}`,
      "",
      "  2. Open the Textport (Dialogs > Textport and DATs) and run:",
      "",
      `       ${oneLiner}`,
      "",
      "  You should see: [tdmcp] bridge running on port 9980 (/project1/tdmcp_bridge)",
      "",
      "  ⚠ Security: the bridge runs arbitrary Python inside TouchDesigner and the",
      "    Web Server DAT listens on all network interfaces with no auth. Only run it",
      "    on a trusted network, or firewall port 9980 to localhost.",
      "",
      "  Prefer not to touch Preferences? Paste this in the Textport instead:",
      "",
      ...noPrefs.split("\n").map((line) => `       ${line}`),
      "",
    ].join("\n"),
  );
}
