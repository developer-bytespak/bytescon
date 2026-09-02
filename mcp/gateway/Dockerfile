# Multiplex MCP gateway — serves all 5 MCP servers (opportunity, knowledge,
# proposal, carrier, bankv-core) over HTTP+OAuth on a single port.
#
# Build context: project ROOT (so we can reach backend/prisma/schema.prisma
# AND every mcp/ package — the gateway has file: deps on @govcon/mcp-shared +
# the 5 server packages, so the whole mcp/ tree must be present and built).
#
# Single-stage on purpose: the gateway resolves its sibling packages through
# file: links into mcp/<pkg>/dist at runtime, so the built monorepo tree must
# travel into the runtime image intact. Image size is non-critical for one
# internal service.
FROM node:20-slim
WORKDIR /app

# Prisma query engine needs openssl.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Shared Prisma schema (resolved by the gateway's prisma:generate at build).
# Keep the repo-relative layout so each package's "../../backend/prisma/..."
# (and the gateway's prisma:generate) resolves exactly as in the source tree.
COPY backend/prisma/schema.prisma ./backend/prisma/schema.prisma

# The whole mcp monorepo: shared lib + 5 servers + gateway.
COPY mcp ./mcp

# Generate the Prisma client into /app/backend/node_modules ONCE. The MCP
# packages load the BACKEND-generated client at runtime (shared
# createPrismaClient walks up to backend/node_modules/@prisma/client), and the
# opportunity/gateway `prisma:generate` scripts copy it from
# ../../backend/node_modules/.prisma/client. In the source tree that directory
# exists from local dev; in a clean image it does NOT, so this single generate
# is what makes both the build-time copy AND runtime resolution succeed. Pinned
# to the backend's Prisma version (backend/package.json ^5.22.0) — bump together
# if the backend upgrades Prisma.
RUN cd /app/backend \
    && npm init -y >/dev/null 2>&1 \
    && npm install --no-save --no-audit --no-fund prisma@5.22.0 @prisma/client@5.22.0 \
    && npx prisma generate --schema=prisma/schema.prisma

# Build in dependency order: shared first (its dist/.d.ts is consumed by the
# servers and gateway), then each server (tsc emits dist/resource.js that the
# gateway imports), then the gateway (its build runs prisma:generate + tsc).
RUN set -eux; \
    cd /app/mcp/shared && npm ci && npm run build; \
    for s in knowledge-mcp proposal-mcp carrier-mcp bankv-core-mcp opportunity-mcp; do \
      cd "/app/mcp/$s" && npm ci && npm run build; \
    done; \
    cd /app/mcp/gateway && npm ci && npm run build

WORKDIR /app/mcp/gateway

EXPOSE 3002

# Probe the internal /health (Caddy routes the namespaced /mcp/health
# externally; bare /health is container-local here).
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server-http.js"]
