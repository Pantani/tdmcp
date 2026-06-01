export function renderMainHelp(): string {
  return [
    "Usage: tdmcp [command] [flags]",
    "",
    "Default with no command: start the MCP server over the configured transport.",
    "",
    "Commands:",
    "  install-bridge          Copy the TouchDesigner bridge modules and print setup steps.",
    "  install-client          Print a Claude/Codex/Cursor MCP client config snippet.",
    "  chat                    Start the local browser copilot.",
    "  llm-run                 Run a one-shot local copilot task.",
    "  dashboard               Open the read-only live dashboard TUI.",
    "  packages                Browse/install optional TouchDesigner package integrations.",
    "  --version, -v           Print the package version.",
    "  --help, -h              Show this help.",
    "",
    "Companion binary:",
    "  tdmcp-agent --help      Tool-oriented CLI for direct calls, run files and automation.",
  ].join("\n");
}
