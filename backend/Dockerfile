# =============================================================
# GovCon Backend - Stable Docker Build (Prisma + OpenSSL Fix)
# =============================================================

FROM node:20-slim

WORKDIR /app

# 🔥 REQUIRED for Prisma
RUN apt-get update -y && apt-get install -y openssl

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Compile TypeScript
RUN npm run build

EXPOSE 3001

# Run compiled JS
CMD ["node", "dist/server.js"]