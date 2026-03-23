#!/bin/bash
# Disposable script — run once to align ownership and permissions of existing mounted volume files.
# After this, setup.sh ensures all new files are created with correct ownership.
# Safe to delete once verified.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_USER="$(id -u):$(id -g)"

fix_dir() {
    local dir=$1
    if [ -d "$dir" ]; then
        echo "Fixing $dir ..."
        sudo chown -R "$TARGET_USER" "$dir"
        sudo find "$dir" -type d -exec chmod 755 {} \;
        sudo find "$dir" -type f -exec chmod 644 {} \;
    else
        echo "Skipping $dir (not found)"
    fi
}

fix_dir "$SCRIPT_DIR/database"
fix_dir "$SCRIPT_DIR/temp"
fix_dir "$SCRIPT_DIR/../data"

echo "Done."
