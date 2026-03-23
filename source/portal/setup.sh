#!/bin/bash
set -e

# Create folders with correct ownership before Docker mounts them
mkdir -p database
chown "$(id -u):$(id -g)" database
mkdir -p temp
chown "$(id -u):$(id -g)" temp

UID=$(id -u) GID=$(id -g) sudo --preserve-env=UID,GID docker compose build
echo "Portal running at http://localhost:8080"
UID=$(id -u) GID=$(id -g) sudo --preserve-env=UID,GID docker compose up
