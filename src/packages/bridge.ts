import { basename } from "node:path";
import { friendlyTdError } from "../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../tools/pythonReport.js";
import { chooseImportableArtifact } from "./artifacts.js";
import type {
  PackageArtifact,
  PackageBridge,
  PackageBridgeReport,
  PackageManifest,
} from "./types.js";

const IMPORT_SCRIPT = `
import json, base64, traceback, os, re
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"warnings": []}
def _safe_name(value):
    value = re.sub(r"[^A-Za-z0-9_]+", "_", str(value)).strip("_")
    return value or "package"
try:
    _project = op(_p["projectPath"])
    if _project is None:
        report["fatal"] = "Project COMP not found: " + str(_p["projectPath"])
    elif not os.path.isfile(_p["toxPath"]):
        report["fatal"] = "Importable .tox not found: " + str(_p["toxPath"])
    else:
        _ns = _project.op("tdmcp_packages")
        if _ns is None:
            _ns = _project.create(baseCOMP, "tdmcp_packages")
        _name = _safe_name(_p.get("name") or _p["packageId"])
        _existing = _ns.op(_name)
        if _existing is not None and not bool(_p.get("overwrite")):
            report["fatal"] = "Target exists: " + _existing.path + " (rerun with --yes to replace it)."
        else:
            if _existing is not None:
                _existing.destroy()
            _loaded = _ns.loadTox(_p["toxPath"])
            if _loaded is None:
                report["fatal"] = "loadTox produced no component from " + _p["toxPath"]
            else:
                try:
                    _loaded.name = _name
                except Exception as exc:
                    report["warnings"].append("Could not rename imported COMP: " + str(exc))
                _marker = None
                try:
                    _marker = _loaded.create(textDAT, "tdmcp_package_info")
                    _marker.text = json.dumps({
                        "id": _p["packageId"],
                        "displayName": _p["displayName"],
                        "source": _p["sourceUrl"],
                        "tox": _p["toxPath"],
                    }, indent=2)
                except Exception as exc:
                    report["warnings"].append("Could not create metadata marker DAT: " + str(exc))
                report["imported"] = True
                report["targetPath"] = _loaded.path
                report["marker"] = _marker.path if _marker is not None else None
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

function targetName(pkg: PackageManifest, customName?: string): string {
  return (customName ?? pkg.id).replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

export async function importPackageViaBridge(
  bridge: PackageBridge | undefined,
  pkg: PackageManifest,
  artifacts: PackageArtifact[],
  options: { projectPath: string; name?: string; yes?: boolean },
): Promise<PackageBridgeReport> {
  if (!bridge || bridge.mode === "offline") {
    return {
      connected: false,
      warnings: ["TouchDesigner bridge is offline; package staged only."],
    };
  }
  try {
    await bridge.getInfo();
  } catch (err) {
    return {
      connected: false,
      warnings: [`TouchDesigner bridge is offline; package staged only: ${friendlyTdError(err)}`],
    };
  }

  if (pkg.installStrategy.mode !== "tox-import") {
    return {
      connected: true,
      warnings: [`${pkg.displayName} is ${pkg.installStrategy.mode}; staged for manual use.`],
    };
  }
  const artifact = chooseImportableArtifact(artifacts);
  if (!artifact) {
    return {
      connected: true,
      warnings: [`No safe .tox artifact detected for ${pkg.displayName}; staged only.`],
    };
  }

  const script = buildPayloadScript(IMPORT_SCRIPT, {
    packageId: pkg.id,
    displayName: pkg.displayName,
    sourceUrl: pkg.source.url,
    projectPath: options.projectPath,
    toxPath: artifact.absolutePath,
    toxName: basename(artifact.absolutePath),
    name: targetName(pkg, options.name),
    overwrite: Boolean(options.yes),
  });

  try {
    const exec = await bridge.executePythonScript(script, true);
    const report = parsePythonReport<PackageBridgeReport>(exec.stdout);
    const withConnection = { ...report, connected: true, warnings: report.warnings ?? [] };
    if (withConnection.targetPath && bridge.getNodeErrors) {
      try {
        const errors = await bridge.getNodeErrors(withConnection.targetPath);
        withConnection.nodeErrors = errors.errors ?? [];
      } catch (err) {
        withConnection.warnings.push(
          `Could not check imported node errors: ${friendlyTdError(err)}`,
        );
      }
    }
    return withConnection;
  } catch (err) {
    return {
      connected: true,
      warnings: [`Bridge import failed: ${friendlyTdError(err)}`],
      fatal: friendlyTdError(err),
    };
  }
}
