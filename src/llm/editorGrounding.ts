import { z } from "zod";
import { TdApiError, TdConnectionError, TdTimeoutError } from "../td-client/types.js";
import { EditorContextSchema } from "../td-client/validators.js";

export const EDITOR_GROUNDING_DEADLINE_MS = 1_000;
export const EDITOR_GROUNDING_MAX_BYTES = 4_096;
export const EDITOR_GROUNDING_MAX_STRING_CODE_POINTS = 160;

const GroundingReasonSchema = z.enum([
  "none",
  "bridge_offline",
  "timeout",
  "cancelled",
  "invalid_response",
  "ui_unavailable",
  "perform_mode",
  "network_editor_unavailable",
  "partial",
]);

export const EditorGroundingEvidenceSchema = z.object({
  schema_version: z.literal(1),
  status: z.enum(["available", "unavailable"]),
  verification: z.enum(["PASS", "UNVERIFIED"]),
  source: z.literal("touchdesigner_editor_context"),
  freshness: z.object({
    captured_at: z.string().datetime(),
    max_age_ms: z.literal(EDITOR_GROUNDING_DEADLINE_MS),
  }),
  reason: GroundingReasonSchema,
  context: z
    .object({
      project: z
        .object({
          name: z.string().optional(),
          save_version: z.union([z.string(), z.number()]).optional(),
          save_build: z.union([z.string(), z.number()]).optional(),
        })
        .optional(),
      touchdesigner: z
        .object({
          version: z.union([z.string(), z.number()]).optional(),
          build: z.union([z.string(), z.number()]).optional(),
        })
        .optional(),
      perform_mode: z.boolean().optional(),
      ui_available: z.boolean().optional(),
      panes: z
        .array(
          z.object({
            type: z.string().optional(),
            active: z.boolean(),
            name: z.string().optional(),
            owner: z.string().optional(),
          }),
        )
        .max(4)
        .optional(),
      active_network_editor: z
        .object({
          pane: z
            .object({
              type: z.string().optional(),
              name: z.string().optional(),
              owner: z.string().optional(),
            })
            .optional(),
          owner: z.string().optional(),
          current: z.string().optional(),
          selected: z.array(z.string()).max(8).optional(),
          rollover_operator: z.string().optional(),
          rollover_parameter: z
            .object({ name: z.string(), owner: z.string().optional() })
            .optional(),
          viewport: z
            .object({
              x: z.number().finite().optional(),
              y: z.number().finite().optional(),
              zoom: z.number().finite().optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

export type EditorGroundingEvidence = z.infer<typeof EditorGroundingEvidenceSchema>;

export interface EditorGroundingClient {
  getEditorContext(options?: {
    timeoutMs?: number;
    retry?: boolean;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface EditorGroundingContext {
  client: EditorGroundingClient;
}

type Clock = () => number;
type Context = NonNullable<EditorGroundingEvidence["context"]>;
type ActiveNetworkEditor = NonNullable<Context["active_network_editor"]>;
const PROJECT_FOLDERS = new WeakMap<EditorGroundingEvidence, string>();

const OPEN_TAG = "<tdmcp_untrusted_editor_context_json>";
const CLOSE_TAG = "</tdmcp_untrusted_editor_context_json>";

function codePointSlice(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function sanitizeText(
  value: unknown,
  limit = EDITOR_GROUNDING_MAX_STRING_CODE_POINTS,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const withoutControls = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && !(codePoint >= 0x7f && codePoint <= 0x9f);
    })
    .join("");
  return codePointSlice(withoutControls, limit);
}

function stringOrNumber(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return sanitizeText(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactObject<T extends object>(value: T): T | undefined {
  return Object.values(value).some((field) => field !== undefined) ? value : undefined;
}

function sanitizePane(raw: {
  type?: string | null;
  active: boolean;
  name?: string;
  owner?: string;
}): NonNullable<Context["panes"]>[number] {
  return {
    type: sanitizeText(raw.type),
    active: raw.active,
    name: sanitizeText(raw.name),
    owner: sanitizeText(raw.owner),
  };
}

function sanitizeActiveNetworkEditor(
  raw: NonNullable<z.infer<typeof EditorContextSchema>["active_network_editor"]>,
): ActiveNetworkEditor {
  const rawPane = raw.pane;
  const pane = compactObject({
    type: sanitizeText(rawPane.type),
    name: sanitizeText(rawPane.name),
    owner: sanitizeText(rawPane.owner),
  });
  const selected = raw.selected
    .slice(0, 8)
    .map((value) => sanitizeText(value))
    .filter((value): value is string => value !== undefined);
  const rolloverParameter = raw.rollover_parameter
    ? {
        name: sanitizeText(raw.rollover_parameter.name) ?? "",
        owner: sanitizeText(raw.rollover_parameter.owner),
      }
    : undefined;
  const viewport = raw.viewport
    ? compactObject({
        x: finiteNumber(raw.viewport.x),
        y: finiteNumber(raw.viewport.y),
        zoom: finiteNumber(raw.viewport.zoom),
      })
    : undefined;

  return {
    pane,
    owner: sanitizeText(raw.owner),
    current: sanitizeText(raw.current),
    selected: selected.length > 0 ? selected : undefined,
    rollover_operator: sanitizeText(raw.rollover_operator),
    rollover_parameter: rolloverParameter,
    viewport,
  };
}

function groundingReason(
  raw: z.infer<typeof EditorContextSchema>,
  activeNetworkEditor: ActiveNetworkEditor | undefined,
): z.infer<typeof GroundingReasonSchema> {
  if (raw.perform_mode === true) return "perform_mode";
  if (!raw.ui_available) return "ui_unavailable";
  if (!activeNetworkEditor) return "network_editor_unavailable";
  if (raw.perform_mode === null || raw.warnings.length > 0) return "partial";
  return "none";
}

function groundingVerification(
  reason: z.infer<typeof GroundingReasonSchema>,
  activeNetworkEditor: ActiveNetworkEditor | undefined,
): EditorGroundingEvidence["verification"] {
  return reason === "none" && activeNetworkEditor ? "PASS" : "UNVERIFIED";
}

function availableEvidence(
  raw: z.infer<typeof EditorContextSchema>,
  capturedAt: string,
): EditorGroundingEvidence {
  const project = compactObject({
    name: sanitizeText(raw.project.name),
    save_version: stringOrNumber(raw.project.save_version),
    save_build: stringOrNumber(raw.project.save_build),
  });
  const touchdesigner = compactObject({
    version: stringOrNumber(raw.touchdesigner.version),
    build: stringOrNumber(raw.touchdesigner.build),
  });
  const uiUsable = raw.ui_available && raw.perform_mode !== true;
  const activeNetworkEditor =
    uiUsable && raw.active_network_editor
      ? sanitizeActiveNetworkEditor(raw.active_network_editor)
      : undefined;

  const reason = groundingReason(raw, activeNetworkEditor);
  const verification = groundingVerification(reason, activeNetworkEditor);
  const evidence = EditorGroundingEvidenceSchema.parse({
    schema_version: 1,
    status: "available",
    verification,
    source: "touchdesigner_editor_context",
    freshness: { captured_at: capturedAt, max_age_ms: EDITOR_GROUNDING_DEADLINE_MS },
    reason,
    context: {
      project,
      touchdesigner,
      perform_mode: raw.perform_mode ?? undefined,
      ui_available: raw.ui_available,
      panes: uiUsable ? raw.panes.slice(0, 4).map(sanitizePane) : undefined,
      active_network_editor: activeNetworkEditor,
    },
  });
  const folder = sanitizeText(raw.project.folder, 4096);
  if (folder) PROJECT_FOLDERS.set(evidence, folder);
  return evidence;
}

/** Internal saved-project folder captured by the same bridge read, never serialized as model evidence. */
export function editorProjectFolderFromGrounding(
  evidence: EditorGroundingEvidence,
): string | undefined {
  return PROJECT_FOLDERS.get(evidence);
}

function unavailableEvidence(
  reason: "bridge_offline" | "timeout" | "cancelled" | "invalid_response",
  capturedAt: string,
): EditorGroundingEvidence {
  return EditorGroundingEvidenceSchema.parse({
    schema_version: 1,
    status: "unavailable",
    verification: "UNVERIFIED",
    source: "touchdesigner_editor_context",
    freshness: { captured_at: capturedAt, max_age_ms: EDITOR_GROUNDING_DEADLINE_MS },
    reason,
  });
}

function isExternalAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && error instanceof Error && error.name === "AbortError";
}

function classifyFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): "bridge_offline" | "timeout" | "cancelled" | "invalid_response" {
  if (signal?.aborted || isExternalAbort(error, signal)) return "cancelled";
  if (
    error instanceof TdTimeoutError ||
    (error instanceof Error && (error.name === "TdTimeoutError" || error.name === "AbortError")) ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "TD_TIMEOUT")
  ) {
    return "timeout";
  }
  if (
    error instanceof TdConnectionError ||
    (error instanceof Error && error.name === "TdConnectionError") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "TD_CONNECTION")
  ) {
    return "bridge_offline";
  }
  if (error instanceof TdApiError) return "invalid_response";
  return "invalid_response";
}

function capturedAt(now: Clock): string {
  return new Date(now()).toISOString();
}

/**
 * Read one bounded, non-retrying editor-context snapshot for a local-copilot turn.
 * The function never throws and never repeats the request. Raw errors are reduced to
 * typed reasons so project or transport details cannot leak into model context.
 */
export async function readEditorGrounding(
  ctx: EditorGroundingContext,
  signal?: AbortSignal,
  now: Clock = Date.now,
): Promise<EditorGroundingEvidence> {
  const timestamp = capturedAt(now);
  if (signal?.aborted) return unavailableEvidence("cancelled", timestamp);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = () => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new TdTimeoutError("editor grounding deadline")),
      EDITOR_GROUNDING_DEADLINE_MS,
    );
  });
  const cancellation = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    const onAbort = () => reject(new DOMException("cancelled", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  try {
    const request = Promise.resolve(
      ctx.client.getEditorContext({
        timeoutMs: EDITOR_GROUNDING_DEADLINE_MS,
        retry: false,
        signal,
      }),
    );
    const raw = await Promise.race([request, timeout, cancellation]);
    const parsed = EditorContextSchema.safeParse(raw);
    if (!parsed.success) return unavailableEvidence("invalid_response", timestamp);
    return availableEvidence(parsed.data, timestamp);
  } catch (error) {
    return unavailableEvidence(classifyFailure(error, signal), timestamp);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener();
  }
}

function escapeJsonForEvidence(json: string): string {
  return json
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function wrapEvidence(evidence: EditorGroundingEvidence): string {
  const parsed = EditorGroundingEvidenceSchema.parse(evidence);
  return `${OPEN_TAG}\n${escapeJsonForEvidence(JSON.stringify(parsed))}\n${CLOSE_TAG}`;
}

function withReducedArrays(evidence: EditorGroundingEvidence): EditorGroundingEvidence {
  if (!evidence.context) return evidence;
  return EditorGroundingEvidenceSchema.parse({
    ...evidence,
    context: {
      ...evidence.context,
      panes: evidence.context.panes?.slice(0, 2),
      active_network_editor: evidence.context.active_network_editor
        ? {
            ...evidence.context.active_network_editor,
            selected: evidence.context.active_network_editor.selected?.slice(0, 4),
          }
        : undefined,
    },
  });
}

function withoutProject(evidence: EditorGroundingEvidence): EditorGroundingEvidence {
  if (!evidence.context) return evidence;
  return EditorGroundingEvidenceSchema.parse({
    ...evidence,
    context: { ...evidence.context, project: undefined },
  });
}

function limitTouchDesignerStrings(
  touchdesigner: Context["touchdesigner"],
  limit: number,
): Context["touchdesigner"] {
  if (!touchdesigner) return undefined;
  return {
    version:
      typeof touchdesigner.version === "string"
        ? sanitizeText(touchdesigner.version, limit)
        : touchdesigner.version,
    build:
      typeof touchdesigner.build === "string"
        ? sanitizeText(touchdesigner.build, limit)
        : touchdesigner.build,
  };
}

function limitPaneStrings(pane: NonNullable<Context["panes"]>[number], limit: number) {
  return {
    active: pane.active,
    type: sanitizeText(pane.type, limit),
    name: sanitizeText(pane.name, limit),
    owner: sanitizeText(pane.owner, limit),
  };
}

function limitActivePaneStrings(pane: ActiveNetworkEditor["pane"], limit: number) {
  if (!pane) return undefined;
  return {
    type: sanitizeText(pane.type, limit),
    name: sanitizeText(pane.name, limit),
    owner: sanitizeText(pane.owner, limit),
  };
}

function limitRolloverParameterStrings(
  parameter: ActiveNetworkEditor["rollover_parameter"],
  limit: number,
) {
  if (!parameter) return undefined;
  return {
    name: sanitizeText(parameter.name, limit) ?? "",
    owner: sanitizeText(parameter.owner, limit),
  };
}

function limitActiveEditorStrings(
  active: ActiveNetworkEditor | undefined,
  limit: number,
): ActiveNetworkEditor | undefined {
  if (!active) return undefined;
  return {
    ...active,
    pane: limitActivePaneStrings(active.pane, limit),
    owner: sanitizeText(active.owner, limit),
    current: sanitizeText(active.current, limit),
    selected: active.selected?.map((value) => sanitizeText(value, limit) ?? ""),
    rollover_operator: sanitizeText(active.rollover_operator, limit),
    rollover_parameter: limitRolloverParameterStrings(active.rollover_parameter, limit),
  };
}

function limitContextStrings(
  evidence: EditorGroundingEvidence,
  limit: number,
): EditorGroundingEvidence {
  if (!evidence.context) return evidence;
  const context = evidence.context;
  const active = context.active_network_editor;
  return EditorGroundingEvidenceSchema.parse({
    ...evidence,
    context: {
      ...context,
      touchdesigner: limitTouchDesignerStrings(context.touchdesigner, limit),
      panes: context.panes?.map((pane) => limitPaneStrings(pane, limit)),
      active_network_editor: limitActiveEditorStrings(active, limit),
    },
  });
}

function fallbackEvidence(evidence: EditorGroundingEvidence): EditorGroundingEvidence {
  const available = evidence.status === "available";
  return EditorGroundingEvidenceSchema.parse({
    schema_version: 1,
    status: evidence.status,
    verification: "UNVERIFIED",
    source: evidence.source,
    freshness: evidence.freshness,
    reason: available ? "partial" : evidence.reason,
  });
}

/** Serialize evidence as one escaped, parseable and size-bounded untrusted-data block. */
export function serializeEditorGrounding(evidence: EditorGroundingEvidence): string {
  const full = EditorGroundingEvidenceSchema.parse(evidence);
  const arraysReduced = withReducedArrays(full);
  const projectRemoved = withoutProject(arraysReduced);
  const stringsReduced = limitContextStrings(projectRemoved, 64);
  const candidates = [full, arraysReduced, projectRemoved, stringsReduced, fallbackEvidence(full)];

  for (const candidate of candidates) {
    const serialized = wrapEvidence(candidate);
    if (Buffer.byteLength(serialized, "utf8") <= EDITOR_GROUNDING_MAX_BYTES) {
      return serialized;
    }
  }

  // Required fields are constants or tightly bounded timestamps/reasons, so this is unreachable.
  return wrapEvidence(fallbackEvidence(full));
}
