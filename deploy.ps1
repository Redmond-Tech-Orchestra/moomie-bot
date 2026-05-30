# Deploy moomie-bot
# Usage: npm run deploy
# Override target: $env:DEPLOY_HOST = "user@host"; npm run deploy
# Force (skip waiting for a running coding job): npm run deploy -- -Force
param(
    [switch]$Force
)
$ErrorActionPreference = "Stop"

$Remote = if ($env:DEPLOY_HOST) { $env:DEPLOY_HOST } else { "peter@schemes.me" }
$RemoteDir = "/opt/moomie-bot"

# Files/dirs to upload (excludes node_modules, .env, data, uploads, workspace, .git)
$items = @("src", "scripts", "policies", "backup.sh", "package.json", "package-lock.json", "tsconfig.json", "Dockerfile", "docker-compose.yml", "eslint.config.js")

Write-Host "==> Syncing project files to $Remote..."
foreach ($item in $items) {
    if (Test-Path $item) {
        Write-Host "  $item"
        scp -r $item "${Remote}:${RemoteDir}/"
        if ($LASTEXITCODE -ne 0) { throw "scp failed for $item" }
    }
}

# Build, drain the running coding job, then swap — shared with the GitHub Action.
$forceEnv = if ($Force) { "1" } else { "0" }
Write-Host "==> Building and deploying on server (force=$forceEnv)..."
ssh $Remote "cd $RemoteDir && DEPLOY_FORCE=$forceEnv bash scripts/safe-deploy.sh"
if ($LASTEXITCODE -ne 0) { throw "deploy failed" }

