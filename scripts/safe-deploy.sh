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
#   2. Ask the bot to drain (finish the current job, stop taking new ones).
#   3. Wait for the running job to settle, capped at one job timeout.
#   4. Swap to the new image.
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

echo "==> Building new image (running container untouched)…"
docker compose build

if [ "$FORCE" = "1" ]; then
  echo "==> Skipping drain wait (force)."
else
  echo "==> Asking bot to drain (finish current job, stop new pickups)…"
  if curl -fsS -X POST -H 'Content-Type: application/json' "${token_header[@]}" \
       --data '{"drain":true}' "$STATUS_URL/drain" >/dev/null 2>&1; then
    drained=1
  else
    echo "   (drain endpoint unavailable — older build or bot down; continuing)"
  fi

  echo "==> Waiting for the in-flight job to finish (max ${MAX_WAIT_SECONDS}s)…"
  deadline=$(( $(date +%s) + MAX_WAIT_SECONDS ))
  while :; do
    s="$(curl -fsS "$STATUS_URL/status" 2>/dev/null || echo '')"
    running="$(printf '%s' "$s" | jq -r '.queue.running // false' 2>/dev/null || echo false)"
    queued="$(printf '%s' "$s" | jq -r '.queue.queued // 0' 2>/dev/null || echo 0)"
    if [ "$running" != "true" ]; then
      echo "   idle (${queued} queued job(s) will resume after the swap)."
      break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "   still running after ${MAX_WAIT_SECONDS}s — deploying anyway (job will be recovered + retried)."
      break
    fi
    mins="$(printf '%s' "$s" | jq -r '.queue.runningForMin // 0' 2>/dev/null || echo 0)"
    echo "   job running (${mins}min) — waiting…"
    sleep 15
  done
fi

echo "==> Swapping to the new image…"
docker compose up -d
drained=0   # new container starts un-drained; nothing to undo on exit now

echo "==> Pruning Docker build cache (older than 24h)…"
docker builder prune -f --filter 'until=24h' >/dev/null 2>&1 || true

echo "==> Done."
docker ps --filter name=moomie-bot --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
