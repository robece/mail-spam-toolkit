#!/bin/bash
set -e
sudo docker compose build
echo "Portal running at http://localhost:8080"
sudo docker compose up
