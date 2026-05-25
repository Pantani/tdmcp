# syntax=docker/dockerfile:1
#
# Multi-stage build for the @tdmcp/server MCP server.
#
# IMPORTANT: inside a container the MCP server CANNOT use the default `stdio`
# transport — stdio only works when the MCP client spawns the process as a
# child on the same host. Across the container boundary there is no shared
# stdio, so the container runs the HTTP transport instead (TDMCP_TRANSPORT=http).
#
# TouchDesigner itself is NOT containerized; it runs on the host. The server
# reaches it via `host.docker.internal` (see docker-compose.yml for the
# host-gateway mapping that makes this resolvable on Linux).

# ---- Stage 1: build ---------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app

# Install ALL deps (including dev) using the lockfile for a reproducible build.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source and produce dist/ (tsc + tsup + copy-assets).
COPY . .
RUN npm run build

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production-only dependencies (no dev toolchain in the final image).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Built output and runtime assets.
COPY --from=build /app/dist ./dist
COPY --from=build /app/recipes ./recipes
COPY --from=build /app/td ./td

# Container defaults: HTTP transport (stdio won't cross the container boundary)
# and reach the host-resident TouchDesigner bridge via host.docker.internal.
ENV TDMCP_TRANSPORT=http \
    TDMCP_HTTP_PORT=3939 \
    TDMCP_TD_HOST=host.docker.internal

EXPOSE 3939

CMD ["node", "dist/index.js"]
