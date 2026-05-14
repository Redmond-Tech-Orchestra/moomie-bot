# --- Build stage ---
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# --- Production stage ---
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ripgrep \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Git identity for the coding agent's commits
RUN git config --global user.name "moomie-bot[bot]" \
 && git config --global user.email "moomie-bot[bot]@users.noreply.github.com"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/prompts ./dist/prompts
COPY policies/ ./policies/

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV DB_PATH=/app/data/moomie.db

EXPOSE 3000

CMD ["bash", "-c", "node dist/deploy-commands.js && node dist/index.js"]
