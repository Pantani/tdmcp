import { runChat } from "./chat.js";

const BANNER = `  tdmcp voice — voice mode coming soon
  Running in text mode via the local LLM copilot.
  (STT will be wired in once a suitable offline dep ships.)
`;

const HELP = `tdmcp voice — voice copilot (alias: tdmcp llm-voice)

Usage: tdmcp voice [flags]

Flags:
  --no-ollama   Don't auto-start Ollama; assume the endpoint is already running.
  --no-open     Don't open the browser automatically.
  --no-voice    Opt-out of voice mode even when a future STT dep is present.
  -h, --help    Show this help.

Voice mode is a forward-compatible wrapper around \`tdmcp chat\`. In v0.7 the
behaviour is identical — same Ollama setup, same browser UI — with a stub
extension point for a future offline STT layer.`;

/**
 * Extension point: replace with a real STT implementation in a future release.
 * Returns the transcribed text, or null when no audio was captured (stub).
 */
export async function recordAudio(): Promise<string | null> {
  return null; // STT deferred — text-mode only for v0.7
}

/**
 * `tdmcp voice` — thin wrapper around `runChat` with a "voice mode coming soon"
 * banner and a no-op `recordAudio` stub for future STT wiring. Strips `--no-voice`
 * before delegating so `runChat` never sees an unknown flag.
 */
export async function runVoiceCopilotChat(argv: string[] = []): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  process.stdout.write(`\n${BANNER}`);

  // Stub call — result intentionally ignored for v0.7
  await recordAudio();

  const filtered = argv.filter((a) => a !== "--no-voice");
  await runChat(filtered);
}
