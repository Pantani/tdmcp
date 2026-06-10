import type { TouchDesignerClient } from "../../td-client/touchDesignerClient.js";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../../tools/pythonReport.js";
import type { AiPartyDispatchAction } from "./schemas.js";

export const AI_PARTY_TD_LAYOUT = [
  { name: "control_panel", nodeX: -660, nodeY: 260 },
  { name: "noise_base", nodeX: -620, nodeY: 20 },
  { name: "level_mood", nodeX: -380, nodeY: 20 },
  { name: "displace_energy", nodeX: -140, nodeY: 20 },
  { name: "feedback_loop", nodeX: 100, nodeY: 20 },
  { name: "blur_bloom_sim", nodeX: 340, nodeY: 20 },
  { name: "text_status", nodeX: -380, nodeY: -210 },
  { name: "composite_status", nodeX: 580, nodeY: 20 },
  { name: "preview_out", nodeX: 820, nodeY: 20 },
  { name: "sim_dmx_table", nodeX: -140, nodeY: -320 },
  { name: "dmx_out_disabled", nodeX: 120, nodeY: -320 },
] as const;

export interface TdBuildReport {
  ok?: boolean;
  targetPath?: string;
  previewPath?: string;
  warnings?: string[];
  fatal?: string;
  nodes?: Array<{ name: string; path: string; nodeX: number; nodeY: number }>;
}

const BUILD_TEMPLATE = `
# Target network: /project1/ai_party_poc
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"warnings": [], "nodes": []}
try:
    _project = op("/project1")
    if _project is None:
        report["fatal"] = "Project /project1 not found"
    else:
        _existing = _project.op("ai_party_poc")
        if _existing is not None:
            _existing.destroy()
        _root = _project.create(baseCOMP, "ai_party_poc")
        _root.nodeX = -900
        _root.nodeY = 340
        _root.color = (0.08, 0.10, 0.12)

        _control_panel = _root.create(baseCOMP, "control_panel")
        _control_panel.nodeX = -660
        _control_panel.nodeY = 260
        _page = _control_panel.appendCustomPage("AI Party")
        _page.appendStr("Mood", label="Mood")
        _page.appendStr("Cue", label="Cue")
        _page.appendFloat("Intensity", label="Intensity")
        _page.appendFloat("Energy", label="Energy")
        _page.appendToggle("Fogsim", label="FogSim")
        _page.appendToggle("Panic", label="Panic")
        _control_panel.par.Mood = "ambient_arrival"
        _control_panel.par.Cue = "doors_idle"
        _control_panel.par.Intensity = 0.35
        _control_panel.par.Energy = 0.2
        _control_panel.par.Fogsim = False
        _control_panel.par.Panic = False

        _noise_base = _root.create(noiseTOP, "noise_base")
        _noise_base.nodeX = -620
        _noise_base.nodeY = 20
        _noise_base.par.resolutionw = 1280
        _noise_base.par.resolutionh = 720

        _level_mood = _root.create(levelTOP, "level_mood")
        _level_mood.nodeX = -380
        _level_mood.nodeY = 20
        _level_mood.inputConnectors[0].connect(_noise_base)

        _displace_energy = _root.create(displaceTOP, "displace_energy")
        _displace_energy.nodeX = -140
        _displace_energy.nodeY = 20
        _displace_energy.inputConnectors[0].connect(_level_mood)

        _feedback_loop = _root.create(feedbackTOP, "feedback_loop")
        _feedback_loop.nodeX = 100
        _feedback_loop.nodeY = 20
        _feedback_loop.inputConnectors[0].connect(_displace_energy)

        _blur_bloom_sim = _root.create(blurTOP, "blur_bloom_sim")
        _blur_bloom_sim.nodeX = 340
        _blur_bloom_sim.nodeY = 20
        _blur_bloom_sim.inputConnectors[0].connect(_feedback_loop)

        _text_status = _root.create(textTOP, "text_status")
        _text_status.nodeX = -380
        _text_status.nodeY = -210
        _text_status.par.text = "Live Nervous System\\\\nCue: doors_idle\\\\nPolicy: safe"

        _composite_status = _root.create(compositeTOP, "composite_status")
        _composite_status.nodeX = 580
        _composite_status.nodeY = 20
        _composite_status.inputConnectors[0].connect(_blur_bloom_sim)
        _composite_status.inputConnectors[1].connect(_text_status)

        _preview_out = _root.create(nullTOP, "preview_out")
        _preview_out.nodeX = 820
        _preview_out.nodeY = 20
        _preview_out.inputConnectors[0].connect(_composite_status)
        _preview_out.viewer = True

        _sim_dmx_table = _root.create(tableDAT, "sim_dmx_table")
        _sim_dmx_table.nodeX = -140
        _sim_dmx_table.nodeY = -320
        _sim_dmx_table.clear()
        _sim_dmx_table.appendRow(["channel", "value"])
        for _name in ["par_left_dim", "par_left_r", "par_left_g", "par_left_b", "par_right_dim", "par_right_r", "par_right_g", "par_right_b", "fog_level", "strobe_sim"]:
            _sim_dmx_table.appendRow([_name, "0"])

        _dmx_out_disabled = _root.create(nullCHOP, "dmx_out_disabled")
        _dmx_out_disabled.nodeX = 120
        _dmx_out_disabled.nodeY = -320
        _dmx_out_disabled.viewer = False

        for _node in [_control_panel, _noise_base, _level_mood, _displace_energy, _feedback_loop, _blur_bloom_sim, _text_status, _composite_status, _preview_out, _sim_dmx_table, _dmx_out_disabled]:
            report["nodes"].append({"name": _node.name, "path": _node.path, "nodeX": _node.nodeX, "nodeY": _node.nodeY})
        report["ok"] = True
        report["targetPath"] = _root.path
        report["previewPath"] = _preview_out.path
except Exception:
    report["fatal"] = traceback.format_exc()
print(json.dumps(report))
`;

export function buildAiPartyTdDemoScript(): string {
  return buildPayloadScript(BUILD_TEMPLATE, { target: "/project1/ai_party_poc" });
}

export async function buildAiPartyTdDemo(client: TouchDesignerClient): Promise<TdBuildReport> {
  try {
    await client.getInfo();
    const exec = await client.executePythonScript(buildAiPartyTdDemoScript(), true);
    return parsePythonReport<TdBuildReport>(exec.stdout);
  } catch (err) {
    return {
      ok: false,
      fatal: friendlyTdError(err),
      warnings: [`TouchDesigner bridge unavailable: ${friendlyTdError(err)}`],
    };
  }
}

export async function sendAiPartyActionsToTd(
  client: TouchDesignerClient,
  actions: AiPartyDispatchAction[],
): Promise<boolean> {
  try {
    await client.getInfo();
    const params: Record<string, unknown> = {};
    for (const action of actions) {
      if (action.kind === "cue") {
        params.Cue = action.cue;
        if (action.intensity !== undefined) params.Intensity = action.intensity;
      } else if (action.kind === "mood") {
        params.Mood = action.mood;
        params.Intensity = action.intensity;
      } else if (action.kind === "panic_safe") {
        params.Cue = "panic_safe";
        params.Panic = true;
        params.Fogsim = false;
      }
    }
    if (Object.keys(params).length === 0) return false;
    await client.updateNodeParameters("/project1/ai_party_poc/control_panel", params);
    return true;
  } catch {
    return false;
  }
}
