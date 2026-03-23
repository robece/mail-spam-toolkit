#!/bin/bash
# Disposable script — run once to align ownership and permissions of existing mounted volume files.
# After this, setup.sh ensures all new files are created with correct ownership.
# Safe to delete once verified.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_USER="$(id -u):$(id -g)"

echo "Script location : $SCRIPT_DIR"
echo "Target user     : $TARGET_USER"
echo ""

fix_dir() {
    local dir
    dir="$(realpath "$1")"
    echo "--- $dir"
    if [ -d "$dir" ]; then
        echo "  current owner : $(stat -c '%U:%G' "$dir")"
        sudo chown -R "$TARGET_USER" "$dir" && echo "  chown done" || echo "  chown FAILED"
        sudo find "$dir" -type d -exec chmod 755 {} \;
        sudo find "$dir" -type f -exec chmod 644 {} \;
        echo "  new owner     : $(stat -c '%U:%G' "$dir")"
    else
        echo "  NOT FOUND — skipping"
    fi
    echo ""
}

fix_dir "$SCRIPT_DIR/database"
fix_dir "$SCRIPT_DIR/temp"
fix_dir "$SCRIPT_DIR/../data"

echo "Done."
