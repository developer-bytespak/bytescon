# Build context: project root (so we can reach backend/prisma/schema.prisma)
FROM node:20-slim AS build

WORKDIR /app

# Required for Prisma query engine
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Install all deps including devDeps for the build step
COPY mcp/opportunity-mcp/package*.json ./
RUN npm ci

# Pull in the shared Prisma schema
COPY backend/prisma/schema.prisma ./prisma/schema.prisma

# Copy MCP source
COPY mcp/opportunity-mcp/src ./src
COPY mcp/opportunity-mcp/tsconfig.json ./tsconfig.json

# Generate Prisma client (writes to node_modules/.prisma/client)
RUN npx prisma generate --schema=./prisma/schema.prisma

# Compile TypeScript
RUN npx tsc

# ── Runtime image ──────────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server-http.js"]
