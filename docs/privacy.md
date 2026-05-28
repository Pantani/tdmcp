---
title: Privacy policy
description: "tdmcp runs entirely on your own machine. It collects no personal data, has no telemetry or analytics, and sends nothing to the author or any third party."
aside: false
---

# Privacy policy

_Last updated: 27 May 2026_

## Summary

**tdmcp does not collect, store, or transmit any personal data.** It runs entirely
on your own machine, requires no account or sign-in, and contains no telemetry or
analytics. It sends nothing to the author or any third party.

## What tdmcp is

tdmcp is a local [Model Context Protocol](/reference/architecture) server plus a
small Python **bridge** that runs inside your own [TouchDesigner](https://derivative.ca)
process. There is no hosted service and no cloud component: you install it next to
TouchDesigner on your own computer, and your AI client (Claude Desktop, Claude
Code, Codex or Cursor) launches the local server.

## Data we collect

**None.** tdmcp has:

- no user accounts, sign-in, or authentication of its own;
- no telemetry, analytics, or usage tracking;
- no crash or error reporting sent anywhere.

## Network activity

The MCP server's only network activity is local HTTP requests to your **own**
TouchDesigner bridge at `127.0.0.1:9980` (the host and port are user-configurable
via `TDMCP_TD_HOST` / `TDMCP_TD_PORT`). It makes no other network connections — no
egress to the author, to Anthropic, or to any third party.

Any files you ask tdmcp to write — recipes, presets, snapshots, or
[vault](/reference/tools) exports — are saved to your own local disk and never
uploaded anywhere.

## Your AI client

When you describe a visual, your prompt and the AI's responses are processed by the
**AI client you chose** (for example Claude Desktop) under **that client's own
privacy policy**. tdmcp is not the data controller for those prompts and adds no
data collection of its own on top of your client.

## Third parties

tdmcp ships **no third-party SDKs, trackers, or analytics**. npm and GitHub are
distribution channels for the software and operate under their own privacy
policies; tdmcp itself does not send your data to them or anyone else at runtime.

## Security

The TouchDesigner bridge executes Python inside your own TouchDesigner process and
listens on `127.0.0.1:9980`. You stay in control of access:

- require a bearer token by setting `TDMCP_BRIDGE_TOKEN` (on both the server and
  TouchDesigner), and/or
- disable the code-execution endpoints by setting `TDMCP_BRIDGE_ALLOW_EXEC=0` in
  TouchDesigner's environment.

See the [architecture reference](/reference/architecture) and
[environment variables](/reference/environment) for the full security model.

## Data retention and deletion

Because tdmcp collects and retains no personal data, there is nothing for us to
store, retain, or delete. Removing the extension removes the software; any local
files you created remain under your control on your own disk.

## Contact

Questions about this policy? Please open an issue at
[github.com/Pantani/tdmcp/issues](https://github.com/Pantani/tdmcp/issues).

## Changes

If this policy changes, the updated version will be published on this page with a
new "last updated" date above.
