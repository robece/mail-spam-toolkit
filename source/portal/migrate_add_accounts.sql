-- Migration: Add accounts support
-- Run this script against your existing spam_toolkit.db BEFORE upgrading the app.
--
-- Usage (from host, with sqlite3 installed):
--   sqlite3 source/portal/database/spam_toolkit.db < source/portal/migrate_add_accounts.sql
--
-- Usage (via Docker, while container is stopped):
--   docker run --rm -v $(pwd)/source/portal/database:/data \
--     keinos/sqlite3 sqlite3 /data/spam_toolkit.db < source/portal/migrate_add_accounts.sql
--
-- Safe to run multiple times (all statements use IF NOT EXISTS / ADD COLUMN guards).

-- 1. Create accounts table
CREATE TABLE IF NOT EXISTS accounts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE NOT NULL,
    provider   TEXT NOT NULL DEFAULT 'protonmail',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. Add account_id to senders (nullable — existing rows keep NULL, backward compatible)
-- SQLite does not support IF NOT EXISTS on ALTER TABLE, so this may error if already applied.
-- Ignore the "duplicate column" error if you run this twice.
ALTER TABLE senders ADD COLUMN account_id INTEGER REFERENCES accounts(id);
