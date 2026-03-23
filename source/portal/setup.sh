#!/bin/bash
set -e

# Create database folder with correct ownership before Docker mounts it
mkdir -p database
chown "$(id -u):$(id -g)" database

sudo docker compose build
echo "Portal running at http://localhost:8080"
sudo docker compose up
