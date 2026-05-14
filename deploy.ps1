# Deploy moomie-bot
# Usage: npm run deploy
# Override target: $env:DEPLOY_HOST = "user@host"; npm run deploy
$ErrorActionPreference = "Stop"

$Remote = if ($env:DEPLOY_HOST) { $env:DEPLOY_HOST } else { "peter@schemes.me" }
$RemoteDir = "/opt/moomie-bot"

# Files/dirs to upload (excludes node_modules, .env, data, uploads, workspace, .git)
$items = @("src", "policies", "backup.sh", "package.json", "package-lock.json", "tsconfig.json", "Dockerfile", "docker-compose.yml", "eslint.config.js")

Write-Host "==> Syncing project files to $Remote..."
foreach ($item in $items) {
    if (Test-Path $item) {
        Write-Host "  $item"
        scp -r $item "${Remote}:${RemoteDir}/"
        if ($LASTEXITCODE -ne 0) { throw "scp failed for $item" }
    }
}

Write-Host "==> Building and starting on server..."
ssh $Remote "cd $RemoteDir && docker compose up -d --build"
if ($LASTEXITCODE -ne 0) { throw "docker compose failed" }

Write-Host "==> Pruning Docker build cache..."
ssh $Remote "docker builder prune -f --filter 'until=24h' 2>/dev/null"

Write-Host "==> Done! Checking status..."
ssh $Remote "docker ps --filter name=moomie-bot --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
