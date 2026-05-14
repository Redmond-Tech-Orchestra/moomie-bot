# --- Build stage ---
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# --- Production stage ---
FROM mcr.microsoft.com/devcontainers/javascript-node:22

# Git identity for the coding agent's commits (system-wide so non-root `node` sees it)
RUN git config --system user.name "moomie-bot[bot]" \
 && git config --system user.email "moomie-bot[bot]@users.noreply.github.com"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/prompts ./dist/prompts
COPY policies/ ./policies/

# Pre-create writable dirs and chown all of /app to the non-root `node` user
# (the devcontainer base image provides node as UID 1000)
RUN mkdir -p /app/data /app/uploads /app/workspace \
 && chown -R node:node /app

ENV NODE_ENV=production
ENV DB_PATH=/app/data/moomie.db

USER node

EXPOSE 3000

# Liveness probe — fails container health if /health stops responding
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

CMD ["bash", "-c", "node dist/deploy-commands.js && node dist/index.js"]
