import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createVoicePromptPipelineSchema = z
  .object({
    parent_path: z.string().default("/project1").describe("Parent COMP for the pipeline."),
    name: z.string().default("voice_prompt_pipeline").describe("Generated baseCOMP name."),
    audio_source: z.enum(["microphone", "file", "external_text"]).default("microphone"),
    audio_file: z.string().optional(),
    stt_mode: z.enum(["external_websocket", "file_drop", "manual_text"]).default("manual_text"),
    llm_target: z
      .enum(["ai_party", "comfyui_prompt", "streamdiffusion_prompt", "text_only"])
      .default("text_only"),
    approval_mode: z.enum(["dry_run", "approval_required"]).default("dry_run"),
    server_url: z.string().default("ws://127.0.0.1:8770"),
    active: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.audio_source === "file" && !value.audio_file?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["audio_file"],
        message: "audio_file is required when audio_source is file.",
      });
    }
  });

type CreateVoicePromptPipelineArgs = z.infer<typeof createVoicePromptPipelineSchema>;

export interface VoicePromptPipelineReport {
  container_path?: string;
  transcript_dat?: string;
  intent_dat?: string;
  policy_gate?: string;
  approval_queue?: string;
  dispatch_dat?: string;
  audio_monitor?: string;
  stt_adapter?: string;
  warnings: string[];
  fatal?: string;
}

const VOICE_PROMPT_PIPELINE_SCRIPT = `
import json, base64, traceback
from urllib.parse import urlparse
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"warnings": []}

def _warn(message):
    report["warnings"].append(str(message))

def _place(node, x, y):
    if node is None:
        return
    try:
        node.nodeX = float(x)
        node.nodeY = float(y)
    except Exception:
        pass

def _free_x(parent, y, start=0.0, step=280.0, exclude=None):
    try:
        occupied = set()
        for child in parent.children:
            if exclude is not None and getattr(child, "path", None) == getattr(exclude, "path", None):
                continue
            try:
                if abs(float(child.nodeY) - float(y)) < 1.0:
                    occupied.add(round(float(child.nodeX) / step) * step)
            except Exception:
                continue
        x = float(start)
        while round(x / step) * step in occupied:
            x += step
        return x
    except Exception:
        return float(start)

def _or_create(parent, name, optype):
    existing = parent.op(name)
    if existing is not None:
        return existing
    return parent.create(optype, name)

def _setpar(node, par_name, value, warn=True):
    if node is None or value is None:
        return False
    try:
        par = getattr(node.par, par_name, None)
    except Exception:
        par = None
    if par is None:
        if warn:
            _warn("No parameter '%s' on %s" % (par_name, getattr(node, "path", node)))
        return False
    try:
        par.val = value
        return True
    except Exception as exc:
        if warn:
            _warn("Could not set %s on %s: %s" % (par_name, getattr(node, "path", node), exc))
        return False

def _connect(src, dst, input_index=0):
    try:
        dst.inputConnectors[input_index].connect(src)
        return True
    except Exception as exc:
        _warn("Could not connect %s -> %s: %s" % (getattr(src, "name", src), getattr(dst, "name", dst), exc))
        return False

def _ws_parts(url):
    parsed = urlparse(url or "ws://127.0.0.1:8770")
    scheme = parsed.scheme or "ws"
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if scheme in ("wss", "https") else 80)
    return host, port

try:
    parent = op(_p["parent_path"])
    if parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        comp = parent.op(_p["name"])
        if comp is None:
            comp = parent.create(baseCOMP, _p["name"])
        _place(comp, _free_x(parent, -180, exclude=comp), -180)
        report["container_path"] = comp.path

        if _p.get("audio_source") == "file":
            audio = _or_create(comp, "audio_in", audiofileinCHOP)
            _setpar(audio, "file", _p.get("audio_file"))
            _setpar(audio, "play", 1 if _p.get("active") else 0, warn=False)
        elif _p.get("audio_source") == "external_text":
            audio = _or_create(comp, "audio_in_note", textDAT)
            audio.text = "External text mode: write transcript text into transcript_in."
        else:
            audio = _or_create(comp, "audio_in", audiodeviceinCHOP)
            _setpar(audio, "active", 1 if _p.get("active") else 0, warn=False)
        _place(audio, 0, 0)

        monitor = _or_create(comp, "voice_level", analyzeCHOP)
        _place(monitor, 260, 0)
        if getattr(audio, "isCHOP", False):
            _connect(audio, monitor)
        report["audio_monitor"] = monitor.path

        transcript = _or_create(comp, "transcript_in", textDAT)
        _place(transcript, 0, -180)
        if _p.get("stt_mode") == "manual_text":
            transcript.text = "Manual STT mode: type or paste transcript text here."
        elif _p.get("stt_mode") == "file_drop":
            transcript.text = "File-drop STT mode: adapter writes transcript text here after processing audio_file."
        else:
            transcript.text = "External WebSocket STT mode: callbacks write transcript text here."
        report["transcript_dat"] = transcript.path

        if _p.get("stt_mode") == "external_websocket":
            stt = _or_create(comp, "stt_ws", websocketDAT)
            _place(stt, 520, 0)
            host, port = _ws_parts(_p.get("server_url"))
            _setpar(stt, "netaddress", host)
            _setpar(stt, "port", int(port))
            _setpar(stt, "active", 1 if _p.get("active") else 0, warn=False)
            report["stt_adapter"] = stt.path
        elif _p.get("stt_mode") == "file_drop":
            stt = _or_create(comp, "stt_file_drop", textDAT)
            _place(stt, 520, 0)
            stt.text = "Drop or reference audio files in audio_in; external STT adapter writes transcript_in."
            report["stt_adapter"] = stt.path

        intent = _or_create(comp, "intent_json", textDAT)
        _place(intent, 260, -180)
        intent.text = json.dumps({
            "target": _p.get("llm_target"),
            "approval_mode": _p.get("approval_mode"),
            "intent": None,
            "dry_run": True,
        }, indent=2)
        report["intent_dat"] = intent.path

        policy = _or_create(comp, "policy_gate", tableDAT)
        _place(policy, 520, -180)
        policy.clear()
        policy.appendRow(["effect_family", "decision", "reason"])
        policy.appendRow(["text_prompt", _p.get("approval_mode", "dry_run"), "Allowed only as dry-run or approved prompt text."])
        policy.appendRow(["dmx_laser_fog_strobe_blackout_pa", "block", "Physical/hazardous dispatch is never sent by this scaffold."])
        report["policy_gate"] = policy.path

        queue = _or_create(comp, "approval_queue", tableDAT)
        _place(queue, 780, -180)
        queue.clear()
        queue.appendRow(["id", "status", "intent_json", "operator"])
        report["approval_queue"] = queue.path

        dispatch = _or_create(comp, "dispatch_dry_run", textDAT)
        _place(dispatch, 1040, -180)
        dispatch.text = json.dumps({
            "dry_run": True,
            "target": _p.get("llm_target"),
            "stt_mode": _p.get("stt_mode"),
            "runtime_network": {
                "server_url": _p.get("server_url"),
                "active": bool(_p.get("active")),
            },
            "active": bool(_p.get("active")),
            "note": "No raw DMX, arbitrary Python, lasers, fog, strobe, blackout, or PA dispatch.",
        }, indent=2)
        report["dispatch_dat"] = dispatch.path

        notes = _or_create(comp, "setup_notes", textDAT)
        _place(notes, 0, -380)
        notes.text = (
            "Voice prompt pipeline scaffold. LLM interprets intent into structured JSON only; "
            "policy_gate is authoritative. Hardware dispatch requires HARDWARE_ENABLED/DMX_LIVE_ENABLED "
            "and explicit operator approval in the real AI Party runtime, not this scaffold."
        )
        _warn("Default behavior is dry-run/approval-gated; no prompt is dispatched to live hardware.")
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]

result = report
print(json.dumps(report))
`;

export function buildVoicePromptPipelineScript(payload: object): string {
  return buildPayloadScript(VOICE_PROMPT_PIPELINE_SCRIPT, payload);
}

export async function createVoicePromptPipelineImpl(
  ctx: ToolContext,
  args: CreateVoicePromptPipelineArgs,
) {
  const script = buildVoicePromptPipelineScript({
    parent_path: args.parent_path,
    name: args.name,
    audio_source: args.audio_source,
    audio_file: args.audio_file ?? null,
    stt_mode: args.stt_mode,
    llm_target: args.llm_target,
    approval_mode: args.approval_mode,
    server_url: args.server_url,
    active: args.active,
  });

  return guardTd(
    async () =>
      parsePythonReport<VoicePromptPipelineReport>(
        (await ctx.client.executePythonScript(script, true)).stdout,
      ),
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not create voice prompt pipeline: ${report.fatal}`, report);
      }
      return jsonResult(
        `Created voice prompt pipeline ${report.container_path}; transcript ${report.transcript_dat}; policy gate ${report.policy_gate}; dispatch remains dry-run/approval-gated.`,
        report,
      );
    },
  );
}

export const registerCreateVoicePromptPipeline: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_voice_prompt_pipeline",
    {
      title: "Create voice prompt pipeline",
      description:
        "Create a dry-run/approval-gated voice-to-prompt TouchDesigner scaffold for AI Party-style workflows. It never dispatches raw hardware effects; policy and operator approval remain authoritative.",
      inputSchema: createVoicePromptPipelineSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createVoicePromptPipelineImpl(ctx, args),
  );
};
