export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Creates a leveled logger. All output goes to **stderr** so that stdout stays
 * reserved for the MCP stdio protocol stream.
 */
export function createLogger(level: LogLevel = "info"): Logger {
  const threshold = LEVELS[level];

  const emit = (lvl: Exclude<LogLevel, "silent">, message: string, meta?: Record<string, unknown>) => {
    if (LEVELS[lvl] < threshold) return;
    const stamp = new Date().toISOString();
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    process.stderr.write(`[tdmcp] ${stamp} ${lvl.toUpperCase()} ${message}${suffix}\n`);
  };

  return {
    debug: (message, meta) => emit("debug", message, meta),
    info: (message, meta) => emit("info", message, meta),
    warn: (message, meta) => emit("warn", message, meta),
    error: (message, meta) => emit("error", message, meta),
  };
}

/** A logger that discards everything — handy for tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
