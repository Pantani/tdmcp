import type { TouchDesignerClient } from "../../td-client/touchDesignerClient.js";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../../tools/pythonReport.js";
import type { AiPartyDispatchAction, AiPartyShowState } from "./schemas.js";

export const AI_PARTY_TD_LAYOUT = [
  { name: "control_panel", nodeX: -660, nodeY: 260 },
  { name: "noise_base", nodeX: -620, nodeY: 20 },
  { name: "level_mood", nodeX: -380, nodeY: 20 },
  { name: "displace_energy", nodeX: -140, nodeY: 20 },
  { name: "feedback_loop", nodeX: 100, nodeY: 20 },
  { name: "blur_bloom_sim", nodeX: 340, nodeY: 20 },
  { name: "text_status", nodeX: -380, nodeY: -210 },
  { name: "composite_status", nodeX: 580, nodeY: 20 },
  { name: "preview_out", nodeX: 820, nodeY: 110 },
  { name: "status_wall_out", nodeX: 820, nodeY: -110 },
  { name: "camera_fallback_bg", nodeX: -620, nodeY: -640 },
  { name: "camera_device_in", nodeX: -620, nodeY: -520 },
  { name: "camera_ai_vision_text", nodeX: -380, nodeY: -520 },
  { name: "camera_ai_composite", nodeX: 340, nodeY: -520 },
  { name: "camera_ai_vision_out", nodeX: 820, nodeY: -520 },
  { name: "crowd_interaction_text", nodeX: -380, nodeY: -760 },
  { name: "crowd_interaction_out", nodeX: 820, nodeY: -760 },
  { name: "sim_dmx_table", nodeX: -140, nodeY: -320 },
  { name: "dmx_out_disabled", nodeX: 120, nodeY: -320 },
] as const;

export const AI_PARTY_TD_PREVIEW_OUTPUTS = [
  {
    id: "main_identity",
    label: "Main wall",
    path: "/project1/ai_party_poc/preview_out",
  },
  {
    id: "reactive_world",
    label: "Lyric/status wall",
    path: "/project1/ai_party_poc/status_wall_out",
  },
  {
    id: "camera_ai_vision",
    label: "Camera / AI vision",
    path: "/project1/ai_party_poc/camera_ai_vision_out",
  },
  {
    id: "crowd_interaction",
    label: "Crowd interaction",
    path: "/project1/ai_party_poc/crowd_interaction_out",
  },
] as const;

export interface TdBuildReport {
  ok?: boolean;
  targetPath?: string;
  previewPath?: string;
  previewPaths?: Array<{ id: string; label: string; path: string }>;
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
        _noise_base.par.outputresolution = "custom"
        _noise_base.par.resolutionw = 1280
        _noise_base.par.resolutionh = 720
        _noise_base.par.outputaspect = "resolution"
        try:
            _noise_base.par.t4d.expr = "absTime.seconds * 0.21"
        except Exception as _err:
            report["warnings"].append("Could not attach live noise expression: " + str(_err))

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
        _blur_bloom_sim.inputConnectors[0].connect(_displace_energy)

        _text_status = _root.create(textTOP, "text_status")
        _text_status.nodeX = -380
        _text_status.nodeY = -210
        _text_status.par.text = "Live Nervous System\\\\nCue: doors_idle\\\\nMood: ambient_arrival\\\\nPolicy: safe"
        _text_status.par.outputresolution = "custom"
        _text_status.par.resolutionw = 1280
        _text_status.par.resolutionh = 720
        _text_status.par.wordwrap = True
        _text_status.par.fontsizex = 34
        _text_status.par.fontsizey = 34
        _text_status.par.alignx = "left"
        _text_status.par.aligny = "center"
        _text_status.par.borderspace1 = 48
        _text_status.par.borderspace2 = 40
        _text_status.par.fontcolorr = 0.88
        _text_status.par.fontcolorg = 0.96
        _text_status.par.fontcolorb = 1.0
        _text_status.par.bgcolorr = 0.02
        _text_status.par.bgcolorg = 0.03
        _text_status.par.bgcolorb = 0.05
        _text_status.par.bgalpha = 0.26

        _composite_status = _root.create(compositeTOP, "composite_status")
        _composite_status.nodeX = 580
        _composite_status.nodeY = 20
        _composite_status.inputConnectors[0].connect(_blur_bloom_sim)
        _composite_status.inputConnectors[1].connect(_text_status)
        _composite_status.par.operand = "add"
        _composite_status.par.size = "input1"
        _composite_status.par.outputresolution = "custom"
        _composite_status.par.resolutionw = 1280
        _composite_status.par.resolutionh = 720

        _preview_out = _root.create(nullTOP, "preview_out")
        _preview_out.nodeX = 820
        _preview_out.nodeY = 110
        _preview_out.inputConnectors[0].connect(_blur_bloom_sim)
        _preview_out.par.outputresolution = "custom"
        _preview_out.par.resolutionw = 1280
        _preview_out.par.resolutionh = 720
        _preview_out.viewer = True

        _status_wall_out = _root.create(nullTOP, "status_wall_out")
        _status_wall_out.nodeX = 820
        _status_wall_out.nodeY = -110
        _status_wall_out.inputConnectors[0].connect(_composite_status)
        _status_wall_out.par.outputresolution = "custom"
        _status_wall_out.par.resolutionw = 1280
        _status_wall_out.par.resolutionh = 720
        _status_wall_out.viewer = True

        _camera_fallback_bg = _root.create(constantTOP, "camera_fallback_bg")
        _camera_fallback_bg.nodeX = -620
        _camera_fallback_bg.nodeY = -640
        _camera_fallback_bg.par.outputresolution = "custom"
        _camera_fallback_bg.par.resolutionw = 1280
        _camera_fallback_bg.par.resolutionh = 720
        _camera_fallback_bg.par.colorr = 0.02
        _camera_fallback_bg.par.colorg = 0.04
        _camera_fallback_bg.par.colorb = 0.06
        _camera_fallback_bg.par.alpha = 1.0

        _camera_source = _camera_fallback_bg
        _camera_device_in = None
        try:
            _camera_device_in = _root.create(videodeviceinTOP, "camera_device_in")
        except Exception as _err:
            try:
                _camera_device_in = _root.create(videoDeviceInTOP, "camera_device_in")
            except Exception as _err2:
                report["warnings"].append("Could not create Video Device In TOP; using camera fallback: " + str(_err2 or _err))
        if _camera_device_in is not None:
            _camera_device_in.nodeX = -620
            _camera_device_in.nodeY = -520
            _camera_device_in.viewer = False
            try:
                _camera_device_in.par.active = True
            except Exception as _err:
                report["warnings"].append("Could not activate webcam input: " + str(_err))
            try:
                _camera_device_in.par.driver = "avfoundation"
            except Exception as _err:
                report["warnings"].append("Could not select AVFoundation webcam driver: " + str(_err))
            try:
                _camera_device_in.par.outputresolution = "custom"
                _camera_device_in.par.resolutionw = 1280
                _camera_device_in.par.resolutionh = 720
            except Exception as _err:
                report["warnings"].append("Could not set webcam output resolution: " + str(_err))
            _camera_source = _camera_device_in

        _camera_ai_vision_text = _root.create(textTOP, "camera_ai_vision_text")
        _camera_ai_vision_text.nodeX = -380
        _camera_ai_vision_text.nodeY = -520
        _camera_ai_vision_text.par.text = "Camera / AI Vision\\\\nLive webcam feed\\\\nLocal preview only"
        _camera_ai_vision_text.par.outputresolution = "custom"
        _camera_ai_vision_text.par.resolutionw = 1280
        _camera_ai_vision_text.par.resolutionh = 720
        _camera_ai_vision_text.par.wordwrap = True
        _camera_ai_vision_text.par.fontsizex = 38
        _camera_ai_vision_text.par.fontsizey = 38
        _camera_ai_vision_text.par.alignx = "center"
        _camera_ai_vision_text.par.aligny = "center"
        _camera_ai_vision_text.par.fontcolorr = 0.75
        _camera_ai_vision_text.par.fontcolorg = 0.92
        _camera_ai_vision_text.par.fontcolorb = 1.0
        _camera_ai_vision_text.par.bgcolorr = 0.03
        _camera_ai_vision_text.par.bgcolorg = 0.06
        _camera_ai_vision_text.par.bgcolorb = 0.08
        _camera_ai_vision_text.par.bgalpha = 0.18

        _camera_ai_composite = _root.create(compositeTOP, "camera_ai_composite")
        _camera_ai_composite.nodeX = 340
        _camera_ai_composite.nodeY = -520
        _camera_ai_composite.inputConnectors[0].connect(_camera_source)
        _camera_ai_composite.inputConnectors[1].connect(_camera_ai_vision_text)
        _camera_ai_composite.par.operand = "over"
        _camera_ai_composite.par.size = "input1"
        _camera_ai_composite.par.outputresolution = "custom"
        _camera_ai_composite.par.resolutionw = 1280
        _camera_ai_composite.par.resolutionh = 720

        _camera_ai_vision_out = _root.create(nullTOP, "camera_ai_vision_out")
        _camera_ai_vision_out.nodeX = 820
        _camera_ai_vision_out.nodeY = -520
        _camera_ai_vision_out.inputConnectors[0].connect(_camera_ai_composite)
        _camera_ai_vision_out.par.outputresolution = "custom"
        _camera_ai_vision_out.par.resolutionw = 1280
        _camera_ai_vision_out.par.resolutionh = 720
        _camera_ai_vision_out.viewer = True

        _crowd_interaction_text = _root.create(textTOP, "crowd_interaction_text")
        _crowd_interaction_text.nodeX = -380
        _crowd_interaction_text.nodeY = -760
        _crowd_interaction_text.par.text = "Crowd / Interaction\\\\nTelegram prompts and status fallback\\\\nAwaiting audience input"
        _crowd_interaction_text.par.outputresolution = "custom"
        _crowd_interaction_text.par.resolutionw = 1280
        _crowd_interaction_text.par.resolutionh = 720
        _crowd_interaction_text.par.wordwrap = True
        _crowd_interaction_text.par.fontsizex = 38
        _crowd_interaction_text.par.fontsizey = 38
        _crowd_interaction_text.par.alignx = "center"
        _crowd_interaction_text.par.aligny = "center"
        _crowd_interaction_text.par.fontcolorr = 0.9
        _crowd_interaction_text.par.fontcolorg = 1.0
        _crowd_interaction_text.par.fontcolorb = 0.78
        _crowd_interaction_text.par.bgcolorr = 0.04
        _crowd_interaction_text.par.bgcolorg = 0.06
        _crowd_interaction_text.par.bgcolorb = 0.03
        _crowd_interaction_text.par.bgalpha = 1.0

        _crowd_interaction_out = _root.create(nullTOP, "crowd_interaction_out")
        _crowd_interaction_out.nodeX = 820
        _crowd_interaction_out.nodeY = -760
        _crowd_interaction_out.inputConnectors[0].connect(_crowd_interaction_text)
        _crowd_interaction_out.par.outputresolution = "custom"
        _crowd_interaction_out.par.resolutionw = 1280
        _crowd_interaction_out.par.resolutionh = 720
        _crowd_interaction_out.viewer = True

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

        for _node in [_control_panel, _noise_base, _level_mood, _displace_energy, _feedback_loop, _blur_bloom_sim, _text_status, _composite_status, _preview_out, _status_wall_out, _camera_fallback_bg, _camera_device_in, _camera_ai_vision_text, _camera_ai_composite, _camera_ai_vision_out, _crowd_interaction_text, _crowd_interaction_out, _sim_dmx_table, _dmx_out_disabled]:
            if _node is None:
                continue
            report["nodes"].append({"name": _node.name, "path": _node.path, "nodeX": _node.nodeX, "nodeY": _node.nodeY})
        report["ok"] = True
        report["targetPath"] = _root.path
        report["previewPath"] = _preview_out.path
        report["previewPaths"] = [
            {"id": "main_identity", "label": "Main wall", "path": _preview_out.path},
            {"id": "reactive_world", "label": "Lyric/status wall", "path": _status_wall_out.path},
            {"id": "camera_ai_vision", "label": "Camera / AI vision", "path": _camera_ai_vision_out.path},
            {"id": "crowd_interaction", "label": "Crowd interaction", "path": _crowd_interaction_out.path},
        ]
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

function hashVisualKey(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function channel(hash: number, shift: number, min = 0.12, max = 0.95): number {
  const value = (hash >>> shift) & 0xff;
  return Number((min + (value / 255) * (max - min)).toFixed(3));
}

function visualFingerprint(key: string, intensity = 0.55) {
  const hash = hashVisualKey(key);
  const boundedIntensity = Math.max(0.2, Math.min(0.85, intensity));
  return {
    noise: {
      seed: (hash % 997) + 1,
      amp: Number((0.3 + boundedIntensity * 0.45).toFixed(3)),
      harmon: Math.max(2, Math.min(8, Math.round(2 + boundedIntensity * 6))),
      period: Number(Math.max(0.42, 1.35 - boundedIntensity * 0.55).toFixed(3)),
    },
    level: {
      lowr: channel(hash, 0, 0.0, 0.24),
      lowg: channel(hash, 8, 0.0, 0.24),
      lowb: channel(hash, 16, 0.0, 0.24),
      highr: channel(hash, 0),
      highg: channel(hash, 8),
      highb: channel(hash, 16),
      contrast: Number((1 + boundedIntensity * 0.65).toFixed(3)),
      brightness1: Number((0.82 + boundedIntensity * 0.26).toFixed(3)),
    },
    blur: {
      size: Math.max(2, Math.round(3 + boundedIntensity * 10 + (hash % 4))),
    },
  };
}

export async function sendAiPartyActionsToTd(
  client: TouchDesignerClient,
  actions: AiPartyDispatchAction[],
): Promise<boolean> {
  try {
    await client.getInfo();
    const params: Record<string, unknown> = {};
    let statusCue = "unchanged";
    let statusMood = "unchanged";
    let statusIntensity: number | undefined;
    const visualKeys: string[] = [];
    const statusLines = ["Live Nervous System"];
    for (const action of actions) {
      if (action.kind === "cue") {
        params.Cue = action.cue;
        statusCue = action.cue;
        if (action.intensity !== undefined) {
          params.Intensity = action.intensity;
          statusIntensity = action.intensity;
        }
        visualKeys.push(action.cue);
      } else if (action.kind === "mood") {
        params.Mood = action.mood;
        params.Intensity = action.intensity;
        statusMood = action.mood;
        statusIntensity = action.intensity;
        visualKeys.push(action.mood);
      } else if (action.kind === "panic_safe") {
        params.Cue = "panic_safe";
        params.Panic = true;
        params.Fogsim = false;
        statusCue = "panic_safe";
        visualKeys.push("panic_safe");
        statusLines.push("Policy: panic safe");
      }
    }
    if (Object.keys(params).length === 0) return false;
    if (statusIntensity === undefined && typeof params.Intensity === "number") {
      statusIntensity = params.Intensity;
    }
    await client.updateNodeParameters("/project1/ai_party_poc/control_panel", params);
    if (visualKeys.length > 0) {
      const fingerprint = visualFingerprint(visualKeys.join("|"), statusIntensity);
      await client.updateNodeParameters("/project1/ai_party_poc/noise_base", fingerprint.noise);
      await client.updateNodeParameters("/project1/ai_party_poc/level_mood", fingerprint.level);
      await client.updateNodeParameters("/project1/ai_party_poc/blur_bloom_sim", fingerprint.blur);
    }
    statusLines.push(`Cue: ${statusCue}`);
    statusLines.push(`Mood: ${statusMood}`);
    if (statusIntensity !== undefined) statusLines.push(`Intensity: ${statusIntensity.toFixed(2)}`);
    await client.updateNodeParameters("/project1/ai_party_poc/text_status", {
      text: statusLines.join("\n"),
    });
    return true;
  } catch {
    return false;
  }
}

export function formatAiPartyTdStatusText(
  state: Pick<
    AiPartyShowState,
    | "current_cue"
    | "current_mood"
    | "current_intensity"
    | "last_source"
    | "last_policy"
    | "pending_approvals_count"
    | "panic"
  >,
  now: Date = new Date(),
): string {
  const policy = state.last_policy?.decision ?? "none";
  return [
    "Live Nervous System",
    `Cue: ${state.current_cue}`,
    `Mood: ${state.current_mood}`,
    `Intensity: ${state.current_intensity.toFixed(2)}`,
    `Policy: ${policy}`,
    `Pending: ${state.pending_approvals_count}`,
    `Source: ${state.last_source || "none"}`,
    `Clock: ${now.toISOString().slice(11, 19)}`,
    state.panic ? "PANIC SAFE ACTIVE" : "Panic: normal",
  ].join("\n");
}

export async function refreshAiPartyTdPreviewState(
  client: TouchDesignerClient,
  state: Parameters<typeof formatAiPartyTdStatusText>[0],
  now: Date = new Date(),
): Promise<boolean> {
  let refreshed = false;
  try {
    await client.updateNodeParameters("/project1/ai_party_poc/text_status", {
      text: formatAiPartyTdStatusText(state, now),
    });
    refreshed = true;
  } catch {
    // The preview can still refresh older TD networks that do not have text_status.
  }
  try {
    await client.updateNodeParameters("/project1/ai_party_poc/noise_base", {
      t4d: Number(((now.getTime() / 1000) % 1000).toFixed(3)),
      tx: Number((((now.getTime() / 1000) * 0.031) % 1).toFixed(3)),
    });
    refreshed = true;
  } catch {
    // Keep preview capture best-effort even if the visual generator is absent.
  }
  return refreshed;
}
