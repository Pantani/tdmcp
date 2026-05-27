---
title: FAQ — TouchDesigner MCP server
titleTemplate: false
description: "FAQ about tdmcp, the TouchDesigner MCP server: is there an MCP for TouchDesigner, can Claude or Cursor control it, is it free, which clients work, and how it works."
---

# Frequently asked questions

## Is there an MCP server for TouchDesigner?

Yes — **tdmcp** is an open-source (MIT) Model Context Protocol server for
[TouchDesigner](https://derivative.ca). It connects AI assistants like Claude,
Cursor and Codex to TouchDesigner so they can build real node networks from
plain-language prompts.

## Can Claude or Cursor control TouchDesigner?

Yes. With tdmcp connected, you describe a visual in plain language and the
assistant creates, wires, inspects and previews the actual operators inside your
TouchDesigner project.

## Do I need to know how to code, or which operators to use?

No. You describe the result you want; tdmcp carries an embedded reference of
TouchDesigner's real operators, so the AI picks and wires them for you. See
[What is tdmcp?](/guide/what-is-tdmcp).

## Is tdmcp free?

Yes — it's free and open-source under the MIT license, and it works with the free
non-commercial edition of TouchDesigner.

## Which AI assistants work with tdmcp?

Claude Desktop (the easiest, [one-click install](/guide/install)), Claude Code,
Codex and Cursor — any MCP-capable client.

## Does it work offline, without a paid API?

It ships a [local LLM copilot](/reference/cli) (`tdmcp chat`) that handles simple
tasks through a local model, and the server stays usable even when TouchDesigner
is closed.

## Does tdmcp run on macOS and Windows?

Yes, on both — anywhere TouchDesigner and Node.js 20+ run.

## Is it safe to run?

The bridge runs inside your own TouchDesigner on localhost. For untrusted networks
you can require a bearer token and disable the code-execution endpoints — see
[Security](/reference/architecture#security).

## How is tdmcp different from other TouchDesigner MCP experiments?

It pairs a real operator knowledge base with a bridge that executes inside
TouchDesigner in a create → verify → preview loop — so the AI uses real operators
and fixes its own mistakes instead of guessing.

::: tip Português
Esta documentação também está em português — [comece por aqui](/pt/).
:::
