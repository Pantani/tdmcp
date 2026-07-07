/**
 * Process exit-code taxonomy shared across every tdmcp / tdmcp-agent CLI command.
 *
 * The point is that a caller (a shell script, CI job, or setlist runner) can
 * branch on *why* a command failed without scraping stderr:
 *
 *   0  OK              — command succeeded.
 *   2  USAGE / CONFIG  — bad flags, invalid arguments, malformed JSON, unknown
 *                        command, unresolved config/profile, or a refused
 *                        escape-hatch. Nothing was attempted against TD.
 *   3  TD OFFLINE      — TouchDesigner / the bridge could not be reached or the
 *                        request timed out (connection-level failure).
 *   4  TD ERROR        — the bridge was reached but the operation failed: a cook
 *                        error, a bad node path, an API/validation rejection.
 *
 * Codes are deliberately small and stable; do not renumber them.
 */
export const ExitCode = {
  Ok: 0,
  Usage: 2,
  TdOffline: 3,
  TdError: 4,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Classifies a failed-command error MESSAGE into a TD offline (3) vs TD error
 * (4) exit code. The tool layer flattens `TdConnectionError`/`TdTimeoutError`
 * into the friendly result text (via `friendlyTdError`), so their distinctive
 * wording — emitted by the HTTP client — is the reliable signal at the CLI
 * boundary. Anything reached-but-failed (cook error, bad path, validation 400)
 * is a TD error.
 *
 * Pass a message that is known to represent a failure; callers decide code 0/2
 * before reaching here.
 */
export function classifyTdErrorExit(
  message: string,
): typeof ExitCode.TdOffline | typeof ExitCode.TdError {
  const m = message.toLowerCase();
  // Connection-level: the exact strings come from TouchDesignerClient's
  // TdConnectionError / TdTimeoutError, plus common raw socket phrasings that a
  // deeper cause can surface.
  if (
    m.includes("cannot reach touchdesigner") ||
    m.includes("request timed out") ||
    m.includes("econnrefused") ||
    m.includes("connection refused") ||
    m.includes("fetch failed") ||
    m.includes("network error") ||
    m.includes("enotfound") ||
    m.includes("socket hang up")
  ) {
    return ExitCode.TdOffline;
  }
  return ExitCode.TdError;
}
