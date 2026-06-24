import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createKinectWallHarpImpl,
  createKinectWallHarpSchema,
} from "../../src/tools/layer1/createKinectWallHarp.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface ExecBody {
  script: string;
  return_output: boolean;
}

interface Payload {
  parent_path: string;
  name: string;
  source: "freenect" | "synthetic" | "osc_kinect";
  osc_port: number;
  fallback_to_synthetic: boolean;
  deactivate_existing_freenect: boolean;
  activate_freenect: boolean;
  output_width: number;
  output_height: number;
  wall_depth_center: number;
  touch_thickness: number;
  depth_polarity: "near" | "far";
  sensitivity: number;
  smoothing: number;
  crop_left: number;
  crop_right: number;
  crop_top: number;
  crop_bottom: number;
  input_mirror_x: boolean;
  input_left: number;
  input_right: number;
  input_top: number;
  input_bottom: number;
  show_debug: boolean;
  calibration_hold_ms: number;
  string_count: number;
  visual_line_count: number;
  curtain_spread: number;
  curtain_follow: number;
  cooldown_ms: number;
  frequencies: number[];
  master_volume: number;
  audio_device: string;
  audio_sample_rate: number;
  decay: number;
  brightness: number;
  reverb_mix: number;
  reverb_decay: number;
  reverb_damping: number;
  base_color: string;
  hit_color: string;
  background_level: number;
  glow: number;
  vibration_amount: number;
  vibration_decay: number;
  expose_controls: boolean;
}

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function jsonOf(result: CallToolResult): Record<string, unknown> {
  const text = textOf(result);
  const json = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
  if (json === undefined) throw new Error("result did not include a JSON fence");
  return JSON.parse(json) as Record<string, unknown>;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

function successReport(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    container: "/project1/kinect_wall_harp",
    mode: "synthetic_fallback",
    output_top: "/project1/kinect_wall_harp/out1",
    depth_debug: "/project1/kinect_wall_harp/depth_debug",
    mask_debug: "/project1/kinect_wall_harp/mask_debug",
    hands_debug: "/project1/kinect_wall_harp/hands_debug",
    hands_chop: "/project1/kinect_wall_harp/hands",
    harp_chop: "/project1/kinect_wall_harp/harp_state",
    audio_chop: "",
    audio_out: "/project1/kinect_wall_harp/audio_out",
    status_dat: "/project1/kinect_wall_harp/status",
    string_count: 16,
    visual_line_count: 32,
    freenect_available: false,
    synthetic_fallback: true,
    operators: [
      { path: "/project1/kinect_wall_harp/freenect_in", type: "FreenectTOP", role: "kinect input" },
      {
        path: "/project1/kinect_wall_harp/wall_touch_mask",
        type: "scriptTOP",
        role: "wall-touch mask",
      },
      {
        path: "/project1/kinect_wall_harp/harp_logic",
        type: "scriptCHOP",
        role: "entry trigger logic",
      },
      {
        path: "/project1/kinect_wall_harp/clean_sine_voice",
        type: "audiooscillatorCHOP",
        role: "clean sine voice",
      },
    ],
    coordinates: {
      "/project1/kinect_wall_harp/freenect_in": [-900, 180],
      "/project1/kinect_wall_harp/wall_touch_mask": [20, 180],
      "/project1/kinect_wall_harp/harp_logic": [740, -20],
      "/project1/kinect_wall_harp/out1": [980, 180],
    },
    warnings: [
      "Freenect live activation is disabled by default after macOS FreenectTD crash evidence; using synthetic fallback. Pass activate_freenect=true only in an isolated diagnostic project.",
    ],
    ...overrides,
  };
}

function captureExec(report: Record<string, unknown>): ExecBody[] {
  const bodies: ExecBody[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as ExecBody;
      bodies.push(body);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: `TouchDesigner log line\n${JSON.stringify(report)}` },
      });
    }),
  );
  return bodies;
}

describe("create_kinect_wall_harp", () => {
  it("keeps the approved v1 defaults in the schema", () => {
    const parsed = createKinectWallHarpSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("kinect_wall_harp");
    expect(parsed.source).toBe("freenect");
    expect(parsed.osc_port).toBe(7400);
    expect(parsed.fallback_to_synthetic).toBe(true);
    expect(parsed.deactivate_existing_freenect).toBe(true);
    expect(parsed.activate_freenect).toBe(false);
    expect(parsed.wall_depth_center).toBe(0.5);
    expect(parsed.touch_thickness).toBe(0.08);
    expect(parsed.depth_polarity).toBe("near");
    expect(parsed.string_count).toBe(16);
    expect(parsed.visual_line_count).toBe(128);
    expect(parsed.curtain_spread).toBe(3.2);
    expect(parsed.curtain_follow).toBe(0.5);
    expect(parsed.cooldown_ms).toBe(150);
    expect(parsed.audio_device).toBe("");
    expect(parsed.audio_sample_rate).toBe(48000);
    expect(parsed.brightness).toBe(0.08);
    expect(parsed.reverb_mix).toBe(0.22);
    expect(parsed.reverb_decay).toBe(0.68);
    expect(parsed.reverb_damping).toBe(0.45);
    expect(parsed.input_mirror_x).toBe(false);
    expect(parsed.input_left).toBe(0);
    expect(parsed.input_right).toBe(1);
    expect(parsed.calibration_hold_ms).toBe(900);
    expect(parsed.frequencies).toEqual([
      130.81, 146.83, 164.81, 196, 220, 246.94, 261.63, 293.66, 329.63, 392, 440, 493.88, 523.25,
      587.33, 659.25, 783.99,
    ]);
    expect(parsed.base_color).toBe("#050505");
    expect(parsed.hit_color).toBe("#FFB000");
    expect(parsed.background_level).toBe(0);
    expect(parsed.show_debug).toBe(false);
  });

  it("sends a base64 payload through msw /api/exec and returns the structured report", async () => {
    const bodies = captureExec(successReport());
    const args = createKinectWallHarpSchema.parse({
      parent_path: "/project1",
      name: "harp_test",
      source: "freenect",
      fallback_to_synthetic: true,
      output_width: 960,
      output_height: 540,
      wall_depth_center: "0.42",
      touch_thickness: "0.05",
      depth_polarity: "far",
      sensitivity: "0.8",
      smoothing: "0.2",
      crop_left: "0.1",
      crop_right: "0.9",
      crop_top: "0.05",
      crop_bottom: "0.95",
      input_mirror_x: true,
      input_left: "0.12",
      input_right: "0.88",
      input_top: "0.08",
      input_bottom: "0.9",
      calibration_hold_ms: "750",
      string_count: "16",
      visual_line_count: "128",
      curtain_spread: "4",
      curtain_follow: "0.65",
      cooldown_ms: "175",
      master_volume: "0.25",
      audio_device: "UMC202HD 192k",
      audio_sample_rate: "192000",
      decay: "0.55",
      brightness: "0.05",
      reverb_mix: "0.31",
      reverb_decay: "0.73",
      reverb_damping: "0.6",
      base_color: "#44CCFF",
      hit_color: "#FFAA33",
      background_level: "0.42",
      glow: "1.5",
      vibration_amount: "22",
      vibration_decay: "0.6",
    });

    const result = await createKinectWallHarpImpl(makeCtx(), args);

    expect(result.isError).toBeFalsy();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.return_output).toBe(true);

    const script = bodies[0]?.script ?? "";
    expect(script).toContain("result = report");
    expect(script).toContain("FreenectTOP");
    expect(script).toContain("renderselectTOP");
    expect(script).toContain("scriptCHOP");
    expect(script).toContain("strings_visual");
    expect(script).toContain("nodeX");
    expect(script).toContain("nodeY");
    expect(script).toContain('_set_par(_hands, ["timeslice"], False, False)');
    expect(script).toContain('_set_par(_hands, ["modoutsidecook"], True, False)');
    expect(script).toContain("_connect(_hands_null, _logic)");
    expect(script).toContain('_create(_cont, ["keyboardinCHOP"], "calibration_keys"');
    expect(script).toContain('_set_par(_logic, ["timeslice"], False, False)');
    expect(script).toContain('_set_par(_logic, ["modoutsidecook"], True, False)');
    expect(script).not.toContain('_create(_cont, ["scriptCHOP"], "pluck_synth"');
    expect(script).not.toContain('_create(_cont, ["nullCHOP"], "audio_debug"');
    expect(script).not.toContain('_create(_cont, ["executeDAT"], "audio_driver"');
    expect(script).toContain('_set_par(_hands_null, ["cooktype"], "always", False)');
    expect(script).toContain('_set_par(_logic_null, ["cooktype"], "always", False)');
    expect(script).toContain('_set_par(_audio_out, ["device"], str(_p["audio_device"]), False)');
    expect(script).toContain('parent().store("tdmcp_harp_event_queue"');
    expect(script).toContain('events = _consume_events("tdmcp_harp_event_queue")');
    expect(script).toContain('src = _latest("tdmcp_harp_latest")');
    expect(script).toContain('_map_axis(cal_x, "Inputleft", "Inputright"');
    expect(script).toContain('_bool_value("Inputmirrorx"');
    expect(script).toContain('_active_value("Audiosamplerate"');
    expect(script).toContain('scriptOp.store("audio_clock"');
    expect(script).toContain("tone = math.sin(phase)");
    expect(script).toContain("sample += tone * env * attack * 0.22");
    expect(script).toContain("def _process_reverb");
    expect(script).toContain("_soft_limit(dry + wet_l * reverb_mix)");
    expect(script).not.toContain("math.sin(phase * 0.5)");
    expect(script).not.toContain("math.sin(phase * 2.0) * bright * 0.1");
    expect(script).not.toContain("math.tanh(sample * volume * 0.42) * 0.92");
    expect(script).toContain('_read_map(src, "string%d_trigger" % i, 0.0)');
    expect(script).toContain('parent().fetch("tdmcp_string_calibration"');
    expect(script).toContain("raw_centers");
    expect(script).toContain("def _zone_for_hand");
    expect(script).toContain('_drive_callback(CFG.get("hand_tracker_path", "")');
    expect(script).not.toContain('_drive_callback(CFG.get("pluck_synth_path", "")');
    expect(script).toContain("TRACKING_DRIVER_DAT_CODE");
    expect(script).toContain('_create(_cont, ["executeDAT"], "tracking_driver"');
    expect(script).toContain("def _drive_tracking():");
    expect(script).toContain("hand_cb.module.onCook(hand)");
    expect(script).toContain("logic_cb.module.onCook(logic)");
    expect(script).toContain("CLEAN_SYNTH_DRIVER_DAT_CODE");
    expect(script).toContain('_create(_cont, ["audiooscillatorCHOP"], "clean_sine_voice"');
    expect(script).toContain('_create(_cont, ["audiooscillatorCHOP"], "clean_sine_voice_2"');
    expect(script).toContain('_create(_cont, ["audiooscillatorCHOP"], "clean_sine_voice_3"');
    expect(script).toContain('_create(_cont, ["mathCHOP"], "clean_sine_mix"');
    expect(script).toContain(
      '_set_par(_clean_voice, ["rate"], int(_p["audio_sample_rate"]), False)',
    );
    expect(script).toContain('_create(_cont, ["executeDAT"], "clean_synth_driver"');
    expect(script).toContain(
      "_set_par(osc, ['rate'], int(float(_par_value('Audiosamplerate', 48000))))",
    );
    expect(script).toContain("def _last_events(max_events=4):");
    expect(script).toContain("def _voice_patch(event, voice_index):");
    expect(script).toContain("tdmcp_clean_synth_voices");
    expect(script).toContain("_connect(_clean_mix, _audio_out)");
    expect(script).toContain('_vis_cfg["hand_tracker_callbacks_path"]');
    expect(script).toContain('_vis_cfg["harp_logic_callbacks_path"]');
    expect(script).not.toContain('_vis_cfg["pluck_synth_callbacks_path"]');
    expect(script).not.toContain("_read_hands_chop");
    expect(script).not.toContain("_read_logic_chop");
    expect(script).not.toContain('_read(src, "string%d_trigger" % i, 0.0)');
    expect(script).not.toContain("_connect(_logic_null, _audio)");
    expect(script).toContain("_text_dat");
    expect(script).toContain("_deactivate_existing_freenect");
    expect(script).toContain("activate_freenect");
    expect(script).not.toContain("hand_tracker_update");
    expect(script).not.toContain("HAND_UPDATE_DAT_CODE");
    expect(script).toContain("_extract_components");
    expect(script).not.toContain("left_side");
    expect(script).not.toContain("w // 2");
    expect(script).toContain('_active_value("Depthpolarity"');
    expect(script).toContain('_active_value("Smoothing"');
    expect(script).toContain('_active_value("Cooldownms"');
    expect(script).toContain('_active_value("Mastervolume"');
    expect(script).toContain('_active_value("Reverbmix"');
    expect(script).toContain('_active_value("Reverbdecay"');
    expect(script).toContain('_active_value("Reverbdamping"');
    expect(script).toContain('_active_value("Stringcount"');
    expect(script).toContain('_active_value("Visuallinecount"');
    expect(script).toContain('_active_value("Curtainspread"');
    expect(script).toContain('_active_value("Curtainfollow"');
    expect(script).toContain('_active_value("Vibrationamount"');
    expect(script).toContain('_active_value("Backgroundlevel"');
    expect(script).toContain("def _laser_palette");
    expect(script).toContain("def _laser_texture");
    expect(script).toContain("def _laser_texture_rows");
    expect(script).toContain("def _beam_gradient_rows");
    expect(script).toContain("def _update_hand_trails");
    expect(script).toContain("def _draw_neon_trails");
    expect(script).toContain('parent().store("tdmcp_neon_hand_trails"');
    expect(script).toContain('parent().fetch("tdmcp_neon_hand_trails"');
    expect(script).toContain("trail_alpha =");
    expect(script).toContain("wake_alpha =");
    expect(script).toContain("np.clip(color * (1.18 + 0.55 * energy)");
    expect(script).toContain("white_hot = np.array([1.0, 1.0, 1.0]");
    expect(script).toContain("def _localized_hand_motion");
    expect(script).toContain("def _localized_hand_motion_rows");
    expect(script).toContain("visual_count = max(8, min(192");
    expect(script).toContain("height_weight = math.exp(-(dy * dy) / 0.035)");
    expect(script).toContain("height_weight = np.exp(-((dy * dy) / 0.035))");
    expect(script).toContain("y_norms = 1.0 - (np.arange(height, dtype=np.float32)");
    expect(script).toContain("needle = np.clip((white_hot.reshape(1, 3) *");
    expect(script).toContain(
      "halo = color.reshape(1, 3) * (0.34 + 0.48 * local_motion).reshape(height, 1)",
    );
    expect(script).not.toContain("for y in range(height):");
    expect(script).not.toContain(
      "img[y, max(0, x - line_half):min(width, x + line_half + 1), 0:3] = color",
    );
    expect(script).toContain('_bool_value("Showdebug"');
    expect(script).toContain("parent().par.Cropleft");
    expect(script).toContain("parent().par.Cropright");
    expect(script).toContain('_custom_par(tracking, "appendToggle", "Inputmirrorx"');
    expect(script).toContain('_custom_par(calibration, "appendToggle", "Calibrationmode"');
    expect(script).toContain('_custom_par(calibration, "appendToggle", "Manualcapture"');
    expect(script).toContain('_custom_par(calibration, "appendToggle", "Resetcalibration"');
    expect(script).toContain('_custom_par(calibration, "appendInt", "Calibrationholdms"');
    expect(script).toContain('_custom_par(visual, "appendFloat", "Backgroundlevel"');
    expect(script).toContain('parent().store("tdmcp_calibration_wizard"');
    expect(script).toContain('parent().store("tdmcp_calibration_result"');
    expect(script).toContain('parent().store("tdmcp_string_calibration"');
    expect(script).toContain('_vis_cfg["calibration_keys_path"]');
    expect(script).toContain("Calibrationmode");
    expect(script).toContain("Manualcapture");
    expect(script).toContain("Resetcalibration");
    expect(script).toContain('if not bool(state.get("armed", False)) and not manual:');
    expect(script).toContain('state["status"] = "clear_wall"');
    expect(script).toContain('"raw_x"');
    expect(script).toContain('"string_%d" % i');
    expect(script).toContain('prefix + "_cal_x"');
    expect(script).not.toContain('target_dist = math.hypot(float(hand["raw_x"])');
    expect(script).toContain('_draw_dot(img, float(hand["raw_x"]), float(hand["raw_y"]');
    expect(script).toContain('hands = _latest("tdmcp_hands_latest") if active else {}');
    expect(script).toContain('cy = int((1.0 - _read_map(hands, prefix + "_y", 0.0)) * height)');
    expect(script).toContain('_custom_par(audio, "appendInt", "Audiosamplerate"');
    expect(script).toContain('_custom_par(audio, "appendFloat", "Reverbmix"');
    expect(script).toContain('_custom_par(audio, "appendFloat", "Reverbdecay"');
    expect(script).toContain('_custom_par(audio, "appendFloat", "Reverbdamping"');
    expect(script).toContain('_custom_par(visual, "appendInt", "Visuallinecount"');
    expect(script).toContain('_custom_par(visual, "appendFloat", "Curtainspread"');
    expect(script).toContain('_custom_par(visual, "appendFloat", "Curtainfollow"');
    expect(script).toContain("def onFrameStart(frame):");
    expect(script).not.toContain("_connect(_audio_debug, _audio_out)");

    const payload = decodePayload(script);
    expect(payload.name).toBe("harp_test");
    expect(payload.source).toBe("freenect");
    expect(payload.osc_port).toBe(7400);
    expect(payload.fallback_to_synthetic).toBe(true);
    expect(payload.deactivate_existing_freenect).toBe(true);
    expect(payload.activate_freenect).toBe(false);
    expect(payload.output_width).toBe(960);
    expect(payload.output_height).toBe(540);
    expect(payload.wall_depth_center).toBe(0.42);
    expect(payload.touch_thickness).toBe(0.05);
    expect(payload.depth_polarity).toBe("far");
    expect(payload.sensitivity).toBe(0.8);
    expect(payload.crop_left).toBe(0.1);
    expect(payload.input_mirror_x).toBe(true);
    expect(payload.input_left).toBe(0.12);
    expect(payload.input_right).toBe(0.88);
    expect(payload.calibration_hold_ms).toBe(750);
    expect(payload.cooldown_ms).toBe(175);
    expect(payload.master_volume).toBe(0.25);
    expect(payload.audio_device).toBe("UMC202HD 192k");
    expect(payload.audio_sample_rate).toBe(192000);
    expect(payload.brightness).toBe(0.05);
    expect(payload.reverb_mix).toBe(0.31);
    expect(payload.reverb_decay).toBe(0.73);
    expect(payload.reverb_damping).toBe(0.6);
    expect(payload.background_level).toBe(0.42);
    expect(payload.string_count).toBe(16);
    expect(payload.visual_line_count).toBe(128);
    expect(payload.curtain_spread).toBe(4);
    expect(payload.curtain_follow).toBe(0.65);
    expect(payload.frequencies).toHaveLength(16);

    const text = textOf(result);
    expect(text).toContain("Built Kinect wall harp");
    expect(text).toContain("synthetic fallback");
    expect(text).toContain("1 warning(s)");

    const report = jsonOf(result);
    expect(report.output_top).toBe("/project1/kinect_wall_harp/out1");
    expect(report.hands_chop).toBe("/project1/kinect_wall_harp/hands");
    expect(report.audio_chop).toBe("");
    expect(report.synthetic_fallback).toBe(true);
    expect(report.warnings).toEqual([
      "Freenect live activation is disabled by default after macOS FreenectTD crash evidence; using synthetic fallback. Pass activate_freenect=true only in an isolated diagnostic project.",
    ]);
  });

  it("supports OSC Kinect mode for an external Kinect bridge without FreenectTOP activation", async () => {
    const bodies = captureExec(
      successReport({
        mode: "osc_kinect",
        synthetic_fallback: false,
        warnings: [],
        osc_in: "/project1/kinect_wall_harp/osc_kinect_in",
        osc_chop: "/project1/kinect_wall_harp/osc_kinect_select",
      }),
    );
    const args = createKinectWallHarpSchema.parse({
      source: "osc_kinect",
      fallback_to_synthetic: false,
      osc_port: 7401,
    });

    const result = await createKinectWallHarpImpl(makeCtx(), args);

    expect(result.isError).toBeFalsy();
    const script = bodies[0]?.script ?? "";
    expect(script).toContain('_create(_cont, ["oscinCHOP"], "osc_kinect_in"');
    expect(script).toContain('_create(_cont, ["selectCHOP"], "osc_kinect_select"');
    expect(script).toContain('_set_par(_osc, ["port"], int(_p["osc_port"]), False)');
    expect(script).toContain("_connect(_osc_select, _hands)");
    expect(script).toContain('elif mode == "osc_kinect":');
    expect(script).toContain('_read_osc_hand(src, "left")');
    expect(script).toContain('"/kinect/" + prefix + "/" + field');
    expect(script).toContain('kinect_" + prefix + "_" + field');
    expect(script).toContain('_hands_cfg["osc_path"]');
    expect(script).toContain("osc_depth_placeholder");
    expect(script).not.toContain(
      '_mode = "synthetic" if _p["source"] == "synthetic" else "freenect_live"',
    );

    const payload = decodePayload(script);
    expect(payload.source).toBe("osc_kinect");
    expect(payload.fallback_to_synthetic).toBe(false);
    expect(payload.osc_port).toBe(7401);

    const text = textOf(result);
    expect(text).toContain("OSC Kinect external hand input");
    const report = jsonOf(result);
    expect(report.mode).toBe("osc_kinect");
    expect(report.synthetic_fallback).toBe(false);
    expect(report.osc_chop).toBe("/project1/kinect_wall_harp/osc_kinect_select");
  });

  it("returns isError for a fatal Python report without throwing", async () => {
    captureExec(
      successReport({
        container: "",
        mode: "unavailable",
        output_top: "",
        warnings: [],
        fatal: "Parent COMP not found: /missing",
      }),
    );

    const result = await createKinectWallHarpImpl(
      makeCtx(),
      createKinectWallHarpSchema.parse({ parent_path: "/missing" }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Kinect wall harp build failed");
    expect(textOf(result)).toContain("Parent COMP not found: /missing");
  });
});
