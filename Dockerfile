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

# Python + pandas/numpy/matplotlib for the analytics sandbox (eventbrite analyze tool).
# These ship via apt to avoid pip and stay within the distro's tested versions.
# matplotlib lets the sandbox save chart PNGs that get attached to Discord replies.
# Total added image weight: ~200 MB.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 \
      python3-pandas \
      python3-numpy \
      python3-matplotlib \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create only the directories that must be writable at runtime. Dependency and
# application files enter the image with their final owner, avoiding a copy-up
# of the full dependency tree in a later recursive chown layer.
RUN mkdir -p /app/data /app/uploads /app/workspace \
  /home/node/.cache /home/node/.npm /home/node/.codex /home/node/.gemini \
 && chown node:node /app /app/data /app/uploads /app/workspace \
  /home/node/.cache /home/node/.npm /home/node/.codex /home/node/.gemini

COPY --chown=node:node package.json package-lock.json* ./

USER node

RUN npm ci --omit=dev

COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/src/prompts ./dist/prompts
COPY --chown=node:node policies/ ./policies/

ENV NODE_ENV=production
ENV DB_PATH=/app/data/moomie.db

EXPOSE 3000

# Liveness probe — fails container health if /health stops responding
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

CMD ["bash", "-c", "node dist/deploy-commands.js && node dist/index.js"]
