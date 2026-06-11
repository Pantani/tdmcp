import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname } from "node:path";
import { TouchDesignerClient } from "../../td-client/touchDesignerClient.js";
import {
  type AiPartyCue,
  createAiPartyGeneratedCue,
  DEFAULT_AI_PARTY_CUE_CATALOG,
  shouldAutoGenerateAiPartyCue,
} from "./cueCatalog.js";
import { AI_PARTY_DASHBOARD_HTML } from "./dashboardHtml.js";
import { applyDispatchToState, dispatchAiPartyPlan } from "./dispatch.js";
import { parseOllamaShowIntent } from "./ollamaClient.js";
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
  buildAiPartyTdDemo,
  refreshAiPartyTdPreviewState,
  sendAiPartyActionsToTd,
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
}

export interface AiPartyLiveSnapshot {
  showState: AiPartyShowState;
  approvals: AiPartyApproval[];
  events: AiPartyEvent[];
  cues: AiPartyCue[];
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
  if (socket.destroyed || !socket.writable) return false;
  const data = Buffer.from(JSON.stringify(payload));
  const header =
    data.length < 126
      ? Buffer.from([0x81, data.length])
      : data.length < 65536
        ? Buffer.from([0x81, 126, data.length >> 8, data.length & 0xff])
        : undefined;
  if (!header) return false;
  try {
    socket.write(Buffer.concat([header, data]));
    return true;
  } catch {
    return false;
  }
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
    >
  > &
    Omit<AiPartyLiveConfig, "telegramAllowedChatIds">;

  private showState: AiPartyShowState;
  private readonly approvals: AiPartyApproval[] = [];
  private readonly events: AiPartyEvent[] = [];
  private readonly baseCues = DEFAULT_AI_PARTY_CUE_CATALOG;
  private readonly generatedCues: AiPartyCue[] = [];
  private readonly sockets = new Set<Socket>();
  private eventCount = 0;
  private approvalCount = 0;
  private generatedCueCount = 0;
  private tdClient: TouchDesignerClient;
  private telegramOffset: number | undefined;
  private telegramPollTimer: ReturnType<typeof setTimeout> | undefined;
  private telegramPollingStopped = true;

  constructor(config: AiPartyLiveConfig = {}) {
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
      eventLogPath: config.eventLogPath ?? "./data/ai-party-poc-events.jsonl",
      deterministicFallback: config.deterministicFallback ?? true,
      ...config,
    };
    this.showState = createInitialAiPartyShowState({
      mode: this.cfg.showMode,
      hardware_enabled: this.cfg.hardwareEnabled,
      dmx_live_enabled: this.cfg.dmxLiveEnabled,
      telegram_status: this.cfg.telegramPollingEnabled ? "ok" : "disabled",
    });
    this.tdClient = new TouchDesignerClient({
      baseUrl: this.cfg.tdBridgeUrl,
      token: this.cfg.tdBridgeToken,
      timeoutMs: 1500,
      retries: 0,
      fetchImpl: this.cfg.fetchImpl,
    });
  }

  private get cues(): AiPartyCue[] {
    return [...this.baseCues, ...this.generatedCues];
  }

  snapshot(): AiPartyLiveSnapshot {
    return {
      showState: { ...this.showState, pending_approvals_count: this.pendingApprovals().length },
      approvals: this.approvals.map((approval) => ({ ...approval })),
      events: this.events.map((event) => ({ ...event })),
      cues: this.cues.map((cue) => ({ ...cue })),
    };
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
      if (!sendWs(socket, { type: "snapshot", snapshot: this.snapshot() })) {
        this.sockets.delete(socket);
        socket.destroy();
      }
    }
    return event;
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
    if (source === "dashboard" && shouldAutoGenerateAiPartyCue(textInput, this.cues)) {
      const generated = this.generateCue(textInput);
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

  private async dispatchPolicyPlan(
    plan: ReturnType<typeof evaluateAiPartyPolicy>["plan"],
    operatorApproved: boolean,
  ) {
    const dispatch = await dispatchAiPartyPlan(plan, this.showState, {
      operatorApproved,
      sendToTouchDesigner: (actions) => sendAiPartyActionsToTd(this.tdClient, actions),
    });
    this.showState = applyDispatchToState(this.showState, plan, dispatch);
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

  generateCue(prompt: string) {
    this.generatedCueCount += 1;
    const cue = createAiPartyGeneratedCue(prompt, {
      index: this.generatedCueCount,
      currentIntensity: this.showState.current_intensity,
    });
    this.generatedCues.unshift(cue);
    if (this.generatedCues.length > 12) this.generatedCues.pop();
    this.emit("cue.generated", { cue });
    return { ok: true, cue, cues: this.cues };
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
    await refreshAiPartyTdPreviewState(this.tdClient, this.showState);

    const previews: AiPartyTdPreviewPayload[] = [];
    let lastError = "Bridge preview unavailable";
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
        previews: previews
          .filter((item) => item.preview)
          .map((item) => ({
            id: item.id,
            width: item.preview?.width,
            height: item.preview?.height,
          })),
      });
      return { ok: true, preview: firstAvailable, previews };
    }

    this.showState.td_status = "error";
    return { ok: false, message: lastError, previews };
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
      if (!sendWs(wsSocket, { type: "snapshot", snapshot: this.snapshot() })) {
        this.sockets.delete(wsSocket);
        wsSocket.destroy();
      }
    });

    return new Promise((resolve) => {
      server.listen(this.cfg.dashboardPort, this.cfg.dashboardHost, () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : this.cfg.dashboardPort;
        this.startTelegramPolling();
        resolve({
          url: `http://${this.cfg.dashboardHost}:${port}/`,
          close: () =>
            new Promise<void>((done) => {
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
    if (method === "GET" && path === "/api/cues") {
      json(res, 200, { cues: this.cues });
      return;
    }
    if (method === "POST" && path === "/api/cues/generate") {
      const body = (await readJson(req)) as { prompt?: string; text?: string };
      try {
        json(res, 200, this.generateCue(body.prompt ?? body.text ?? ""));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, 400, { ok: false, message, cues: this.cues });
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
