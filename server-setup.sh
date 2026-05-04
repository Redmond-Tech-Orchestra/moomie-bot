#!/usr/bin/env bash
# Server setup script for moomie-bot on schemes.me
# Run this on the server as peter (with sudo access):
#   scp server-setup.sh peter@schemes.me:~ && ssh peter@schemes.me 'bash ~/server-setup.sh'
set -euo pipefail

echo "=== Installing Docker ==="
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker peter

echo "=== Creating app directory ==="
sudo mkdir -p /opt/moomie-bot
sudo chown peter:peter /opt/moomie-bot

echo "=== Setting up nginx reverse proxy ==="
sudo tee /etc/nginx/sites-available/moomie-bot > /dev/null <<'NGINX'
server {
    listen 80;
    server_name moomie.redmondtechorchestra.org;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/moomie-bot /etc/nginx/sites-enabled/moomie-bot
sudo nginx -t && sudo systemctl reload nginx

echo "=== Getting SSL cert ==="
sudo certbot --nginx -d moomie.redmondtechorchestra.org --non-interactive --agree-tos --redirect

echo ""
echo "=== Done! ==="
echo "Docker installed (log out and back in for group to take effect)."
echo "Nginx proxying moomie.redmondtechorchestra.org -> localhost:3000"
echo "Deploy with: npm run deploy (from your local machine)"
