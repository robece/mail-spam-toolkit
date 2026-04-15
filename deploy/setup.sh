#!/usr/bin/env bash
# setup.sh — Builds and starts mail-spam-toolkit.
# Run from WSL or Git Bash as Administrator.

set -euo pipefail

cd "$(dirname "$0")/.."

SERVICE="mail-spam-toolkit"

DOCKER="docker"
if grep -qi microsoft /proc/version 2>/dev/null; then
    DOCKER="docker.exe"
fi

echo ""
echo "================================================"
echo "  $SERVICE setup"
echo "================================================"
echo ""

if ! $DOCKER info &>/dev/null; then
    echo "[error] Docker is not running. Start the Docker service and try again."
    exit 1
fi

if [ -z "${JWT_SECRET:-}" ]; then
    echo "[warn]  JWT_SECRET is not set. A default placeholder will be used."
    echo "        Set it in your environment before running in production:"
    echo "        export JWT_SECRET=\$(openssl rand -hex 32)"
    echo ""
fi

echo "[*] Building and starting $SERVICE..."
$DOCKER compose up -d --build --force-recreate

echo ""
echo "[ok] $SERVICE is running."
echo ""
$DOCKER ps --filter "name=$SERVICE"
echo ""
echo "  Portal     : http://localhost:8080"
echo "  SQLite web : http://localhost:8081"
echo "  Logs       : $DOCKER compose logs -f"
echo ""
