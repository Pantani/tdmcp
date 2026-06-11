import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { TouchDesignerClient } from "../../td-client/touchDesignerClient.js";
import { DEFAULT_EFFECT_POLICY } from "../showDirectorSchema.js";
import {
  type AiPartyCue,
  type AiPartyCueSection,
  createAiPartyGeneratedCue,
  DEFAULT_AI_PARTY_CUE_CATALOG,
  findAiPartyCue,
  isAiPartyGeneratedCuePromptUnsafe,
  recommendedAiPartyCuesForSection,
  shouldAutoGenerateAiPartyCue,
} from "./cueCatalog.js";
import { AI_PARTY_DASHBOARD_HTML } from "./dashboardHtml.js";
import { applyDispatchToState, dispatchAiPartyPlan } from "./dispatch.js";
import { loadGeneratedCueStore, saveGeneratedCueStore } from "./generatedCueStore.js";
import { generateOllamaCueIdea, parseOllamaShowIntent } from "./ollamaClient.js";
import { evaluateAiPartyPolicy } from "./policy.js";
import {
  type AiPartyApproval,
  type AiPartyDispatchResult,
  type AiPartyEvent,
  type AiPartyEventType,
  type AiPartyShowState,
  createInitialAiPartyShowState,
  type ShowIntentEnvelope,
} from "./schemas.js";
import {
  AI_PARTY_TD_PREVIEW_OUTPUTS,
  aiPartyVisualFingerprint,
  buildAiPartyTdDemo,
  extractAiPartyVisualTarget,
  formatAiPartyCrowdText,
  refreshAiPartyTdPreviewState,
  runAiPartyVisualTransition,
  sendAiPartyActionsToTd,
  sendAiPartyCameraFxToTd,
  sendAiPartyCrowdTextToTd,
  sendAiPartyFingerprintToTd,
} from "./tdAdapter.js";
import {
  fetchAiPartyTelegramUpdates,
  parseAiPartyTelegramCommand,
  sendAiPartyTelegramMessage,
  telegramUpdateChatId,
  telegramUpdateOperator,
  telegramUpdateText,
} from "./telegram.js";

export interface AiPartyLiveConfig {
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  tdBridgeUrl?: string;
  tdBridgeToken?: string;
  dashboardHost?: string;
  dashboardPort?: number;
  telegramBotToken?: string;
  telegramAllowedChatIds?: string[];
  telegramPollingEnabled?: boolean;
  telegramWebhookUrl?: string;
  hardwareEnabled?: boolean;
  dmxLiveEnabled?: boolean;
  showMode?: "rehearsal" | "show";
  eventLogPath?: string;
  deterministicFallback?: boolean;
  fetchImpl?: typeof fetch;
  generatedCuePath?: string;
  generatedCueLimit?: number;
  cueStorePath?: string;
  transitionSeconds?: number;
  transitionTickMs?: number;
  autoAdvanceEnabled?: boolean;
}

export interface AiPartyTransitionInfo {
  from: string;
  to: string;
  seconds: number;
  kind: "cue" | "morph";
  started_at: string;
}

export interface AiPartyEnergyPoint {
  at: string;
  value: number;
}

export interface AiPartyNightStyle {
  palette_history: string[];
  dominant_moods: Array<{ mood: string; count: number }>;
  top_prompt_tags: string[];
}

export interface AiPartyDirectorNote {
  id: string;
  at: string;
  severity: "info" | "suggestion" | "warning";
  text: string;
  suggested_cues?: string[];
}

export interface AiPartySessionInfo {
  started_at: string;
  uptime_seconds: number;
  scene_started_at: string;
  auto_advance: boolean;
}

export interface AiPartyLiveSnapshot {
  showState: AiPartyShowState;
  approvals: AiPartyApproval[];
  events: AiPartyEvent[];
  cues: AiPartyCue[];
  foh: AiPartyFohSnapshot;
  timeline: AiPartyTimelineSnapshot;
  cueHistory: AiPartyCueHistoryItem[];
  audienceSuggestions: AiPartyAudienceSuggestion[];
  audience_suggestions: AiPartyAudienceSuggestion[];
  llm: AiPartyLlmSummary;
  recap: AiPartyRecap;
  transition?: AiPartyTransitionInfo;
  energy_series: AiPartyEnergyPoint[];
  night_style: AiPartyNightStyle;
  director_notes: AiPartyDirectorNote[];
  session: AiPartySessionInfo;
}

export interface AiPartyLiveHandle {
  url: string;
  close: () => Promise<void>;
}

export interface AiPartyTelegramPollResult {
  ok: boolean;
  next_offset?: number;
  processed: number;
  ignored: Array<{ update_id: number; reason: string }>;
  warning?: string;
}

type AiPartyTdPreviewOutput = (typeof AI_PARTY_TD_PREVIEW_OUTPUTS)[number];
type AiPartyTdPreviewPayload = {
  id: AiPartyTdPreviewOutput["id"];
  label: AiPartyTdPreviewOutput["label"];
  path: AiPartyTdPreviewOutput["path"];
  preview?: Awaited<ReturnType<TouchDesignerClient["getPreview"]>>;
  error?: string;
};

export interface AiPartyTimelineSceneDetail {
  id: string;
  label: string;
  section: NonNullable<AiPartyShowState["music_section"]>;
  cue: string;
  prompt: string;
  planned_minutes: number;
  recommended_cues: string[];
}

export interface AiPartyTimelineSnapshot {
  scenes: AiPartyTimelineSceneDetail[];
  current: AiPartyTimelineSceneDetail;
  next?: AiPartyTimelineSceneDetail;
  index: number;
}

export interface AiPartyCueHistoryItem {
  at: string;
  cue?: string;
  mood?: string;
  intensity?: number;
  source?: string;
  dispatch_id?: string;
}

export interface AiPartyAudienceSuggestion {
  id: string;
  at: string;
  created_at?: string;
  text: string;
  raw_text: string;
  source: "dashboard" | "telegram";
  chat_id?: string;
  operator?: string;
  status: "queued" | "new" | "promoted" | "dismissed" | "blocked";
  policy_decision?: string;
  policy_result?: ReturnType<typeof evaluateAiPartyPolicy>;
  reason?: string;
}

export interface AiPartyLlmSummary {
  configured_model?: string;
  model?: string;
  ok?: boolean;
  confidence?: number;
  source_summary?: string;
  repaired?: boolean;
  fallback?: boolean;
  latency_ms?: number;
  error?: string;
}

export interface AiPartyFohSnapshot {
  bridge: {
    status: AiPartyShowState["td_status"];
    url: string;
    last_error?: string;
    hardware_enabled: boolean;
    dmx_live_enabled: boolean;
  };
  llm: {
    active_model: string;
    status: AiPartyShowState["llm_status"];
    latency_ms?: number;
    last_confidence?: number;
    last_source_summary?: string;
    repaired?: boolean;
    fallback?: boolean;
    last_error?: string;
  };
  policy?: {
    decision: string;
    reason: string;
    operator_message: string;
    risk_level: string;
  };
  cooldowns: Array<{
    effect: string;
    cooldown_seconds: number;
    remaining_seconds: number;
    last_triggered_at: string;
  }>;
  panic: {
    active: boolean;
    clear_endpoint: string;
  };
}

export interface AiPartyRecap {
  total_events: number;
  generated_cues: number;
  favorite_cues: number;
  approvals: { pending: number; approved: number; rejected: number; expired: number };
  blocked: number;
  touchdesigner_dispatches: number;
  simulated_dispatches: number;
  audience_suggestions: number;
  current_cue: string;
  current_mood: string;
  highlights: string[];
}

export interface AiPartyGenerateCueResult {
  ok: true;
  cue: AiPartyCue;
  generated: AiPartyCue[];
  generated_cues: AiPartyCue[];
  cues: AiPartyCue[];
  llm?: {
    ok: boolean;
    model?: string;
    phrase?: string;
    error?: string;
    latency_ms?: number;
  };
}

function sceneRecommendations(section: AiPartyCueSection): string[] {
  return recommendedAiPartyCuesForSection(section).map((cue) => cue.name);
}

const DEFAULT_AI_PARTY_TIMELINE: AiPartyTimelineSceneDetail[] = [
  {
    id: "doors",
    label: "Doors / arrival",
    section: "doors",
    cue: "doors_idle",
    prompt: "calm generative welcome visual",
    planned_minutes: 30,
    recommended_cues: sceneRecommendations("doors"),
  },
  {
    id: "warmup",
    label: "Warmup",
    section: "warmup",
    cue: "premium_tropical",
    prompt: "premium tropical warmup groove",
    planned_minutes: 45,
    recommended_cues: sceneRecommendations("warmup"),
  },
  {
    id: "build",
    label: "Build",
    section: "build",
    cue: "neon_pulse",
    prompt: "dark disco elegant build",
    planned_minutes: 40,
    recommended_cues: sceneRecommendations("build"),
  },
  {
    id: "drop",
    label: "Drop",
    section: "drop",
    cue: "audio_reactive_main",
    prompt: "audio reactive main wall energy",
    planned_minutes: 30,
    recommended_cues: sceneRecommendations("drop"),
  },
  {
    id: "breakdown",
    label: "Breakdown",
    section: "breakdown",
    cue: "brand_hero",
    prompt: "photogenic brand hero moment",
    planned_minutes: 20,
    recommended_cues: sceneRecommendations("breakdown"),
  },
  {
    id: "closing",
    label: "Closing",
    section: "closing",
    cue: "doors_idle",
    prompt: "soft closing ambient reset",
    planned_minutes: 25,
    recommended_cues: sceneRecommendations("closing"),
  },
];

interface EvaluationContext {
  source: AiPartyApproval["source"];
  rawText: string;
}

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

function boolEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function splitCsv(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AiPartyLiveConfig {
  return {
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    ollamaModel: env.OLLAMA_MODEL ?? "",
    tdBridgeUrl: env.TD_BRIDGE_URL ?? "http://127.0.0.1:9980",
    tdBridgeToken: env.TD_BRIDGE_TOKEN || undefined,
    dashboardHost: env.POC_DASHBOARD_HOST ?? "127.0.0.1",
    dashboardPort: Number(env.POC_DASHBOARD_PORT ?? 8787),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramAllowedChatIds: splitCsv(env.TELEGRAM_ALLOWED_CHAT_IDS),
    telegramPollingEnabled: boolEnv(env.TELEGRAM_POLLING_ENABLED, false),
    telegramWebhookUrl: env.TELEGRAM_WEBHOOK_URL || undefined,
    hardwareEnabled: boolEnv(env.HARDWARE_ENABLED, false),
    dmxLiveEnabled: boolEnv(env.DMX_LIVE_ENABLED, false),
    showMode: env.SHOW_MODE === "show" ? "show" : "rehearsal",
    eventLogPath: env.POC_EVENT_LOG_PATH ?? "./data/ai-party-poc-events.jsonl",
    deterministicFallback: true,
    generatedCuePath: env.POC_GENERATED_CUES_PATH,
    generatedCueLimit: Number(env.POC_GENERATED_CUE_LIMIT ?? 24),
    cueStorePath:
      env.POC_GENERATED_CUES_PATH ??
      env.POC_CUE_STORE_PATH ??
      "./data/ai-party-generated-cues.json",
    transitionSeconds: Number(env.POC_TRANSITION_SECONDS ?? 2),
    transitionTickMs: Number(env.POC_TRANSITION_TICK_MS ?? 120),
    autoAdvanceEnabled: boolEnv(env.POC_AUTO_ADVANCE, false),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function text(res: ServerResponse, status: number, body: string, contentType = "text/plain"): void {
  res.writeHead(status, { "content-type": `${contentType}; charset=utf-8` });
  res.end(body);
}

function readJson(req: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function wsAccept(key: string): string {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function sendWs(socket: Socket, payload: unknown): boolean {
  if (socket.destroyed || !socket.writable || socket.writableEnded) return false;
  if (typeof socket.listenerCount === "function" && socket.listenerCount("error") === 0) {
    socket.on("error", () => {
      socket.destroy();
    });
  }
  const data = Buffer.from(JSON.stringify(payload));
  const header =
    data.length < 126
      ? Buffer.from([0x81, data.length])
      : data.length < 65536
        ? Buffer.from([0x81, 126, data.length >> 8, data.length & 0xff])
        : (() => {
            const largeHeader = Buffer.alloc(10);
            largeHeader[0] = 0x81;
            largeHeader[1] = 127;
            largeHeader.writeBigUInt64BE(BigInt(data.length), 2);
            return largeHeader;
          })();
  try {
    socket.write(Buffer.concat([header, data]));
    return true;
  } catch {
    return false;
  }
}

function clampGeneratedCueCount(value: unknown): number {
  const count = typeof value === "number" ? value : Number(value ?? 1);
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(4, Math.floor(count)));
}

function extractGeneratedCueIndex(cue: AiPartyCue): number {
  const match = cue.name.match(/_(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function generatedCueIntensity(
  baseIntensity: number | undefined,
  index: number,
  count: number,
): number {
  const base = baseIntensity ?? 0.55;
  if (count <= 1) return base;
  const spread = [-0.08, 0, 0.08, 0.13];
  return Number(Math.max(0.2, Math.min(0.85, base + (spread[index] ?? 0))).toFixed(2));
}

function withVariationMetadata(cue: AiPartyCue, index: number, count: number): AiPartyCue {
  if (count <= 1) return cue;
  const variation = index + 1;
  return {
    ...cue,
    label: `${cue.label} ${variation}`,
    description: `Safe variation ${variation}/${count} from: ${cue.source_prompt}`,
    generated_intensity: generatedCueIntensity(cue.generated_intensity, index, count),
  };
}

export class AiPartyLiveService {
  private readonly cfg: Required<
    Pick<
      AiPartyLiveConfig,
      | "ollamaBaseUrl"
      | "ollamaModel"
      | "tdBridgeUrl"
      | "dashboardHost"
      | "dashboardPort"
      | "telegramAllowedChatIds"
      | "telegramPollingEnabled"
      | "hardwareEnabled"
      | "dmxLiveEnabled"
      | "showMode"
      | "eventLogPath"
      | "deterministicFallback"
      | "generatedCueLimit"
      | "cueStorePath"
      | "transitionSeconds"
      | "transitionTickMs"
      | "autoAdvanceEnabled"
    >
  > &
    Omit<AiPartyLiveConfig, "telegramAllowedChatIds">;

  private showState: AiPartyShowState;
  private readonly approvals: AiPartyApproval[] = [];
  private readonly events: AiPartyEvent[] = [];
  private readonly baseCues = DEFAULT_AI_PARTY_CUE_CATALOG;
  private readonly generatedCues: AiPartyCue[] = [];
  private readonly cueHistory: AiPartyCueHistoryItem[] = [];
  private readonly audienceSuggestions: AiPartyAudienceSuggestion[] = [];
  private readonly timeline = DEFAULT_AI_PARTY_TIMELINE;
  private timelineIndex = 0;
  private lastLlm: AiPartyLlmSummary = {};
  private readonly sockets = new Set<Socket>();
  private eventCount = 0;
  private approvalCount = 0;
  private generatedCueCount = 0;
  private audienceSuggestionCount = 0;
  private tdClient: TouchDesignerClient;
  private telegramOffset: number | undefined;
  private telegramPollTimer: ReturnType<typeof setTimeout> | undefined;
  private telegramPollingStopped = true;
  private lastVisual: { key: string; intensity: number } | undefined;
  private transitionToken = 0;
  private currentTransition: AiPartyTransitionInfo | undefined;
  private pendingTransition: Promise<void> = Promise.resolve();
  private pendingCrowdUpdate: Promise<void> = Promise.resolve();
  private morphSecondsOverride: number | undefined;
  private readonly energySeries: AiPartyEnergyPoint[] = [];
  private readonly sessionStartedAt = nowIso();
  private sceneStartedAt = nowIso();
  private autoAdvance: boolean;
  private autoAdvanceTimer: ReturnType<typeof setInterval> | undefined;

  constructor(config: AiPartyLiveConfig = {}) {
    const eventLogPath = config.eventLogPath ?? "./data/ai-party-poc-events.jsonl";
    this.cfg = {
      ollamaBaseUrl: config.ollamaBaseUrl ?? "http://127.0.0.1:11434",
      ollamaModel: config.ollamaModel ?? "",
      tdBridgeUrl: config.tdBridgeUrl ?? "http://127.0.0.1:9980",
      dashboardHost: config.dashboardHost ?? "127.0.0.1",
      dashboardPort: config.dashboardPort ?? 8787,
      telegramAllowedChatIds: config.telegramAllowedChatIds ?? [],
      telegramPollingEnabled: config.telegramPollingEnabled ?? false,
      hardwareEnabled: config.hardwareEnabled ?? false,
      dmxLiveEnabled: config.dmxLiveEnabled ?? false,
      showMode: config.showMode ?? "rehearsal",
      eventLogPath,
      deterministicFallback: config.deterministicFallback ?? true,
      generatedCueLimit: config.generatedCueLimit ?? 24,
      cueStorePath:
        config.generatedCuePath ??
        config.cueStorePath ??
        join(dirname(eventLogPath), "ai-party-generated-cues.json"),
      transitionSeconds: config.transitionSeconds ?? 2,
      transitionTickMs: config.transitionTickMs ?? 120,
      autoAdvanceEnabled: config.autoAdvanceEnabled ?? false,
      ...config,
    };
    this.autoAdvance = this.cfg.autoAdvanceEnabled;
    this.showState = createInitialAiPartyShowState({
      mode: this.cfg.showMode,
      hardware_enabled: this.cfg.hardwareEnabled,
      dmx_live_enabled: this.cfg.dmxLiveEnabled,
      telegram_status: this.cfg.telegramPollingEnabled ? "ok" : "disabled",
      timeline_scene_id: this.timeline[0]?.id,
      next_scene_id: this.timeline[1]?.id,
    });
    this.loadGeneratedCues();
    this.tdClient = new TouchDesignerClient({
      baseUrl: this.cfg.tdBridgeUrl,
      token: this.cfg.tdBridgeToken,
      timeoutMs: 1500,
      retries: 0,
      fetchImpl: this.cfg.fetchImpl,
    });
  }

  private currentTimeline(): AiPartyTimelineSnapshot {
    const index = Math.max(0, Math.min(this.timelineIndex, this.timeline.length - 1));
    const current = this.timeline[index] ?? this.timeline[0];
    if (!current) throw new Error("AI Party timeline is empty");
    const next = this.timeline[index + 1];
    return {
      scenes: this.timeline.map((scene) => ({ ...scene })),
      current: { ...current },
      next: next ? { ...next } : undefined,
      index,
    };
  }

  private syncTimelineState(): void {
    const timeline = this.currentTimeline();
    this.showState = {
      ...this.showState,
      music_section: timeline.current.section,
      timeline: {
        scenes: timeline.scenes.map((scene) => scene.id) as AiPartyShowState["timeline"]["scenes"],
        current_scene: timeline.current.id as AiPartyShowState["timeline"]["current_scene"],
        next_scene: timeline.next?.id as AiPartyShowState["timeline"]["next_scene"],
        current_index: timeline.index,
      },
      timeline_scene_id: timeline.current.id,
      next_scene_id: timeline.next?.id,
    };
  }

  private loadGeneratedCues(): void {
    try {
      const loaded = loadGeneratedCueStore(this.cfg.cueStorePath);
      this.generatedCues.splice(
        0,
        this.generatedCues.length,
        ...loaded.slice(0, this.cfg.generatedCueLimit),
      );
      this.generatedCueCount = Math.max(0, ...this.generatedCues.map(extractGeneratedCueIndex));
    } catch (err) {
      this.showState.last_error = `Could not read cue store: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  private persistGeneratedCues(): void {
    try {
      saveGeneratedCueStore(this.cfg.cueStorePath, this.generatedCues);
    } catch (err) {
      this.showState.last_error = `Could not write cue store: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  private get cues(): AiPartyCue[] {
    return [...this.baseCues, ...this.generatedCues];
  }

  private cooldowns(): AiPartyFohSnapshot["cooldowns"] {
    const nowMs = Date.now();
    const cooldowns: AiPartyFohSnapshot["cooldowns"] = [];
    for (const recent of this.showState.recent_effects) {
      const policy = DEFAULT_EFFECT_POLICY.effects.find((entry) => entry.effect === recent.effect);
      const cooldownSeconds = policy?.cooldown_seconds ?? 0;
      if (cooldownSeconds <= 0) continue;
      const elapsedSeconds = Math.floor((nowMs - Date.parse(recent.at)) / 1000);
      const remainingSeconds = Math.max(0, cooldownSeconds - elapsedSeconds);
      if (remainingSeconds <= 0) continue;
      cooldowns.push({
        effect: recent.effect,
        cooldown_seconds: cooldownSeconds,
        remaining_seconds: remainingSeconds,
        last_triggered_at: recent.at,
      });
    }
    return cooldowns;
  }

  private fohSnapshot(): AiPartyFohSnapshot {
    const policy = this.showState.last_policy
      ? {
          decision: this.showState.last_policy.decision,
          reason: this.showState.last_policy.reason,
          operator_message: this.showState.last_policy.operator_message,
          risk_level: this.showState.last_policy.risk_level,
        }
      : undefined;
    return {
      bridge: {
        status: this.showState.td_status,
        url: this.cfg.tdBridgeUrl,
        last_error: this.showState.td_status === "error" ? this.showState.last_error : undefined,
        hardware_enabled: this.showState.hardware_enabled,
        dmx_live_enabled: this.showState.dmx_live_enabled,
      },
      llm: {
        active_model:
          this.lastLlm.model ?? (this.cfg.ollamaModel.trim() || "deterministic fallback"),
        status: this.showState.llm_status,
        latency_ms: this.showState.llm_latency_ms,
        last_confidence: this.lastLlm.confidence,
        last_source_summary: this.lastLlm.source_summary,
        repaired: this.lastLlm.repaired,
        fallback: this.lastLlm.fallback,
        last_error: this.lastLlm.error,
      },
      policy,
      cooldowns: this.cooldowns(),
      panic: {
        active: this.showState.panic,
        clear_endpoint: "/api/panic/clear",
      },
    };
  }

  recap(): AiPartyRecap {
    const eventTypeCount = (type: AiPartyEventType) =>
      this.events.filter((event) => event.type === type).length;
    const approvalsByStatus = (status: AiPartyApproval["status"]) =>
      this.approvals.filter((approval) => approval.status === status).length;
    const highlights = [
      ...this.cueHistory
        .slice(0, 5)
        .map((item) => `Cue ${item.cue ?? "unchanged"} / mood ${item.mood ?? "unchanged"}`),
      ...this.events
        .filter((event) => event.type === "dispatch.blocked")
        .slice(-3)
        .map((event) => `Blocked: ${JSON.stringify(event.payload)}`),
    ].slice(0, 8);
    return {
      total_events: this.events.length,
      generated_cues: this.generatedCues.length,
      favorite_cues: this.generatedCues.filter((cue) => cue.favorite).length,
      approvals: {
        pending: approvalsByStatus("pending"),
        approved: approvalsByStatus("approved") + approvalsByStatus("dispatched"),
        rejected: approvalsByStatus("rejected"),
        expired: approvalsByStatus("expired"),
      },
      blocked: eventTypeCount("dispatch.blocked"),
      touchdesigner_dispatches: eventTypeCount("dispatch.sent_to_touchdesigner"),
      simulated_dispatches: eventTypeCount("dispatch.simulated"),
      audience_suggestions: this.audienceSuggestions.filter((item) => item.status === "queued")
        .length,
      current_cue: this.showState.current_cue,
      current_mood: this.showState.current_mood,
      highlights,
    };
  }

  postShowRecap() {
    const recap = this.recap();
    const approvalTotal =
      recap.approvals.pending +
      recap.approvals.approved +
      recap.approvals.rejected +
      recap.approvals.expired;
    const recentHighlights =
      recap.highlights.length > 0
        ? recap.highlights
        : this.events
            .slice(-5)
            .map((event) => `${event.type} at ${event.at}`)
            .reverse();
    return {
      ok: true,
      generated_at: nowIso(),
      summary:
        `AI Party Live recap: ${recap.total_events} audit events, ` +
        `${approvalTotal} approval decisions, ${recap.blocked} blocked requests, ` +
        `${recap.audience_suggestions} queued audience suggestions. ` +
        `Final cue ${recap.current_cue}, mood ${recap.current_mood}.`,
      counts: {
        events: recap.total_events,
        approvals: approvalTotal,
        blocked: recap.blocked,
        touchdesigner_dispatches: recap.touchdesigner_dispatches,
        simulated_dispatches: recap.simulated_dispatches,
        generated_cues: recap.generated_cues,
        audience_suggestions: recap.audience_suggestions,
      },
      recent_highlights: recentHighlights,
      recap,
    };
  }

  snapshot(): AiPartyLiveSnapshot {
    const suggestions = this.audienceSuggestions.map((item) => ({ ...item }));
    return {
      showState: { ...this.showState, pending_approvals_count: this.pendingApprovals().length },
      approvals: this.approvals.map((approval) => ({ ...approval })),
      events: this.events.map((event) => ({ ...event })),
      cues: this.cues.map((cue) => ({ ...cue })),
      foh: this.fohSnapshot(),
      timeline: this.currentTimeline(),
      cueHistory: this.cueHistory.map((item) => ({ ...item })),
      audienceSuggestions: suggestions,
      audience_suggestions: suggestions,
      llm: { configured_model: this.cfg.ollamaModel || undefined, ...this.lastLlm },
      recap: this.recap(),
      transition: this.currentTransition ? { ...this.currentTransition } : undefined,
      energy_series: this.energySeries.map((point) => ({ ...point })),
      night_style: this.nightStyle(),
      director_notes: this.directorNotes(),
      session: this.sessionInfo(),
    };
  }

  private sessionInfo(now: Date = new Date()): AiPartySessionInfo {
    return {
      started_at: this.sessionStartedAt,
      uptime_seconds: Math.max(
        0,
        Math.floor((now.getTime() - Date.parse(this.sessionStartedAt)) / 1000),
      ),
      scene_started_at: this.sceneStartedAt,
      auto_advance: this.autoAdvance,
    };
  }

  private computeEnergyScore(now: Date = new Date()): number {
    const tenMinutesAgo = now.getTime() - 600_000;
    const recentDispatches = this.cueHistory.filter(
      (item) => Date.parse(item.at) >= tenMinutesAgo,
    ).length;
    const recentPromotions = this.audienceSuggestions.filter(
      (item) => item.status === "promoted" && Date.parse(item.at) >= tenMinutesAgo,
    ).length;
    const value =
      0.6 * this.showState.current_intensity +
      0.25 * Math.min(1, recentDispatches / 6) +
      0.15 * Math.min(1, recentPromotions / 3);
    return Number(Math.max(0, Math.min(1, value)).toFixed(3));
  }

  private recordEnergy(at: string): void {
    const value = this.computeEnergyScore(new Date(at));
    this.energySeries.push({ at, value });
    if (this.energySeries.length > 240) this.energySeries.shift();
    this.showState.crowd_energy = value;
  }

  nightStyle(): AiPartyNightStyle {
    const moodCounts = new Map<string, number>();
    for (const item of this.cueHistory) {
      if (!item.mood) continue;
      moodCounts.set(item.mood, (moodCounts.get(item.mood) ?? 0) + 1);
    }
    const tagCounts = new Map<string, number>();
    for (const cue of this.generatedCues) {
      for (const word of (cue.source_prompt ?? "").toLowerCase().split(/[^a-z0-9à-ü]+/i)) {
        if (word.length < 4) continue;
        tagCounts.set(word, (tagCounts.get(word) ?? 0) + 1);
      }
    }
    const top = <T>(entries: Map<T, number>, limit: number): T[] =>
      [...entries.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([key]) => key);
    return {
      palette_history: this.cueHistory
        .slice(0, 12)
        .map((item) => item.cue ?? item.mood ?? "unknown"),
      dominant_moods: top(moodCounts, 3).map((mood) => ({
        mood,
        count: moodCounts.get(mood) ?? 0,
      })),
      top_prompt_tags: top(tagCounts, 5),
    };
  }

  directorNotes(now: Date = new Date()): AiPartyDirectorNote[] {
    const notes: AiPartyDirectorNote[] = [];
    const at = nowIso(now);
    const note = (
      id: string,
      severity: AiPartyDirectorNote["severity"],
      text: string,
      suggested?: string[],
    ) => notes.push({ id, at, severity, text, suggested_cues: suggested });

    if (this.showState.panic) {
      note("panic-active", "warning", "Panic safe is active. Clear panic before new cues.");
    }
    if (this.showState.td_status === "error") {
      note("td-offline", "warning", "TouchDesigner bridge is unreachable; dispatches simulate.");
    }
    const oldestPending = this.pendingApprovals()[0];
    if (oldestPending && now.getTime() - Date.parse(oldestPending.created_at) > 60_000) {
      note(
        "approval-aging",
        "warning",
        `Approval ${oldestPending.id} has been waiting over a minute.`,
      );
    }
    const queuedSuggestions = this.audienceSuggestions.filter(
      (item) => item.status === "queued",
    ).length;
    if (queuedSuggestions > 0) {
      note(
        "audience-waiting",
        "info",
        `${queuedSuggestions} audience suggestion(s) awaiting review.`,
      );
    }
    this.appendSceneNotes(notes, now);
    return notes;
  }

  private appendSceneNotes(notes: AiPartyDirectorNote[], now: Date): void {
    const at = nowIso(now);
    const timeline = this.currentTimeline();
    const sceneElapsedMin = (now.getTime() - Date.parse(this.sceneStartedAt)) / 60_000;
    if (sceneElapsedMin > timeline.current.planned_minutes && timeline.next) {
      notes.push({
        id: "scene-overdue",
        at,
        severity: "suggestion",
        text: `Scene ${timeline.current.id} passed its planned ${timeline.current.planned_minutes} min; consider ${timeline.next.id}.`,
        suggested_cues: timeline.next.recommended_cues,
      });
    }
    const lastDispatchAt = this.cueHistory[0]?.at;
    if (lastDispatchAt && now.getTime() - Date.parse(lastDispatchAt) > 900_000) {
      notes.push({
        id: "cue-stale",
        at,
        severity: "suggestion",
        text: "Same look for over 15 minutes; consider a variation for the current scene.",
        suggested_cues: timeline.current.recommended_cues,
      });
    }
  }

  private pendingApprovals(): AiPartyApproval[] {
    return this.approvals.filter((approval) => approval.status === "pending");
  }

  private emit(type: AiPartyEventType, payload: unknown): AiPartyEvent {
    this.eventCount += 1;
    this.showState.pending_approvals_count = this.pendingApprovals().length;
    const event: AiPartyEvent = {
      id: `event_${String(this.eventCount).padStart(5, "0")}`,
      at: nowIso(),
      type,
      payload,
    };
    this.events.push(event);
    if (this.events.length > 500) this.events.shift();
    try {
      mkdirSync(dirname(this.cfg.eventLogPath), { recursive: true });
      appendFileSync(this.cfg.eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      // Event-log failures should be visible in state but must not crash the show surface.
      this.showState.last_error = `Could not write event log at ${this.cfg.eventLogPath}`;
    }
    for (const socket of this.sockets) {
      if (!sendWs(socket, { type: "dirty", at: event.at, event_type: type, event_id: event.id })) {
        this.sockets.delete(socket);
        socket.destroy();
      }
    }
    return event;
  }

  private pushSnapshot(socket: Socket): boolean {
    return sendWs(socket, { type: "snapshot", snapshot: this.snapshot() });
  }

  async processOperatorText(
    textValue: string,
    source: EvaluationContext["source"] = "dashboard",
  ): Promise<{
    envelope: ShowIntentEnvelope;
    policy: ReturnType<typeof evaluateAiPartyPolicy>;
    state: AiPartyShowState;
    approval?: AiPartyApproval;
    dispatch?: AiPartyDispatchResult;
  }> {
    const textInput = textValue.trim();
    this.emit("operator.command.received", { source, text: textInput });
    if (source === "dashboard" && shouldAutoGenerateAiPartyCue(textInput, this.baseCues)) {
      const generated = this.generateCue(textInput);
      this.lastLlm = {
        configured_model: this.cfg.ollamaModel || undefined,
        ok: true,
        confidence: 0.82,
        source_summary: `generated cue ${generated.cue.name}`,
        fallback: true,
      };
      return this.evaluateIntent(
        {
          intent: {
            type: "request_cue",
            cue: generated.cue.name,
            cue_kind: "combined",
            intensity: generated.cue.generated_intensity,
            timing: "now",
            reason: "dashboard freeform visual prompt generated a temporary safe cue",
          },
          confidence: 0.82,
          source_summary: `generated cue ${generated.cue.name}`,
          needs_operator_review: false,
        },
        { source, rawText: textInput },
      );
    }
    const parsed = await parseOllamaShowIntent({
      message: textInput,
      currentState: this.showState,
      ollamaBaseUrl: this.cfg.ollamaBaseUrl,
      model: this.cfg.ollamaModel,
      deterministicFallback: this.cfg.deterministicFallback,
      fetchImpl: this.cfg.fetchImpl,
    });
    this.showState.llm_status = parsed.ok ? "ok" : "error";
    this.showState.llm_latency_ms = parsed.latency_ms;
    if (parsed.error) this.showState.last_error = parsed.error;
    this.lastLlm = {
      configured_model: this.cfg.ollamaModel || undefined,
      model: parsed.model,
      ok: parsed.ok,
      confidence: parsed.envelope.confidence,
      source_summary: parsed.envelope.source_summary,
      repaired: parsed.repaired,
      fallback: !parsed.ok && this.cfg.deterministicFallback,
      latency_ms: parsed.latency_ms,
      error: parsed.error,
    };
    this.emit("llm.intent.parsed", {
      ok: parsed.ok,
      repaired: parsed.repaired,
      error: parsed.error,
      envelope: parsed.envelope,
    });
    return this.evaluateIntent(parsed.envelope, { source, rawText: textInput });
  }

  async evaluateIntent(envelope: ShowIntentEnvelope, context: EvaluationContext) {
    const policy = evaluateAiPartyPolicy(
      envelope.intent,
      this.showState,
      context.rawText,
      this.cues,
    );
    this.showState = {
      ...this.showState,
      last_intent: envelope.intent,
      last_policy: policy,
      last_source: context.source,
      pending_approvals_count: this.pendingApprovals().length,
    };
    this.emit("policy.evaluated", { source: context.source, raw_text: context.rawText, policy });

    if (policy.decision === "block") {
      this.emit("dispatch.blocked", {
        reason: policy.reason,
        operator_message: policy.operator_message,
      });
      return { envelope, policy, state: this.showState };
    }

    if (policy.decision === "approval_required") {
      this.approvalCount += 1;
      const approval: AiPartyApproval = {
        id: `approval_${String(this.approvalCount).padStart(4, "0")}`,
        created_at: nowIso(),
        source: context.source,
        raw_text: context.rawText,
        parsed_intent: envelope.intent,
        policy_result: policy,
        status: "pending",
      };
      this.approvals.push(approval);
      this.showState.pending_approvals_count = this.pendingApprovals().length;
      this.emit("approval.created", approval);
      return { envelope, policy, state: this.showState, approval };
    }

    const dispatch = await this.dispatchPolicyPlan(policy.plan, false);
    return { envelope, policy, state: this.showState, dispatch };
  }

  private queueBackground(task: () => Promise<void>): void {
    this.pendingTransition = this.pendingTransition.then(task).catch(() => undefined);
  }

  async flushBackground(): Promise<void> {
    await this.pendingTransition;
    await this.pendingCrowdUpdate;
  }

  private planVisualTransition(
    plan: ReturnType<typeof evaluateAiPartyPolicy>["plan"],
  ):
    | { from: { key: string; intensity: number }; to: { key: string; intensity: number } }
    | undefined {
    const target = extractAiPartyVisualTarget(plan);
    if (!target) return undefined;
    const to = { key: target.key, intensity: target.intensity ?? 0.55 };
    const previous = this.lastVisual;
    this.lastVisual = to;
    if (plan.some((action) => action.kind === "panic_safe")) {
      this.transitionToken += 1;
      this.currentTransition = undefined;
      return undefined;
    }
    const seconds = this.morphSecondsOverride ?? this.cfg.transitionSeconds;
    if (!previous || previous.key === to.key || seconds <= 0) return undefined;
    return { from: previous, to };
  }

  private startVisualTransition(transition: {
    from: { key: string; intensity: number };
    to: { key: string; intensity: number };
  }): void {
    const kind: AiPartyTransitionInfo["kind"] =
      this.morphSecondsOverride !== undefined ? "morph" : "cue";
    const seconds = Math.max(0.5, this.morphSecondsOverride ?? this.cfg.transitionSeconds);
    const tickMs = Math.max(0, this.cfg.transitionTickMs);
    const steps = tickMs > 0 ? Math.max(2, Math.min(24, Math.round((seconds * 1000) / tickMs))) : 6;
    this.transitionToken += 1;
    const token = this.transitionToken;
    const info: AiPartyTransitionInfo = {
      from: transition.from.key,
      to: transition.to.key,
      seconds,
      kind,
      started_at: nowIso(),
    };
    this.currentTransition = info;
    this.emit("cue.transition", { phase: "started", ...info, steps });
    this.queueBackground(async () => {
      const result = await runAiPartyVisualTransition(this.tdClient, {
        from: transition.from,
        to: transition.to,
        steps,
        tickMs,
        shouldCancel: () => token !== this.transitionToken || this.showState.panic,
      });
      if (result.completed) {
        try {
          await sendAiPartyFingerprintToTd(
            this.tdClient,
            aiPartyVisualFingerprint(transition.to.key, transition.to.intensity),
          );
        } catch {
          // The control panel snap already carries the final state; losing the
          // last fingerprint write must not fail the transition.
        }
      }
      if (token === this.transitionToken) this.currentTransition = undefined;
      this.emit("cue.transition", {
        phase: result.completed ? "completed" : result.cancelled ? "cancelled" : "failed",
        ...info,
        frames: result.frames,
        error: result.error,
      });
    });
  }

  private dispatchCameraFx(
    plan: ReturnType<typeof evaluateAiPartyPolicy>["plan"],
    mode: AiPartyDispatchResult["mode"],
  ): void {
    if (mode !== "touchdesigner") return;
    const cueAction = plan.find((action) => action.kind === "cue");
    if (!cueAction || cueAction.kind !== "cue") return;
    const cue = findAiPartyCue(cueAction.cue, this.cues);
    if (!cue?.camera_fx) return;
    const fx = cue.camera_fx;
    this.queueBackground(async () => {
      await sendAiPartyCameraFxToTd(this.tdClient, fx);
    });
  }

  private async dispatchPolicyPlan(
    plan: ReturnType<typeof evaluateAiPartyPolicy>["plan"],
    operatorApproved: boolean,
  ) {
    const transition = this.planVisualTransition(plan);
    const dispatch = await dispatchAiPartyPlan(plan, this.showState, {
      operatorApproved,
      sendToTouchDesigner: (actions) =>
        sendAiPartyActionsToTd(this.tdClient, actions, {
          skipFingerprint: Boolean(transition),
        }),
    });
    this.showState = applyDispatchToState(this.showState, plan, dispatch);
    if (transition && dispatch.mode === "touchdesigner") {
      this.startVisualTransition(transition);
    }
    this.dispatchCameraFx(plan, dispatch.mode);
    for (const action of plan) {
      if (action.kind === "cue" || action.kind === "mood" || action.kind === "panic_safe") {
        this.cueHistory.unshift({
          at: dispatch.at,
          cue:
            action.kind === "cue"
              ? action.cue
              : action.kind === "panic_safe"
                ? "panic_safe"
                : undefined,
          mood:
            action.kind === "mood"
              ? action.mood
              : action.kind === "panic_safe"
                ? "panic_safe"
                : undefined,
          intensity:
            action.kind === "cue"
              ? action.intensity
              : action.kind === "mood"
                ? action.intensity
                : 0.2,
          source: this.showState.last_source,
          dispatch_id: dispatch.id,
        });
      }
    }
    if (this.cueHistory.length > 80) this.cueHistory.length = 80;
    this.recordEnergy(dispatch.at);
    this.emit(
      dispatch.mode === "touchdesigner" ? "dispatch.sent_to_touchdesigner" : "dispatch.simulated",
      dispatch,
    );
    return dispatch;
  }

  private telegramPollingBlocker(): string | undefined {
    if (!this.cfg.telegramPollingEnabled) return "Telegram polling is disabled.";
    if (!this.cfg.telegramBotToken) return "TELEGRAM_BOT_TOKEN is not configured.";
    if (this.cfg.telegramAllowedChatIds.length === 0)
      return "TELEGRAM_ALLOWED_CHAT_IDS is required before polling starts.";
    return undefined;
  }

  private telegramChatAllowed(chatId: string | number | undefined): boolean {
    return (
      chatId !== undefined && this.cfg.telegramAllowedChatIds.map(String).includes(String(chatId))
    );
  }

  async pollTelegramOnce(timeoutSeconds = 25): Promise<AiPartyTelegramPollResult> {
    const blocker = this.telegramPollingBlocker();
    if (blocker) {
      this.showState.telegram_status =
        this.cfg.telegramPollingEnabled && blocker !== "Telegram polling is disabled."
          ? "error"
          : "disabled";
      this.showState.last_error = blocker;
      this.emit("health.changed", { telegram_status: this.showState.telegram_status, blocker });
      return { ok: false, processed: 0, ignored: [], warning: blocker };
    }

    try {
      const updates = await fetchAiPartyTelegramUpdates({
        token: this.cfg.telegramBotToken ?? "",
        offset: this.telegramOffset,
        timeout: timeoutSeconds,
        fetchImpl: this.cfg.fetchImpl,
      });
      let processed = 0;
      const ignored: AiPartyTelegramPollResult["ignored"] = [];
      for (const update of updates) {
        const chatId = telegramUpdateChatId(update);
        const rawText = telegramUpdateText(update);
        if (!rawText?.trim()) {
          ignored.push({ update_id: update.update_id, reason: "update has no text" });
          continue;
        }
        if (!this.telegramChatAllowed(chatId)) {
          ignored.push({ update_id: update.update_id, reason: "chat is not allowlisted" });
          this.emit("telegram.message.received", { chatId, ignored: "chat is not allowlisted" });
          continue;
        }
        const reply = await this.handleTelegramText(
          rawText,
          String(chatId),
          telegramUpdateOperator(update),
        );
        await sendAiPartyTelegramMessage({
          token: this.cfg.telegramBotToken ?? "",
          chatId: String(chatId),
          text: reply,
          fetchImpl: this.cfg.fetchImpl,
        });
        processed += 1;
      }
      const lastUpdate = updates.at(-1)?.update_id;
      if (lastUpdate !== undefined) this.telegramOffset = lastUpdate + 1;
      this.showState.telegram_status = "ok";
      this.emit("health.changed", {
        telegram_status: "ok",
        processed,
        ignored,
        next_offset: this.telegramOffset,
      });
      return { ok: true, next_offset: this.telegramOffset, processed, ignored };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.showState.telegram_status = "error";
      this.showState.last_error = message;
      this.emit("health.changed", { telegram_status: "error", message });
      return { ok: false, processed: 0, ignored: [], warning: message };
    }
  }

  private startTelegramPolling(): void {
    if (!this.cfg.telegramPollingEnabled) return;
    const blocker = this.telegramPollingBlocker();
    if (blocker) {
      this.showState.telegram_status = "error";
      this.showState.last_error = blocker;
      this.emit("health.changed", { telegram_status: "error", blocker });
      return;
    }

    this.telegramPollingStopped = false;
    const loop = async () => {
      if (this.telegramPollingStopped) return;
      await this.pollTelegramOnce();
      if (!this.telegramPollingStopped) {
        this.telegramPollTimer = setTimeout(loop, 1000);
      }
    };
    void loop();
  }

  private stopTelegramPolling(): void {
    this.telegramPollingStopped = true;
    if (this.telegramPollTimer) clearTimeout(this.telegramPollTimer);
    this.telegramPollTimer = undefined;
  }

  async approveApproval(id: string, operator: string): Promise<AiPartyApproval> {
    const approval = this.approvals.find((item) => item.id === id);
    if (!approval) throw new Error(`approval ${id} not found`);
    if (approval.status !== "pending") throw new Error(`approval ${id} is ${approval.status}`);

    const currentPolicy = evaluateAiPartyPolicy(
      approval.parsed_intent,
      this.showState,
      approval.raw_text,
      this.cues,
    );
    if (currentPolicy.decision !== "approval_required") {
      approval.status = "rejected";
      approval.rejected_at = nowIso();
      approval.rejection_reason = currentPolicy.operator_message;
      this.emit("approval.rejected", approval);
      return approval;
    }

    const dispatch = await this.dispatchPolicyPlan(currentPolicy.plan, true);
    approval.operator = operator.trim() || "operator";
    approval.approved_at = nowIso();
    approval.dispatched_at = dispatch.at;
    approval.status =
      dispatch.mode === "hardware" || dispatch.mode === "touchdesigner"
        ? "dispatched"
        : "simulated";
    this.showState.pending_approvals_count = this.pendingApprovals().length;
    this.emit("approval.approved", approval);
    return approval;
  }

  async rejectApproval(
    id: string,
    operator: string,
    reason = "operator rejected",
  ): Promise<AiPartyApproval> {
    const approval = this.approvals.find((item) => item.id === id);
    if (!approval) throw new Error(`approval ${id} not found`);
    if (approval.status !== "pending") throw new Error(`approval ${id} is ${approval.status}`);
    approval.status = "rejected";
    approval.operator = operator.trim() || "operator";
    approval.rejected_at = nowIso();
    approval.rejection_reason = reason;
    this.showState.pending_approvals_count = this.pendingApprovals().length;
    this.emit("approval.rejected", approval);
    return approval;
  }

  expireApprovals(now: Date = new Date()): number {
    let count = 0;
    for (const approval of this.pendingApprovals()) {
      if (now.getTime() - Date.parse(approval.created_at) <= 120_000) continue;
      approval.status = "expired";
      count += 1;
      this.emit("approval.expired", approval);
    }
    this.showState.pending_approvals_count = this.pendingApprovals().length;
    return count;
  }

  async triggerCue(cueName: string) {
    return this.evaluateIntent(
      {
        intent: {
          type: "request_cue",
          cue: cueName,
          cue_kind: cueName === "panic_safe" ? "safe_state" : "combined",
        },
        confidence: 1,
        source_summary: `dashboard cue ${cueName}`,
        needs_operator_review: false,
      },
      { source: "dashboard", rawText: `cue:${cueName}` },
    );
  }

  generateCue(prompt: string, options: { count?: number } = {}): AiPartyGenerateCueResult {
    return this.buildGeneratedCues(prompt, prompt, options.count, undefined);
  }

  async generateCueWithLlm(
    prompt: string,
    options: { count?: number } = {},
  ): Promise<AiPartyGenerateCueResult> {
    const original = prompt.trim();
    if (!this.cfg.ollamaModel.trim()) return this.generateCue(prompt, options);
    const idea = await generateOllamaCueIdea({
      prompt: original,
      ollamaBaseUrl: this.cfg.ollamaBaseUrl,
      model: this.cfg.ollamaModel,
      fetchImpl: this.cfg.fetchImpl,
    });
    if (!idea.ok || !idea.phrase) {
      return {
        ...this.generateCue(prompt, options),
        llm: { ok: false, model: idea.model, error: idea.error, latency_ms: idea.latency_ms },
      };
    }
    return {
      ...this.buildGeneratedCues(idea.phrase, original, options.count, idea.intensity),
      llm: {
        ok: true,
        model: idea.model,
        phrase: idea.phrase,
        latency_ms: idea.latency_ms,
      },
    };
  }

  private buildGeneratedCues(
    phrase: string,
    sourcePrompt: string,
    countRaw: number | undefined,
    intensityHint: number | undefined,
  ): AiPartyGenerateCueResult {
    const count = clampGeneratedCueCount(countRaw);
    const generated: AiPartyCue[] = [];
    for (let i = 0; i < count; i += 1) {
      this.generatedCueCount += 1;
      const cue = createAiPartyGeneratedCue(phrase, {
        index: this.generatedCueCount,
        currentIntensity: intensityHint ?? this.showState.current_intensity,
      });
      generated.push(
        withVariationMetadata({ ...cue, source_prompt: sourcePrompt.slice(0, 140) }, i, count),
      );
    }
    const primaryCue = generated[0];
    if (!primaryCue) throw new Error("Cue prompt did not produce a generated cue.");
    this.generatedCues.unshift(...generated);
    if (this.generatedCues.length > this.cfg.generatedCueLimit) {
      this.generatedCues.splice(this.cfg.generatedCueLimit);
    }
    this.persistGeneratedCues();
    this.emit("cue.generated", { cue: primaryCue, generated_cues: generated });
    return {
      ok: true,
      cue: primaryCue,
      generated,
      generated_cues: generated,
      cues: this.cues,
    };
  }

  updateGeneratedCue(
    cueName: string,
    updates: { label?: string; description?: string; favorite?: boolean },
  ) {
    const cue = this.generatedCues.find((item) => item.name === cueName);
    if (!cue) throw new Error("Only generated cues can be changed.");
    if (updates.label !== undefined) {
      const label = updates.label.trim().replace(/\s+/g, " ").slice(0, 80);
      if (label.length < 1) throw new Error("Cue label must have at least 1 character.");
      cue.label = label;
    }
    if (updates.description?.trim()) {
      cue.description = updates.description.trim().slice(0, 180);
    }
    if (updates.favorite !== undefined) cue.favorite = updates.favorite;
    this.persistGeneratedCues();
    this.emit("cue.updated", { cue });
    return { ok: true, cue, cues: this.cues };
  }

  deleteGeneratedCue(cueName: string) {
    const index = this.generatedCues.findIndex((item) => item.name === cueName);
    if (index < 0) throw new Error("Only generated cues can be deleted.");
    const [cue] = this.generatedCues.splice(index, 1);
    this.persistGeneratedCues();
    this.emit("cue.deleted", { cue });
    return { ok: true, cue, cues: this.cues };
  }

  async setTimelineScene(sceneIdOrIndex: string | number, operator = "dashboard") {
    const nextIndex =
      typeof sceneIdOrIndex === "number"
        ? sceneIdOrIndex
        : this.timeline.findIndex((scene) => scene.id === sceneIdOrIndex);
    if (nextIndex < 0 || nextIndex >= this.timeline.length) {
      throw new Error(`timeline scene ${sceneIdOrIndex} not found`);
    }
    this.timelineIndex = nextIndex;
    this.syncTimelineState();
    this.sceneStartedAt = nowIso();
    this.showState.last_source = operator;
    const scene = this.currentTimeline().current;
    const timeline = this.currentTimeline();
    this.emit("timeline.changed", {
      current_scene: scene.id,
      next_scene: timeline.next?.id,
      scene,
      timeline,
      operator,
    });
    const result = await this.triggerCue(scene.cue);
    this.showState.last_source = operator;
    return { ok: true, scene, timeline: this.currentTimeline(), state: this.showState, result };
  }

  async nextTimelineScene() {
    const nextIndex = Math.min(this.timelineIndex + 1, this.timeline.length - 1);
    return this.setTimelineScene(nextIndex);
  }

  async previousTimelineScene() {
    const nextIndex = Math.max(this.timelineIndex - 1, 0);
    return this.setTimelineScene(nextIndex);
  }

  setAutoAdvance(enabled: boolean) {
    this.autoAdvance = enabled;
    this.emit("director.note", {
      id: "auto-advance",
      severity: "info",
      text: enabled
        ? "Auto-advance armed: scenes move on after their planned minutes unless vetoed."
        : "Auto-advance disarmed: scene changes are manual only.",
    });
    return { ok: true, auto_advance: enabled };
  }

  async tickAutoAdvance(now: Date = new Date()) {
    if (!this.autoAdvance || this.showState.panic) return { advanced: false as const };
    const timeline = this.currentTimeline();
    if (!timeline.next) return { advanced: false as const };
    const elapsedMinutes = (now.getTime() - Date.parse(this.sceneStartedAt)) / 60_000;
    if (elapsedMinutes < timeline.current.planned_minutes) return { advanced: false as const };
    const result = await this.setTimelineScene(timeline.next.id, "auto-advance");
    return { advanced: true as const, scene: result.scene };
  }

  async morphToCue(target: string, seconds = 30) {
    const cue = findAiPartyCue(target, this.cues);
    if (!cue) throw new Error(`cue ${target} not found`);
    const bounded = Math.max(5, Math.min(120, Number(seconds) || 30));
    this.morphSecondsOverride = bounded;
    try {
      const result = await this.triggerCue(target);
      return { ok: result.policy.decision === "allow", morph_seconds: bounded, ...result };
    } finally {
      this.morphSecondsOverride = undefined;
    }
  }

  recapMarkdown(now: Date = new Date()): string {
    const recap = this.postShowRecap();
    const style = this.nightStyle();
    const history = this.cueHistory.slice(0, 10);
    const lines = [
      "# AI Party Live — Night Recap",
      "",
      `Generated at ${nowIso(now)}.`,
      "",
      "## Summary",
      "",
      recap.summary,
      "",
      "## Counts",
      "",
      ...Object.entries(recap.counts).map(
        ([key, value]) => `- ${key.replace(/_/g, " ")}: ${value}`,
      ),
      "",
      "## Night style",
      "",
      `- Dominant moods: ${
        style.dominant_moods.map((item) => `${item.mood} (${item.count}x)`).join(", ") || "none yet"
      }`,
      `- Prompt tags: ${style.top_prompt_tags.join(", ") || "none yet"}`,
      `- Palette history: ${style.palette_history.join(" → ") || "none yet"}`,
      "",
      "## Last cues",
      "",
      ...(history.length > 0
        ? history.map(
            (item) =>
              `- ${item.at.slice(11, 19)} ${item.cue ?? item.mood ?? "unknown"}${
                item.intensity !== undefined ? ` @ ${item.intensity}` : ""
              }${item.source ? ` (${item.source})` : ""}`,
          )
        : ["- no cues dispatched yet"]),
      "",
      "## Highlights",
      "",
      ...(recap.recent_highlights.length > 0
        ? recap.recent_highlights.map((highlight) => `- ${highlight}`)
        : ["- none"]),
      "",
    ];
    return lines.join("\n");
  }

  submitAudienceSuggestion(
    textValue: string,
    source: AiPartyAudienceSuggestion["source"] = "dashboard",
    operator?: string,
  ) {
    return this.queueAudienceSuggestion(textValue, undefined, operator, source);
  }

  queueAudienceSuggestion(
    textValue: string,
    chatId?: string,
    operator?: string,
    source: AiPartyAudienceSuggestion["source"] = "telegram",
  ) {
    const textInput = textValue.trim().replace(/\s+/g, " ").slice(0, 180);
    if (textInput.length < 3)
      throw new Error("Audience suggestion must have at least 3 characters.");
    const parsedInitial = parseAiPartyTelegramCommand(textInput);
    const parsed = parsedInitial.audienceSuggestion
      ? parseAiPartyTelegramCommand(parsedInitial.rawText)
      : parsedInitial;
    const envelope = parsed.envelope;
    const policy = envelope
      ? evaluateAiPartyPolicy(envelope.intent, this.showState, parsed.rawText, this.cues)
      : undefined;
    const safePlan =
      policy?.decision === "allow" &&
      policy.plan.length > 0 &&
      policy.plan.every(
        (item) =>
          item.kind === "cue" ||
          item.kind === "mood" ||
          item.kind === "announcement" ||
          item.kind === "log_note",
      );
    // Plain free-form vibes ("more neon please") carry no command envelope; they
    // are crowd-wall text only, so queue them unless the unsafe scanner trips.
    const freeformText = !envelope && !parsed.replyOnly && !parsed.approvalAction && !parsed.demo;
    const safeSuggestion =
      (safePlan || freeformText) && !isAiPartyGeneratedCuePromptUnsafe(parsed.rawText);
    this.audienceSuggestionCount += 1;
    const suggestion: AiPartyAudienceSuggestion = {
      id: `suggestion_${String(this.audienceSuggestionCount).padStart(4, "0")}`,
      at: nowIso(),
      created_at: nowIso(),
      text: parsed.rawText,
      raw_text: parsed.rawText,
      source,
      chat_id: chatId,
      operator,
      status: safeSuggestion ? "queued" : "blocked",
      policy_decision: policy?.decision ?? (safeSuggestion ? "allow" : "block"),
      policy_result: policy,
      reason: safeSuggestion
        ? undefined
        : "Audience wall accepts only safe suggestions; it cannot queue hardware, approval-gated, panic, or raw-control requests.",
    };
    if (!safeSuggestion) {
      this.emit("audience.suggestion.received", { suggestion });
      return {
        ok: false,
        suggestion,
        reason: suggestion.reason,
        suggestions: this.audienceSuggestions,
      };
    }
    this.audienceSuggestions.unshift(suggestion);
    if (this.audienceSuggestions.length > 80) this.audienceSuggestions.length = 80;
    this.emit("audience.suggestion.received", { suggestion });
    return { ok: true, suggestion, suggestions: this.audienceSuggestions };
  }

  updateAudienceSuggestion(id: string, status: "promoted" | "dismissed") {
    const suggestion = this.audienceSuggestions.find((item) => item.id === id);
    if (!suggestion) throw new Error(`audience suggestion ${id} not found`);
    if (suggestion.status === "blocked") throw new Error(`audience suggestion ${id} is blocked`);
    suggestion.status = status;
    this.emit("audience.suggestion.updated", { suggestion });
    if (status === "promoted") this.queueCrowdWallUpdate();
    return { ok: true, suggestion, suggestions: this.audienceSuggestions };
  }

  private queueCrowdWallUpdate(): void {
    const promoted = this.audienceSuggestions
      .filter((item) => item.status === "promoted")
      .slice(0, 3)
      .map((item) => ({ text: item.raw_text, operator: item.operator }));
    const crowdText = formatAiPartyCrowdText(promoted);
    this.pendingCrowdUpdate = this.pendingCrowdUpdate
      .then(() => sendAiPartyCrowdTextToTd(this.tdClient, crowdText))
      .then((sent) => {
        if (sent) {
          this.emit("audience.suggestion.updated", { crowd_wall_text: crowdText, sent: true });
        }
      })
      .catch(() => undefined);
  }

  replayEvents(limit = 80) {
    if (!existsSync(this.cfg.eventLogPath)) return { ok: true, events: [] };
    const events = readFileSync(this.cfg.eventLogPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(500, limit)))
      .map((line) => {
        try {
          return JSON.parse(line) as AiPartyEvent;
        } catch {
          return undefined;
        }
      })
      .filter((event): event is AiPartyEvent => Boolean(event));
    return { ok: true, events };
  }

  exportReplaySummary(limit = 500) {
    const replay = this.replayEvents(limit);
    const typeCounts: Record<string, number> = {};
    for (const event of replay.events) {
      typeCounts[event.type] = (typeCounts[event.type] ?? 0) + 1;
    }
    return {
      ok: true,
      event_log_path: this.cfg.eventLogPath,
      summary: {
        total_events: replay.events.length,
        first_at: replay.events[0]?.at,
        last_at: replay.events.at(-1)?.at,
        type_counts: typeCounts,
        blocked_requests: typeCounts["dispatch.blocked"] ?? 0,
        simulated_dispatches: typeCounts["dispatch.simulated"] ?? 0,
        touchdesigner_dispatches: typeCounts["dispatch.sent_to_touchdesigner"] ?? 0,
        approvals_created: typeCounts["approval.created"] ?? 0,
      },
      events: replay.events.slice(-Math.max(1, Math.min(100, limit))),
    };
  }

  async runExecutiveRehearsal() {
    const startedAt = this.events.length;
    this.emit("rehearsal.executive.started", { timeline: this.currentTimeline() });
    const steps: Array<{ label: string; status: string; detail?: unknown }> = [];

    const timeline = await this.setTimelineScene("doors", "executive-rehearsal");
    steps.push({ label: "timeline", status: timeline.ok ? "ok" : "error", detail: timeline.scene });

    const catalogCue = await this.triggerCue("premium_tropical");
    steps.push({
      label: "catalog cue",
      status: catalogCue.policy.decision,
      detail: catalogCue.policy.operator_message,
    });

    const generatedCue = this.generateCue("dark disco elegante no build").cue;
    const generatedCueResult = await this.triggerCue(generatedCue.name);
    steps.push({
      label: "generated cue",
      status: generatedCueResult.policy.decision,
      detail: generatedCue.name,
    });

    const effect = await this.evaluateIntent(
      {
        intent: { type: "arm_effect", effect: "fog", duration_seconds: 3, intensity: 0.35 },
        confidence: 1,
        source_summary: "executive rehearsal bounded fog simulation",
        needs_operator_review: true,
      },
      { source: "demo_script", rawText: "executive rehearsal bounded fog simulation" },
    );
    let effectStatus: string = effect.policy.decision;
    if (effect.approval?.id) {
      const hardwareEnabled = this.showState.hardware_enabled;
      const dmxLiveEnabled = this.showState.dmx_live_enabled;
      this.showState.hardware_enabled = false;
      this.showState.dmx_live_enabled = false;
      const approval = await this.approveApproval(effect.approval.id, "executive-rehearsal");
      this.showState.hardware_enabled = hardwareEnabled;
      this.showState.dmx_live_enabled = dmxLiveEnabled;
      effectStatus = approval.status;
    }
    steps.push({
      label: "approval-gated effect",
      status: effectStatus,
      detail: effect.policy.operator_message,
    });

    const unsafe = await this.processOperatorText(
      "blackout total e strobo máximo e raw dmx agora",
      "demo_script",
    );
    steps.push({
      label: "unsafe request",
      status: unsafe.policy.decision,
      detail: unsafe.policy.operator_message,
    });

    await this.enterPanic();
    steps.push({
      label: "panic safe proof",
      status: this.showState.panic && this.showState.current_cue === "panic_safe" ? "ok" : "error",
      detail: this.showState.current_cue,
    });

    const rehearsalEvents = this.events.slice(startedAt);
    const summary = {
      hardware_sent: rehearsalEvents.some(
        (event) =>
          typeof event.payload === "object" &&
          event.payload !== null &&
          "hardware_sent" in event.payload &&
          event.payload.hardware_sent === true,
      ),
      simulated_dispatches: rehearsalEvents.filter((event) => event.type === "dispatch.simulated")
        .length,
      blocked_requests: rehearsalEvents.filter((event) => event.type === "dispatch.blocked").length,
      pending_approvals: this.pendingApprovals().length,
      current_cue: this.showState.current_cue,
      current_scene: this.showState.timeline.current_scene,
    };
    const payload = { ok: true, steps, summary, recap: this.recap(), snapshot: this.snapshot() };
    this.emit("rehearsal.executive.completed", payload);
    return payload;
  }

  async enterPanic() {
    const result = await this.evaluateIntent(
      {
        intent: { type: "panic_status", request: "enter_panic_safe" },
        confidence: 1,
        source_summary: "dashboard panic",
        needs_operator_review: false,
      },
      { source: "dashboard", rawText: "panic" },
    );
    this.emit("panic.entered", { state: this.showState });
    return result;
  }

  clearPanic(operator = "operator") {
    this.showState = {
      ...this.showState,
      panic: false,
      current_cue: "doors_idle",
      current_mood: "ambient_arrival",
      last_source: operator,
    };
    this.emit("panic.cleared", { operator, state: this.showState });
    return this.showState;
  }

  async tdInfo() {
    try {
      const info = await this.tdClient.getInfo();
      this.showState.td_status = "ok";
      this.emit("health.changed", { td_status: "ok", info });
      return { ok: true, status: "ok", info };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.showState.td_status = "error";
      this.showState.last_error = message;
      this.emit("health.changed", { td_status: "error", message });
      return { ok: false, status: "error", message };
    }
  }

  async tdPreview() {
    const previews: AiPartyTdPreviewPayload[] = [];
    const capturedAt = nowIso();
    let lastError = "Bridge preview unavailable";
    try {
      await refreshAiPartyTdPreviewState(this.tdClient, this.showState, new Date(), {
        scene: this.showState.timeline.current_scene,
        transition: this.currentTransition
          ? `${this.currentTransition.from} → ${this.currentTransition.to}`
          : undefined,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    for (const output of AI_PARTY_TD_PREVIEW_OUTPUTS) {
      try {
        const preview = await this.tdClient.getPreview(output.path, 640, 360);
        previews.push({ ...output, preview });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = message;
        previews.push({ ...output, error: message });
      }
    }

    const firstAvailable = previews.find((item) => item.preview)?.preview;
    if (firstAvailable) {
      this.showState.td_status = "ok";
      this.emit("td.preview.updated", {
        captured_at: capturedAt,
        previews: previews
          .filter((item) => item.preview)
          .map((item) => ({
            id: item.id,
            width: item.preview?.width,
            height: item.preview?.height,
          })),
      });
      return { ok: true, preview: firstAvailable, previews, captured_at: capturedAt };
    }

    this.showState.td_status = "error";
    return { ok: false, message: lastError, previews, captured_at: capturedAt };
  }

  async tdBuild() {
    const report = await buildAiPartyTdDemo(this.tdClient);
    this.showState.td_status = report.ok ? "ok" : "error";
    this.emit("health.changed", { td_status: this.showState.td_status, report });
    return report;
  }

  async llmTest() {
    if (!this.cfg.ollamaModel.trim()) {
      return {
        ok: false,
        warning:
          "OLLAMA_MODEL is not configured. The dashboard will use deterministic fallback parsing.",
      };
    }
    const parsed = await parseOllamaShowIntent({
      message: "status check",
      currentState: this.showState,
      ollamaBaseUrl: this.cfg.ollamaBaseUrl,
      model: this.cfg.ollamaModel,
      deterministicFallback: false,
      fetchImpl: this.cfg.fetchImpl,
    });
    return parsed.ok
      ? { ok: true, model: parsed.model, latency_ms: parsed.latency_ms }
      : { ok: false, warning: parsed.error };
  }

  async telegramTest() {
    if (!this.cfg.telegramBotToken)
      return { ok: false, warning: "TELEGRAM_BOT_TOKEN is not configured." };
    if (this.cfg.telegramAllowedChatIds.length === 0) {
      return { ok: false, warning: "TELEGRAM_ALLOWED_CHAT_IDS is required before polling starts." };
    }
    return { ok: true, allowed_chat_ids: this.cfg.telegramAllowedChatIds.length };
  }

  async handleTelegramText(rawText: string, chatId: string, operator = "telegram") {
    if (
      this.cfg.telegramAllowedChatIds.length > 0 &&
      !this.cfg.telegramAllowedChatIds.includes(chatId)
    ) {
      this.emit("telegram.message.received", { chatId, ignored: "chat is not allowlisted" });
      return "Blocked: this Telegram chat is not allowlisted.";
    }
    const parsed = parseAiPartyTelegramCommand(rawText);
    this.emit("telegram.message.received", { chatId, rawText });
    const audienceMatch = rawText.trim().match(/^\/(?:suggest|vibe|vote|request)\s+(.+)/i);
    if (audienceMatch?.[1]) {
      const result = this.submitAudienceSuggestion(audienceMatch[1], "telegram", operator);
      const reply = result.ok
        ? `Suggestion ${result.suggestion.id} queued for operator review.`
        : `Suggestion blocked: ${result.suggestion.reason}`;
      this.emit("telegram.reply.sent", { chatId, reply });
      return reply;
    }
    if (parsed.replyOnly) {
      if (rawText.startsWith("/cues")) {
        return this.cues.map((cue) => `${cue.name}: ${cue.label}`).join("\n");
      }
      return `Status: cue ${this.showState.current_cue}, mood ${this.showState.current_mood}, pending ${this.pendingApprovals().length}.`;
    }
    if (parsed.approvalAction === "approve" && parsed.approvalId) {
      const approval = await this.approveApproval(parsed.approvalId, operator);
      return `Approval ${approval.id}: ${approval.status}.`;
    }
    if (parsed.approvalAction === "reject" && parsed.approvalId) {
      const approval = await this.rejectApproval(parsed.approvalId, operator, "telegram reject");
      return `Approval ${approval.id}: ${approval.status}.`;
    }
    const result = parsed.envelope
      ? await this.evaluateIntent(parsed.envelope, { source: "telegram", rawText })
      : await this.processOperatorText(rawText, "telegram");
    const approval = result.approval ? ` Approval ID: ${result.approval.id}.` : "";
    const reply = `Intent: ${result.envelope.intent.type}. Policy: ${result.policy.decision}.${approval} Current cue: ${this.showState.current_cue}.`;
    this.emit("telegram.reply.sent", { chatId, reply });
    return reply;
  }

  async start(): Promise<AiPartyLiveHandle> {
    const server = createServer((req, res) => {
      this.route(req, res).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        json(res, 500, { ok: false, error: message });
      });
    });
    server.on("upgrade", (req, socket) => {
      if ((req.url ?? "").split("?")[0] !== "/ws") {
        socket.destroy();
        return;
      }
      const key = req.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.destroy();
        return;
      }
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${wsAccept(key)}`,
          "",
          "",
        ].join("\r\n"),
      );
      const wsSocket = socket as Socket;
      this.sockets.add(wsSocket);
      wsSocket.on("close", () => this.sockets.delete(wsSocket));
      wsSocket.on("error", () => this.sockets.delete(wsSocket));
      if (!this.pushSnapshot(wsSocket)) {
        this.sockets.delete(wsSocket);
        wsSocket.destroy();
      }
    });

    return new Promise((resolve) => {
      server.listen(this.cfg.dashboardPort, this.cfg.dashboardHost, () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : this.cfg.dashboardPort;
        this.startTelegramPolling();
        this.autoAdvanceTimer = setInterval(() => {
          this.tickAutoAdvance().catch(() => undefined);
        }, 15_000);
        this.emit("show.session", { phase: "started", started_at: this.sessionStartedAt });
        resolve({
          url: `http://${this.cfg.dashboardHost}:${port}/`,
          close: () =>
            new Promise<void>((done) => {
              this.emit("show.session", { phase: "stopped" });
              this.transitionToken += 1;
              if (this.autoAdvanceTimer) clearInterval(this.autoAdvanceTimer);
              this.autoAdvanceTimer = undefined;
              this.stopTelegramPolling();
              for (const socket of this.sockets) socket.destroy();
              server.close(() => done());
            }),
        });
      });
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const path = url.pathname;

    if (method === "GET" && path === "/") {
      text(res, 200, AI_PARTY_DASHBOARD_HTML, "text/html");
      return;
    }
    if (method === "GET" && path === "/api/health") {
      json(res, 200, { ok: true, state: this.snapshot().showState });
      return;
    }
    if (method === "GET" && path === "/api/state") {
      json(res, 200, this.snapshot());
      return;
    }
    if (method === "GET" && path === "/api/events") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      json(res, 200, { events: this.events.slice(-limit) });
      return;
    }
    if (method === "GET" && path === "/api/recap") {
      json(res, 200, this.postShowRecap());
      return;
    }
    if (method === "GET" && path === "/api/recap/markdown") {
      text(res, 200, this.recapMarkdown(), "text/markdown");
      return;
    }
    if (method === "GET" && path === "/api/replay") {
      const limit = Number(url.searchParams.get("limit") ?? 500);
      json(res, 200, this.exportReplaySummary(limit));
      return;
    }
    if (method === "GET" && path === "/api/director/suggestions") {
      const timeline = this.currentTimeline();
      json(res, 200, {
        ok: true,
        notes: this.directorNotes(),
        scene: timeline.current.id,
        recommended_cues: timeline.current.recommended_cues,
      });
      return;
    }
    if (method === "POST" && path === "/api/timeline/auto") {
      const body = (await readJson(req)) as { enabled?: boolean };
      json(res, 200, this.setAutoAdvance(Boolean(body.enabled)));
      return;
    }
    if (method === "POST" && path === "/api/cues/morph") {
      const body = (await readJson(req)) as { to?: string; cue?: string; seconds?: number };
      try {
        json(res, 200, await this.morphToCue(body.to ?? body.cue ?? "", body.seconds ?? 30));
      } catch (err) {
        json(res, 404, { ok: false, message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (method === "POST" && path === "/api/rehearsal/executive") {
      json(res, 200, await this.runExecutiveRehearsal());
      return;
    }
    if (method === "GET" && path === "/api/cues") {
      json(res, 200, { cues: this.cues });
      return;
    }
    if (method === "POST" && path === "/api/cues/generate") {
      const body = (await readJson(req)) as {
        prompt?: string;
        text?: string;
        count?: number;
        use_llm?: boolean;
      };
      const prompt = body.prompt ?? body.text ?? "";
      const useLlm = body.use_llm !== false && Boolean(this.cfg.ollamaModel.trim());
      try {
        json(
          res,
          200,
          useLlm
            ? await this.generateCueWithLlm(prompt, { count: body.count })
            : this.generateCue(prompt, { count: body.count }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, 400, { ok: false, message, cues: this.cues });
      }
      return;
    }
    const cueMeta = path.match(/^\/api\/cues\/([^/]+)$/);
    if (method === "PATCH" && cueMeta?.[1]) {
      const body = (await readJson(req)) as {
        label?: string;
        description?: string;
        favorite?: boolean;
      };
      try {
        json(res, 200, this.updateGeneratedCue(decodeURIComponent(cueMeta[1]), body));
      } catch (err) {
        json(res, 404, { ok: false, message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (method === "DELETE" && cueMeta?.[1]) {
      try {
        json(res, 200, this.deleteGeneratedCue(decodeURIComponent(cueMeta[1])));
      } catch (err) {
        json(res, 404, { ok: false, message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (method === "GET" && path === "/api/timeline") {
      json(res, 200, { ok: true, timeline: this.currentTimeline() });
      return;
    }
    if (method === "POST" && path === "/api/timeline/next") {
      json(res, 200, await this.nextTimelineScene());
      return;
    }
    if (method === "POST" && path === "/api/timeline/previous") {
      json(res, 200, await this.previousTimelineScene());
      return;
    }
    if (method === "POST" && path === "/api/timeline/jump") {
      const body = (await readJson(req)) as { scene_id?: string; index?: number };
      json(res, 200, await this.setTimelineScene(body.scene_id ?? body.index ?? 0));
      return;
    }
    const timelineScene = path.match(/^\/api\/timeline\/([^/]+)$/);
    if (method === "POST" && timelineScene?.[1]) {
      json(
        res,
        200,
        await this.setTimelineScene(decodeURIComponent(timelineScene[1]), "dashboard"),
      );
      return;
    }
    if (method === "GET" && path === "/api/audience") {
      json(res, 200, { suggestions: this.audienceSuggestions });
      return;
    }
    if (method === "GET" && path === "/api/audience/suggestions") {
      json(res, 200, { suggestions: this.snapshot().audience_suggestions });
      return;
    }
    if (method === "POST" && path === "/api/audience/suggestions") {
      const body = (await readJson(req)) as {
        text?: string;
        chatId?: string;
        chat_id?: string;
        operator?: string;
        source?: "dashboard" | "telegram";
      };
      try {
        json(
          res,
          200,
          this.queueAudienceSuggestion(
            body.text ?? "",
            body.chatId ?? body.chat_id,
            body.operator,
            body.source ?? "telegram",
          ),
        );
      } catch (err) {
        json(res, 400, { ok: false, message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (method === "POST" && path === "/api/audience/suggest") {
      const body = (await readJson(req)) as { text?: string; source?: "dashboard" | "telegram" };
      try {
        json(res, 200, this.submitAudienceSuggestion(body.text ?? "", body.source ?? "dashboard"));
      } catch (err) {
        json(res, 400, { ok: false, message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    const audienceAction = path.match(/^\/api\/audience\/([^/]+)\/(promote|dismiss)$/);
    if (method === "POST" && audienceAction?.[1] && audienceAction?.[2]) {
      try {
        json(
          res,
          200,
          this.updateAudienceSuggestion(
            decodeURIComponent(audienceAction[1]),
            audienceAction[2] === "promote" ? "promoted" : "dismissed",
          ),
        );
      } catch (err) {
        json(res, 404, { ok: false, message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (method === "GET" && path === "/api/approvals") {
      json(res, 200, { approvals: this.approvals });
      return;
    }
    if (method === "POST" && path === "/api/operator/text") {
      const body = (await readJson(req)) as { text?: string };
      json(res, 200, await this.processOperatorText(body.text ?? "", "dashboard"));
      return;
    }
    if (method === "POST" && path === "/api/intents/evaluate") {
      const body = (await readJson(req)) as ShowIntentEnvelope;
      json(
        res,
        200,
        await this.evaluateIntent(body, { source: "dashboard", rawText: "manual intent" }),
      );
      return;
    }
    const approve = path.match(/^\/api\/approvals\/([^/]+)\/approve$/);
    if (method === "POST" && approve?.[1]) {
      const body = (await readJson(req)) as { operator?: string };
      json(res, 200, {
        approval: await this.approveApproval(approve[1], body.operator ?? "dashboard"),
        state: this.showState,
      });
      return;
    }
    const reject = path.match(/^\/api\/approvals\/([^/]+)\/reject$/);
    if (method === "POST" && reject?.[1]) {
      const body = (await readJson(req)) as { operator?: string; reason?: string };
      json(res, 200, {
        approval: await this.rejectApproval(reject[1], body.operator ?? "dashboard", body.reason),
        state: this.showState,
      });
      return;
    }
    const cue = path.match(/^\/api\/cues\/([^/]+)\/trigger$/);
    if (method === "POST" && cue?.[1]) {
      json(res, 200, await this.triggerCue(decodeURIComponent(cue[1])));
      return;
    }
    if (method === "POST" && path === "/api/panic") {
      const result = await this.enterPanic();
      json(res, 200, { ...result, state: this.showState });
      return;
    }
    if (method === "POST" && path === "/api/panic/clear") {
      json(res, 200, { state: this.clearPanic("dashboard") });
      return;
    }
    if (method === "GET" && path === "/api/td/info") {
      json(res, 200, await this.tdInfo());
      return;
    }
    if (method === "GET" && path === "/api/td/preview") {
      json(res, 200, await this.tdPreview());
      return;
    }
    if (method === "POST" && path === "/api/td/build") {
      json(res, 200, await this.tdBuild());
      return;
    }
    if (method === "POST" && path === "/api/telegram/test") {
      json(res, 200, await this.telegramTest());
      return;
    }
    if (method === "POST" && path === "/api/llm/test") {
      json(res, 200, await this.llmTest());
      return;
    }
    json(res, 404, { ok: false, error: "not found" });
  }
}

export function createAiPartyLiveService(config: AiPartyLiveConfig = {}): AiPartyLiveService {
  return new AiPartyLiveService(config);
}

export function ensureEventLogPath(path: string): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
}
