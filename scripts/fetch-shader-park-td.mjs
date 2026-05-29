#!/usr/bin/env node
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

const DEFAULT_URL =
  "https://github.com/shader-park/shader-park-touchdesigner/releases/latest/download/Shader_Park_TD.tox";
const DEFAULT_OUT = "vendor/shader-park/Shader_Park_TD.tox";

function usage() {
  return [
    "Download the official Shader Park TouchDesigner .tox plugin.",
    "",
    "Usage:",
    "  npm run shader-park:tox",
    "  node scripts/fetch-shader-park-td.mjs --out vendor/shader-park/Shader_Park_TD.tox",
    "",
    "Options:",
    "  --out <path>  Destination path. Defaults to vendor/shader-park/Shader_Park_TD.tox",
    "  --url <url>   Override the release asset URL.",
    "  -h, --help    Show this help.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, url: DEFAULT_URL, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--out") {
      const value = argv[i + 1];
      if (!value) throw new Error("--out requires a path");
      args.out = value;
      i += 1;
    } else if (arg === "--url") {
      const value = argv[i + 1];
      if (!value) throw new Error("--url requires a URL");
      args.url = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function download(url, outPath) {
  const response = await fetch(url, {
    headers: { "user-agent": "tdmcp-fetch-shader-park-td" },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  const file = createWriteStream(outPath);
  await finished(Readable.fromWeb(response.body).pipe(file));
  return Number(response.headers.get("content-length") ?? 0);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  const outPath = resolve(args.out);
  const bytes = await download(args.url, outPath);
  const size = bytes > 0 ? ` (${bytes} bytes)` : "";
  console.log(`Downloaded Shader_Park_TD.tox to ${outPath}${size}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  console.error(usage());
  process.exit(1);
}
