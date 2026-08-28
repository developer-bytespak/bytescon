FROM node:20-alpine

WORKDIR /app

COPY package.json ./
# Resolve fresh inside this image (musl/alpine). npm has a long-standing bug
# (npm/cli#4828, rollup#4699) where a lockfile generated elsewhere omits
# platform-native optional deps (@rollup/rollup-linux-x64-musl,
# @esbuild/linux-x64), which then crash Vite at runtime with MODULE_NOT_FOUND.
# Copying only package.json (no lockfile) forces npm to pick the right
# platform binaries for this image.
RUN npm install --no-audit --no-fund

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
