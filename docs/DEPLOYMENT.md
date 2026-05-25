# Deployment

How to ship `tdmcp` three ways: as a **Docker** container (HTTP
transport), as a **Claude Desktop Extension** (`.dxt`, stdio), and to **npm**.

> **TouchDesigner is never containerized.** It always runs natively on the host
> with its Web Server DAT bridge listening on `127.0.0.1:9980` (see the repo
> `README.md` and `td/README.md` for the bridge setup). All deployment targets
> below are just different ways to run the *MCP server*, which then talks to
> that host-resident bridge over HTTP.

---

## 1. Docker / Docker Compose

In a container the server **must** use the HTTP transport. The default `stdio`
transport only works when the MCP client spawns the server as a local child
process; it cannot cross the container boundary. The image therefore defaults to
`TDMCP_TRANSPORT=http` on port `3939`, and reaches TouchDesigner on the host via
`host.docker.internal`.

### Compose (recommended)

```bash
docker compose up --build
```

This builds the `Dockerfile`, publishes `3939:3939`, and maps
`host.docker.internal` to the host gateway so the container can reach the
host-resident TouchDesigner bridge. Override the bridge location in the
`environment:` block of `docker-compose.yml` if TD listens elsewhere.

### Plain Docker

```bash
docker build -t tdmcp-server .
docker run --rm -p 3939:3939 \
  --add-host host.docker.internal:host-gateway \
  -e TDMCP_TD_HOST=host.docker.internal \
  -e TDMCP_TD_PORT=9980 \
  tdmcp-server
```

The MCP HTTP endpoint is then available on `http://localhost:3939`. Point an
HTTP-capable MCP client at it.

> **host.docker.internal notes.** On Docker Desktop (macOS/Windows) this name
> resolves automatically. On Linux you need the `--add-host` flag (plain Docker)
> or the `extra_hosts` entry (Compose) shown above. If TouchDesigner runs on a
> *different* machine, set `TDMCP_TD_HOST` to that machine's IP instead.

---

## 2. Claude Desktop Extension (`.dxt`)

Claude Desktop spawns the server locally, so the extension uses the **stdio**
transport (no `TDMCP_TRANSPORT` override needed). TouchDesigner still runs on the
same host; the extension exposes its host/port as user-configurable settings.

### Build the bundle

```bash
npm run build          # populate dist/ first
node scripts/build-dxt.mjs
```

`build-dxt.mjs` uses the official packer when available and otherwise falls back
to a system `zip`. The packer was renamed from `@anthropic-ai/dxt` (CLI `dxt`) to
`@anthropic-ai/mcpb` (CLI `mcpb`); the script prefers `npx @anthropic-ai/mcpb pack`
and falls back to the legacy `@anthropic-ai/dxt`, then `zip`. (The legacy `dxt`
CLI predates manifest spec 0.3 and rejects the `manifest_version` key, so install
`@anthropic-ai/mcpb` to use the official packer.) It writes `tdmcp.dxt` to the
repo root and prints install instructions.

### Install

1. Open Claude Desktop → **Settings → Extensions**.
2. **Install from file** (or drag in) `tdmcp.dxt`.
3. Set **TouchDesigner host/port** if they differ from the defaults
   (`127.0.0.1` : `9980`), then enable the extension.

The manifest lives at `dxt/manifest.json`. It declares a `node` server with
`entry_point: dist/index.js` and surfaces `TDMCP_TD_HOST` / `TDMCP_TD_PORT` via
`user_config`, injected into the server env as `${user_config.*}`.

---

## 3. Publish to npm

The package is public and unscoped (`tdmcp`).

```bash
npm run build
npm publish --access public
```

### Required `package.json` additions

The Docker/dxt/npm work above does **not** modify `package.json`. To make
publishing safe and correct, add the following keys to `package.json` (this
change is owned by the process editing `package.json`, not this doc):

```jsonc
{
  "scripts": {
    // …existing scripts…
    "prepublishOnly": "npm run build && npm test"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

- `prepublishOnly` guarantees a fresh build and a passing test suite run before
  anything is published.
- `publishConfig.access = "public"` lets the scoped package publish publicly
  without needing the `--access public` flag every time.

After those are in place, `npm publish` alone is sufficient.
