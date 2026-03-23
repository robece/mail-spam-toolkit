#!/bin/bash
set -e

# Create folders with correct ownership before Docker mounts them
mkdir -p database
chown "$(id -u):$(id -g)" database
mkdir -p temp
chown "$(id -u):$(id -g)" temp

sudo docker compose build
echo "Portal running at http://localhost:8080"
sudo docker compose up
