import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

export interface HelperStatusEvent {
  type: "start" | "frame" | "stall" | "stall_limit" | "line_error" | "error" | "exit";
  label: string;
  state: "starting" | "running" | "stalled" | "failed" | "exited";
  ok: boolean;
  stale: boolean;
  restartCount: number;
  pid?: number;
  startedAtMs: number;
  lastFrameAtMs: number;
  lastFrameAgeMs: number;
  silenceMs?: number;
  error?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface StallMessageContext {
  silenceMs: number;
  restartCount: number;
  pid?: number;
}

export interface JsonLineHelperOptions {
  command: string;
  args?: string[];
  label?: string;
  stallTimeoutMs?: number;
  stallCheckIntervalMs?: number;
  killGraceMs?: number;
  maxRestarts?: number;
  onJson: (frame: unknown) => void;
  onStatus?: (event: HelperStatusEvent) => void;
  onStderr?: (chunk: Buffer) => void;
  log?: (line: string) => void;
  formatStallMessage?: (context: StallMessageContext) => string;
  formatLineError?: (err: Error, line: string) => string;
  formatExitError?: (code: number | null, signal: NodeJS.Signals | null) => string;
  spawnImpl?: (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  now?: () => number;
}

export function runJsonLineHelper(options: JsonLineHelperOptions): Promise<void>;
