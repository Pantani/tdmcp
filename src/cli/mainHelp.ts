const TOP_LEVEL_COMPLETION_WORDS = [
  "serve",
  "init",
  "ask",
  "install-bridge",
  "install-client",
  "skills",
  "status",
  "show",
  "chat",
  "copilot-calibrate",
  "llm-run",
  "telegram",
  "creative-rag",
  "project-rag",
  "dashboard",
  "search",
  "list",
  "info",
  "install",
  "uninstall",
  "doctor",
  "packages",
  "completion",
  "--http",
  "--port",
  "--verify",
  "--wait",
  "--palette",
  "--palette-dir",
  "--package-name",
  "--write",
  "--path",
  "--dry-run",
  "--json",
  "--available",
  "--installed",
  "--project",
  "--name",
  "--pin",
  "--yes",
  "--allow-python-deps",
  "--allow-external",
  "--version",
  "--help",
];
const PACKAGE_COMPLETION_WORDS = ["path", "doctor", "--help", "-h"];
const UNSUPPORTED_COMPLETION_SHELL_MESSAGE =
  'Unsupported shell for completion. Use "bash", "zsh", or "fish".';

export interface MainCompletionCommandResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export function renderMainHelp(): string {
  return [
    "Usage: tdmcp [command] [flags]",
    "",
    "Default with no command: start the MCP server over the configured transport.",
    "",
    "Commands:",
    "  serve                   Start the MCP server; --http --port <port> for loopback HTTP.",
    "  init                    One-shot setup: install bridge, write client config, run doctor.",
    "  ask <prompt>            One-shot local copilot turn; reads stdin if no prompt is given.",
    "  install-bridge          Copy bridge modules; --palette exports a TD package; --verify/--wait probes /api/info.",
    "  install-client          Print a Claude/Codex/Cursor MCP client config snippet.",
    "  skills                  Inspect/manage bundled agent skills; mutations default to dry-run.",
    "  status                  Print build-aware runtime readiness without mutating TD.",
    "  show <profile>          Run fail-closed show gates, then enter Perform Mode (source-only; TD 2025.32820 live QA passed).",
    "  doctor                  Diagnose config, bridge, LLM and local runtime readiness.",
    "  chat                    Start the local browser copilot.",
    "  copilot-calibrate       Benchmark the configured model with synthetic tools only.",
    "  llm-run                 Run a one-shot local copilot task.",
    "  telegram                Start the allowlisted Telegram bridge to the local copilot.",
    "  creative-rag            Manage the local creative reference RAG store.",
    "  project-rag             Manage the local TouchDesigner project RAG store.",
    "  dashboard               Open the read-only live dashboard TUI.",
    "  packages                Browse/install optional TouchDesigner package integrations.",
    "  completion <shell>      Print a completion snippet for bash, zsh, or fish.",
    "  --version, -v           Print the package version.",
    "  --help, -h              Show this help.",
    "",
    "Package manager shortcuts:",
    "  search [query]          Search optional TouchDesigner package integrations.",
    "  list [--available]      List manifest-backed packages.",
    "  info <lib>              Show package metadata.",
    "  install <lib>           Stage/import a package integration.",
    "  uninstall <lib>         Remove package state for an installed integration.",
    "  packages doctor [lib]   Show package dependency/manual setup guidance.",
    "  packages path           Print the selected project/user package cache root.",
    "",
    "Companion binary:",
    "  tdmcp-agent --help      Tool-oriented CLI for direct calls, run files and automation.",
  ].join("\n");
}

export function renderMainCompletionHelp(): string {
  return [
    "Usage: tdmcp completion <bash|zsh|fish>",
    "",
    "Print a shell completion snippet for bash, zsh, or fish.",
  ].join("\n");
}

export function renderMainCompletion(shell: string): string | undefined {
  const words = TOP_LEVEL_COMPLETION_WORDS.join(" ");
  if (shell === "bash") {
    const packageWords = PACKAGE_COMPLETION_WORDS.join(" ");
    return [
      "_tdmcp() {",
      `  local cur="\${COMP_WORDS[COMP_CWORD]}"`,
      `  if [[ "\${COMP_WORDS[COMP_CWORD - 1]}" == "packages" ]]; then`,
      `    COMPREPLY=( $(compgen -W '${packageWords}' -- "$cur") )`,
      "    return",
      "  fi",
      `  COMPREPLY=( $(compgen -W '${words}' -- "$cur") )`,
      "}",
      "complete -F _tdmcp tdmcp",
      "",
    ].join("\n");
  }
  if (shell === "zsh") {
    return ["#compdef tdmcp", `_arguments '*::command:(${words})'`, ""].join("\n");
  }
  if (shell === "fish") {
    return [`complete -c tdmcp -f -a '${words}'`, ""].join("\n");
  }
  return undefined;
}

export function resolveMainCompletionCommand(
  shell: string | undefined,
): MainCompletionCommandResult {
  if (!shell || shell === "--help" || shell === "-h") {
    return { stdout: `${renderMainCompletionHelp()}\n` };
  }
  const script = renderMainCompletion(shell);
  if (script) {
    return { stdout: script };
  }
  return { stderr: `${UNSUPPORTED_COMPLETION_SHELL_MESSAGE}\n`, exitCode: 2 };
}
