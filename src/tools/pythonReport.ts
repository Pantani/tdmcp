import { TdApiError } from "../td-client/types.js";

/**
 * Helpers for tools that drive a single Python pass inside TouchDesigner and read
 * back a structured JSON report. The payload travels as base64 so arbitrary user
 * strings (quotes, newlines, unicode) can never break Python's quoting; the report
 * is recovered from stdout even if TD interleaves its own log lines.
 */

/** Base64-embeds a JSON payload into a Python template (replacing `__PAYLOAD_B64__`). */
export function buildPayloadScript(template: string, payload: object): string {
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return template.replace("__PAYLOAD_B64__", b64);
}

/** Pulls the JSON report object out of a script's stdout. */
export function parsePythonReport<T>(stdout: string | undefined): T {
  if (!stdout) throw new TdApiError("The TouchDesigner script returned no output.");
  // The report is emitted as the final `print(json.dumps(...))`, so it is the
  // last non-empty line. Parse that first: it is robust to TD interleaving its
  // own log lines before the report — lines that may carry stray braces that
  // would otherwise widen (and corrupt) the `{` … `}` span heuristic below.
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        return JSON.parse(line) as T;
      } catch {
        // not valid JSON on its own — fall through to the span heuristic
      }
    }
    break; // only the last non-empty line qualifies for the single-line fast path
  }
  // Fallback: widest `{` … `}` span (covers a report printed across lines).
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(stdout.slice(start, end + 1)) as T;
    } catch {
      // fall through to the shared error below
    }
  }
  throw new TdApiError(`Could not parse the TouchDesigner script result: ${stdout.slice(0, 200)}`);
}
