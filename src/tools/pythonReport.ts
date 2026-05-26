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

/** Pulls the JSON report object out of a script's stdout (first `{` … last `}`). */
export function parsePythonReport<T>(stdout: string | undefined): T {
  if (!stdout) throw new TdApiError("The TouchDesigner script returned no output.");
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new TdApiError(
      `Could not parse the TouchDesigner script result: ${stdout.slice(0, 200)}`,
    );
  }
  return JSON.parse(stdout.slice(start, end + 1)) as T;
}
