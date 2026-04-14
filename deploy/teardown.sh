#!/usr/bin/env bash
# teardown.sh — Stops and removes mail-spam-toolkit containers and images.
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
echo "  $SERVICE teardown"
echo "================================================"
echo ""

# -- Stop and remove containers -----------------------------------------------
echo "[*] Stopping $SERVICE..."
$DOCKER compose down --remove-orphans

# -- Remove image -------------------------------------------------------------
read -rp "[?] Remove the Docker image as well? (y/N): " REMOVE_IMAGE
if [[ "${REMOVE_IMAGE,,}" == "y" ]]; then
    echo "[*] Removing image..."
    $DOCKER rmi "mail-spam-toolkit-portal:local" 2>/dev/null && echo "[ok] Image removed." || echo "[!] Image not found, skipping."
fi

echo ""
echo "[ok] $SERVICE teardown complete."
echo ""
