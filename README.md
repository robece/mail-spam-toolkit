# mail-spam-toolkit

Web-based toolkit for analyzing, managing, and deleting spam emails stored as `.eml` files.

## Overview

- **Portal** — FastAPI web app with WebSocket-driven terminal-style UI at port 8080
- **sqlite-web** — lightweight SQLite browser UI at port 8081 for DB inspection

The portal scans `.eml` files incrementally, stores metadata in SQLite, and connects to the Protonmail API for server-side email deletion.

## Requirements

- Docker

## Configuration

No environment variables required. Internal paths are fixed inside the container.

| Variable | Value | Description |
|---|---|---|
| `DATA_DIR` | `/workspace/data` | `.eml` source files |
| `DB_DIR` | `/workspace/database` | SQLite database directory |
| `DB_PATH` | `/workspace/database/spam_toolkit.db` | SQLite database file |
| `TEMP_DIR` | `/workspace/temp` | On-demand extracted attachments (ephemeral) |

## Deploy

### Local development

```bash
./deploy/setup.sh
./deploy/teardown.sh
```

**Windows only — open firewall ports:**
```powershell
.\deploy\firewall-config.ps1
.\deploy\firewall-config.ps1 -Remove
```

### First-time permission fix (existing installs only)

If `source/portal/database/` or `source/portal/temp/` were previously created by Docker as root:

```bash
cd source/portal && bash fix-permissions.sh
```

## Ports

| Port | Description |
|---|---|
| 8080 | Portal web UI |
| 8081 | sqlite-web DB browser |

## Repository Structure

```
mail-spam-toolkit/
├── docker-compose.yml
├── deploy/
│   ├── setup.sh
│   ├── teardown.sh
│   └── firewall-config.ps1
└── source/
    ├── data/                         # gitignored — .eml files per account
    │   └── {account_name}/
    │       └── deleted/{sender}/     # attachment backups before server deletion
    └── portal/
        ├── app/
        │   ├── main.py               # FastAPI server, WebSocket handler, lifespan, workers
        │   ├── db.py                 # SQLite schema + all DB operations
        │   ├── scanner.py            # Incremental .eml scanner with DB caching
        │   ├── session.py            # Per-connection session state + render logic
        │   └── protonmail.py         # Protonmail API client (SRP auth, deletion)
        ├── frontend/
        │   ├── index.html            # Single-page app shell
        │   ├── app.js                # WebSocket client + all screen renderers
        │   └── style.css             # GitHub-dark theme, monospace, CSS variables
        ├── database/                 # gitignored — SQLite DB (persistent)
        ├── temp/                     # gitignored — on-demand extracted attachments
        ├── Dockerfile
        ├── requirements.txt
        └── fix-permissions.sh        # aligns ownership of existing volume files
```

## Architecture

- **Incremental scanning**: tracks `eml_path UNIQUE` in SQLite; only rescans new files
- **Account-based folders**: `.eml` files live in `source/data/{account_name}/`
- **WebSocket session model**: stateful `Session` object per client connection
- **Container runs as host user**: `user: "${UID}:${GID}"` so volume files are owned by host user
- **WAL mode**: SQLite with WAL + foreign keys enabled
- **Path traversal protection**: `/download/{rel_path}` validates against `TEMP_DIR`
- **Protonmail deletion**: cookie-based session import saved to SQLite, reused on subsequent runs
- **Attachment backup**: before server deletion, attachments are extracted to `source/data/{account}/deleted/{sender}/`

## SQLite Schema

```sql
accounts:   id, name (UNIQUE), provider (protonmail|gmail), created_at, disabled_at
senders:    id, email (UNIQUE), unsubscribe_url, email_count, status, account_id (FK)
emails:     id, sender_id (FK), eml_path (UNIQUE), subject, date_str, preview,
            has_attachments, scanned_at, server_deleted_at, local_deleted_at
attachments: id, email_id (FK), filename, content_type, size_bytes
proton_sessions: username (PK), uid, access_token, session_id, saved_at
```

## Key Bindings

### Senders screen

| Key | Action |
|---|---|
| `↑↓` | Navigate |
| `Enter` | Open emails for sender |
| `O` | Open unsubscribe URL |
| `S` | Sender analytics |
| `A` | Global analytics |
| `X` | Deleted senders |
| `C` | Accounts management |
| `Q` | Quit |

### Emails screen

| Key | Action |
|---|---|
| `↑↓` | Navigate |
| `Space` | Select/unselect email |
| `A` | Select/deselect all |
| `O` | View attachments |
| `S` | Sender analytics |
| `D` | Delete selected on server |
| `B` | Back |

### Deleted Senders screen

| Key | Action |
|---|---|
| `↑↓` | Navigate |
| `Enter` | View deleted emails |
| `U` | Toggle unsubscribed |
| `B` | Back |

### Accounts screen

| Key | Action |
|---|---|
| `↑↓` | Navigate |
| `N` | New account |
| `D` | Toggle disable/enable |
| `B` | Back |

## Navigation Flow

```
[account_setup]  ← shown on first launch if no accounts exist
     ↓
[senders]
     ↓ Enter              ↓ X                  ↓ C
  [emails]        [deleted_senders]          [accounts]
     ↓ Space+D         ↓ Enter                  ↓ N
  [import_session]  [deleted_emails]       [account_setup]
     ↓
  [delete_progress]
     ↓ O
  [attachments]
     ↓ S
  [sender_analytics / analytics]
```

## Logs

```bash
docker compose logs -f
docker compose logs -f portal
```
