#!/usr/bin/env bash
# setup.sh — Builds and starts mail-spam-toolkit.
# Run from WSL or Git Bash as Administrator.

set -euo pipefail

# -- Always run from project root ---------------------------------------------
cd "$(dirname "$0")/.."

SERVICE="mail-spam-toolkit"

# -- Resolve docker command (WSL calls docker.exe on the Windows host) --------
DOCKER="docker"
if grep -qi microsoft /proc/version 2>/dev/null; then
    DOCKER="docker.exe"
fi

echo ""
echo "================================================"
echo "  $SERVICE setup"
echo "================================================"
echo ""

# -- Verify Docker is running -------------------------------------------------
if ! $DOCKER info &>/dev/null; then
    echo "[error] Docker is not running. Start the Docker service and try again."
    echo "        powershell: Start-Service docker"
    exit 1
fi

# -- Create volume directories with correct host ownership --------------------
echo "[*] Preparing directories..."
mkdir -p source/portal/database
chown "$(id -u):$(id -g)" source/portal/database
mkdir -p source/portal/temp
chown "$(id -u):$(id -g)" source/portal/temp
echo "[ok] Directories ready."

# -- Build and start ----------------------------------------------------------
echo "[*] Building and starting $SERVICE..."
UID=$(id -u) GID=$(id -g) $DOCKER compose up -d --build

echo ""
echo "[ok] $SERVICE is running."
echo ""
$DOCKER ps --filter "name=$SERVICE"
echo ""
echo "  Portal     : http://localhost:8080"
echo "  SQLite web : http://localhost:8081"
echo "  Logs       : $DOCKER compose logs -f"
echo ""
