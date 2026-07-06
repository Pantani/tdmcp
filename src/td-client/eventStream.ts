import { type Logger, silentLogger } from "../utils/logger.js";
import { ParamChangedEventSchema, type TdParamChangedEvent } from "./validators.js";

export interface TdEvent {
  event: string;
  data?: unknown;
}

/**
 * Validate a `param.changed` event's data payload into a typed
 * `{ path, par, prev, value, frame }`. Returns `undefined` when the event is not
 * a well-formed `param.changed` (wrong type or malformed data), so a consumer
 * never handles a raw wire object.
 */
export function parseParamChangedEvent(event: TdEvent): TdParamChangedEvent | undefined {
  if (event.event !== "param.changed") return undefined;
  const parsed = ParamChangedEventSchema.safeParse(event.data);
  return parsed.success ? parsed.data : undefined;
}

export type TdEventHandler = (event: TdEvent) => void;

/** High-frequency events are dropped unless explicitly opted in, to avoid flooding.
 *
 * `param.changed` is coalesced bridge-side (one emit per (path, par) per window),
 * but a many-parameter or multi-op subscription can still be chatty, so it is
 * treated as high-frequency here too — an opt-in consumer sees every change; the
 * default stream stays quiet. */
const HIGH_FREQUENCY = new Set(["timeline.frame", "node.cook", "param.changed"]);

/**
 * Parses a raw WebSocket message into a `TdEvent`, applying the high-frequency
 * filter. Returns `undefined` for messages that should be ignored.
 */
export function parseEventMessage(raw: unknown, includeHighFrequency = false): TdEvent | undefined {
  if (typeof raw !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const event = (parsed as { event?: unknown }).event;
  if (typeof event !== "string") return undefined;
  if (!includeHighFrequency && HIGH_FREQUENCY.has(event)) return undefined;
  return { event, data: (parsed as { data?: unknown }).data };
}

export interface TdEventStreamOptions {
  url: string;
  onEvent: TdEventHandler;
  logger?: Logger;
  includeHighFrequency?: boolean;
}

/**
 * Connects to the TouchDesigner bridge WebSocket and forwards events. Uses the
 * built-in global `WebSocket` (Node 22+), reconnects with exponential backoff,
 * and is fully optional — the server works whether or not this connects.
 */
export class TdEventStream {
  private socket?: WebSocket;
  private closed = false;
  private backoffMs = 1000;
  private readonly url: string;
  private readonly onEvent: TdEventHandler;
  private readonly logger: Logger;
  private readonly includeHighFrequency: boolean;

  constructor(options: TdEventStreamOptions) {
    this.url = options.url;
    this.onEvent = options.onEvent;
    this.logger = options.logger ?? silentLogger;
    this.includeHighFrequency = options.includeHighFrequency ?? false;
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.backoffMs = 1000;
      this.logger.debug("event stream connected", { url: this.url });
    });
    socket.addEventListener("message", (ev) => {
      const event = parseEventMessage((ev as { data?: unknown }).data, this.includeHighFrequency);
      if (!event) return;
      try {
        this.onEvent(event);
      } catch (err) {
        this.logger.debug("event handler failed", { error: String(err) });
      }
    });
    socket.addEventListener("close", () => this.scheduleReconnect());
    socket.addEventListener("error", () => {
      // a "close" event follows; reconnection is handled there
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    const timer = setTimeout(() => this.connect(), delay);
    timer.unref?.();
  }

  close(): void {
    this.closed = true;
    try {
      this.socket?.close();
    } catch {
      // ignore
    }
  }
}
