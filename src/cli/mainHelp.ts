const TOP_LEVEL_COMPLETION_WORDS = [
  "serve",
  "install-bridge",
  "install-client",
  "chat",
  "llm-run",
  "dashboard",
  "search",
  "list",
  "info",
  "install",
  "uninstall",
  "doctor",
  "packages",
  "path",
  "completion",
  "--http",
  "--port",
  "--verify",
  "--wait",
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

export function renderMainHelp(): string {
  return [
    "Usage: tdmcp [command] [flags]",
    "",
    "Default with no command: start the MCP server over the configured transport.",
    "",
    "Commands:",
    "  serve                   Start the MCP server; --http --port <port> for loopback HTTP.",
    "  install-bridge          Copy the TouchDesigner bridge modules; --verify/--wait probes /api/info.",
    "  install-client          Print a Claude/Codex/Cursor MCP client config snippet.",
    "  chat                    Start the local browser copilot.",
    "  llm-run                 Run a one-shot local copilot task.",
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
    "  doctor [lib]            Show package dependency/manual setup guidance.",
    "  packages path           Print the local package cache root.",
    "",
    "Companion binary:",
    "  tdmcp-agent --help      Tool-oriented CLI for direct calls, run files and automation.",
  ].join("\n");
}

export function renderMainCompletion(shell: string): string | undefined {
  const words = TOP_LEVEL_COMPLETION_WORDS.join(" ");
  if (shell === "bash") {
    return [
      "_tdmcp() {",
      `  local cur="\${COMP_WORDS[COMP_CWORD]}"`,
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
