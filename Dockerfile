# --- Build stage ---
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# --- Production stage ---
FROM node:22-alpine

RUN apk add --no-cache sqlite git ripgrep

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

CMD ["sh", "-c", "node dist/deploy-commands.js && node dist/index.js"]
