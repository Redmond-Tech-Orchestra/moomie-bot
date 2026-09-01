#!/usr/bin/env bash
#
# Shared deploy logic for moomie-bot. Both deploy paths call this so the
# build-and-swap behavior lives in one place:
#   - GitHub Action (.github/workflows/deploy.yml): git reset, then this script
#   - deploy.ps1 (manual): scp files, then this script
#
# Why it's careful: the GitHub Action fires on every push to main, which is
# exactly when self-patch PRs land — i.e. when a coding job is likely running.
# A naive `docker compose up -d --build` recreates the container and kills the
# in-flight job. Instead we:
#   1. Build the new image (does NOT touch the running container).
#   2. Ask the bot to drain (finish active coding/chat work, stop taking new work).
#   3. Wait for running work to settle, capped at one job timeout.
#   4. Swap to the new image.
#   5. Once healthy, remove the temporary rollback image.
#
# Queued jobs are persisted in the coding_jobs table and resume on startup, so
# we only ever wait for the single *running* job — never the whole queue. If the
# wait times out we deploy anyway; the killed job is recovered + retried on boot.
#
# Env overrides:
#   DEPLOY_FORCE=1            skip the drain wait (deploy immediately)
#   DEPLOY_MAX_WAIT_SECONDS   cap on the drain wait (default 2400 = 40 min)
#   DEPLOY_TOKEN              sent as x-deploy-token if the bot requires it
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root (e.g. /opt/moomie-bot)

STATUS_URL="http://localhost:3000"
MAX_WAIT_SECONDS="${DEPLOY_MAX_WAIT_SECONDS:-2400}"
FORCE="${DEPLOY_FORCE:-0}"
IMAGE_NAME="${MOOMIE_IMAGE_NAME:-moomie-bot-bot:latest}"
ROLLBACK_IMAGE="${MOOMIE_ROLLBACK_IMAGE:-moomie-bot-bot:rollback}"
HEALTH_WAIT_SECONDS="${DEPLOY_HEALTH_WAIT_SECONDS:-120}"

# Honor a [force-deploy] marker in the latest commit message (Action path).
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git log -1 --pretty=%B 2>/dev/null | grep -qi '\[force-deploy\]'; then
    echo "==> [force-deploy] found in commit message — skipping drain wait."
    FORCE=1
  fi
fi

token_header=()
[ -n "${DEPLOY_TOKEN:-}" ] && token_header=(-H "x-deploy-token: ${DEPLOY_TOKEN}")

drained=0
undrain() {
  # Best-effort: if we bailed after draining but before swapping, let the old
  # container resume taking jobs so an aborted deploy doesn't wedge the queue.
  if [ "$drained" = "1" ]; then
    curl -fsS -X POST -H 'Content-Type: application/json' "${token_header[@]}" \
      --data '{"drain":false}' "$STATUS_URL/drain" >/dev/null 2>&1 || true
  fi
}
trap undrain EXIT

current_image="$(docker inspect --format '{{.Image}}' moomie-bot 2>/dev/null || true)"
if [ -n "$current_image" ]; then
  echo "==> Saving current image as $ROLLBACK_IMAGE…"
  docker image tag "$current_image" "$ROLLBACK_IMAGE"
fi

echo "==> Building new image (running container untouched)…"
docker compose build

if [ "$FORCE" = "1" ]; then
  echo "==> Skipping drain wait (force)."
else
  echo "==> Asking bot to drain (finish active work, stop new pickups)…"
  if curl -fsS -X POST -H 'Content-Type: application/json' "${token_header[@]}" \
       --data '{"drain":true}' "$STATUS_URL/drain" >/dev/null 2>&1; then
    drained=1
  else
    echo "   (drain endpoint unavailable — older build or bot down; continuing)"
  fi

  echo "==> Waiting for in-flight work to finish (max ${MAX_WAIT_SECONDS}s)…"
  deadline=$(( $(date +%s) + MAX_WAIT_SECONDS ))
  while :; do
    s="$(curl -fsS "$STATUS_URL/status" 2>/dev/null || echo '')"
    running="$(printf '%s' "$s" | jq -r '.queue.running // false' 2>/dev/null || echo false)"
    queued="$(printf '%s' "$s" | jq -r '.queue.queued // 0' 2>/dev/null || echo 0)"
    active_chat="$(printf '%s' "$s" | jq -r '.chat.active // 0' 2>/dev/null || echo 0)"
    if [ "$running" != "true" ] && [ "$active_chat" = "0" ]; then
      echo "   idle (${queued} queued job(s) will resume after the swap)."
      break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "   still running after ${MAX_WAIT_SECONDS}s — deploying anyway (jobs recover; chat turns are interrupted)."
      break
    fi
    mins="$(printf '%s' "$s" | jq -r '.queue.runningForMin // 0' 2>/dev/null || echo 0)"
    chat_mins="$(printf '%s' "$s" | jq -r '.chat.oldestActiveForMin // 0' 2>/dev/null || echo 0)"
    echo "   coding=${running} (${mins}min), chat=${active_chat} (${chat_mins}min) — waiting…"
    sleep 15
  done
fi

echo "==> Swapping to the new image…"
docker compose up -d

echo "==> Waiting for container health (max ${HEALTH_WAIT_SECONDS}s)…"
health_deadline=$(( $(date +%s) + HEALTH_WAIT_SECONDS ))
while :; do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' moomie-bot 2>/dev/null || echo missing)"
  if [ "$health" = "healthy" ]; then
    echo "   replacement is healthy."
    break
  fi
  if [ "$health" = "unhealthy" ] || [ "$health" = "exited" ] || [ "$health" = "missing" ] || [ "$(date +%s)" -ge "$health_deadline" ]; then
    echo "   replacement health is '$health'; restoring $ROLLBACK_IMAGE."
    if docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1; then
      docker image tag "$ROLLBACK_IMAGE" "$IMAGE_NAME"
      docker compose up -d --no-build --force-recreate
    fi
    exit 1
  fi
  sleep 5
done

# Rollback only needs to occupy disk during the risky swap/health-check window.
# Remove exactly Moomie's previous image; do not prune unrelated host images.
if docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1; then
  rollback_image_id="$(docker image inspect --format '{{.Id}}' "$ROLLBACK_IMAGE")"
  echo "==> Removing temporary rollback image…"
  docker image rm "$ROLLBACK_IMAGE" >/dev/null 2>&1 || true
  if [ "$rollback_image_id" != "$(docker inspect --format '{{.Image}}' moomie-bot)" ]; then
    docker image rm "$rollback_image_id" >/dev/null 2>&1 || true
  fi
fi

drained=0   # new container starts un-drained; nothing to undo on exit now

echo "==> Pruning Docker build cache (older than 24h)…"
docker builder prune -f --filter 'until=24h' >/dev/null 2>&1 || true

echo "==> Done."
docker ps --filter name=moomie-bot --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
