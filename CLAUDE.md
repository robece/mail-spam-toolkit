# CLAUDE.md — Mail Spam Toolkit

## ⚠️ Security Directive

**NEVER** include, reference, read, or expose contents of:
- `source/data/` — contains personal `.eml` files
- `source/portal/database/` — contains SQLite DB with personal email data and extracted attachments

These folders are gitignored and must **never** appear in commits, diffs, logs, or any output.

---

## Project Overview

A web-based toolkit for analyzing, managing, and deleting spam emails stored as `.eml` files.

- **Portal** — FastAPI web app with WebSocket-driven terminal-style UI, accessible at port 8080
- **sqlite-web** — lightweight SQLite browser UI at port 8081 (for DB inspection)

---

## Repository Structure

```
source/
├── portal/
│   ├── app/
│   │   ├── main.py           # FastAPI server, WebSocket handler, lifespan, workers
│   │   ├── db.py             # SQLite schema + all DB operations
│   │   ├── scanner.py        # Incremental .eml scanner with DB caching
│   │   ├── session.py        # Per-connection session state + render logic
│   │   └── protonmail.py     # Protonmail API client (SRP auth, deletion)
│   ├── frontend/
│   │   ├── index.html        # Single-page app shell
│   │   ├── app.js            # WebSocket client + all screen renderers
│   │   └── style.css         # GitHub-dark theme, monospace, CSS variables
│   ├── database/             # ← GITIGNORED (runtime only)
│   │   ├── spam_toolkit.db   # SQLite database (persistent)
│   │   ├── attachments/      # Extracted email attachments
│   │   └── deleted/          # Attachment backups before server deletion
│   ├── Dockerfile
│   ├── docker-compose.yaml
│   ├── requirements.txt
│   └── migrate_add_accounts.sql  # Migration script for existing installs
│
└── data/                     # ← GITIGNORED (runtime only)
    └── {account_name}/       # Per-account .eml files
```

---

## Running the Portal

```bash
cd source/portal
sh setup.sh       # build + start
sh teardown.sh    # stop
```

- App at `http://localhost:8080`
- SQLite browser at `http://localhost:8081`
- Mounts `../data` → `/workspace/data`
- Mounts `./database` → `/workspace/database`
- Environment variables: `DATA_DIR`, `DB_DIR`, `DB_PATH`

---

## Architecture & Key Design Decisions

### Portal
- **Incremental scanning**: tracks `eml_path UNIQUE` in SQLite; only rescans new files
- **Account-based folders**: `.eml` files live in `data/{account_name}/`; account inferred from path prefix at scan time
- **WebSocket session model**: stateful `Session` object per client connection
- **Loading phase**: streams progress events to WebSocket during startup scan
- **CPU-bound scanning**: runs in `ThreadPoolExecutor` to avoid blocking async loop
- **WAL mode**: SQLite with WAL + foreign keys enabled
- **Path traversal protection**: `/download/{rel_path}` validates against `DB_DIR`
- **Protonmail deletion**: cookie-based session import (browser cookie), saved to SQLite, reused on subsequent runs
- **Attachment backup**: attachments extracted to `database/deleted/` before server deletion

---

## SQLite Schema (Portal)

```sql
accounts:
  id, name (UNIQUE), provider (protonmail|gmail),
  created_at, disabled_at (NULL = active)

senders:
  id, email (UNIQUE), unsubscribe_url, email_count,
  status (active|unsubscribed), status_updated_at, scanned_at,
  account_id (FK→accounts, nullable)

emails:
  id, sender_id (FK→senders), eml_path (UNIQUE), subject,
  date_str, preview, has_attachments, scanned_at,
  server_deleted_at, local_deleted_at

attachments:
  id, email_id (FK→emails), filename, content_type, size_bytes

proton_sessions:
  username (PK), uid, access_token, session_id, saved_at
```

---

## Key Bindings

### Senders screen
| Key | Action |
|-----|--------|
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
|-----|--------|
| `↑↓` | Navigate |
| `Space` | Select/unselect email |
| `A` | Select/deselect all |
| `O` | View attachments |
| `S` | Sender analytics |
| `D` | Delete selected on server |
| `B` | Back |

### Deleted Senders screen
| Key | Action |
|-----|--------|
| `↑↓` | Navigate |
| `Enter` | View deleted emails |
| `U` | Toggle unsubscribed |
| `B` | Back |

### Accounts screen
| Key | Action |
|-----|--------|
| `↑↓` | Navigate |
| `N` | New account |
| `D` | Toggle disable/enable |
| `B` | Back |

---

## Screens / Navigation Flow

```
[account_setup]  ← shown on first launch if no accounts exist
     ↓ create
[senders]
     ↓ Enter                    ↓ X                   ↓ C
  [emails]              [deleted_senders]          [accounts]
     ↓ Space+D               ↓ Enter                  ↓ N
  [import_session]       [deleted_emails]        [account_setup]
     ↓ paste cookie
  [delete_progress]
     ↓ O (attachments)
  [attachments]
     ↓ S
  [sender_analytics]
     ↓ A (from senders)
  [analytics]
```

---

## Frontend (Portal)

- Pure vanilla JS — no framework, no build step
- WebSocket sends JSON `{type, data}`; `app.js` dispatches to render functions
- Client-side filtering in: senders, emails, deleted emails, deleted senders
- Preview pane in: emails screen, deleted emails screen
- Render functions: `renderAccountSetup`, `renderAccounts`, `renderSenders`, `renderEmails`,
  `renderAttachments`, `renderAnalytics`, `renderSenderAnalytics`, `renderDeletedSenders`,
  `renderDeletedEmails`, `renderServerSelect`, `renderImportSession`, `renderDeleteProgress`,
  `renderHumanVerify`
- Theme: GitHub-dark palette via CSS custom properties (`--bg`, `--cyan`, `--green`, `--yellow`, etc.)

---

## Dependencies

### Portal
- `fastapi` — HTTP + WebSocket server
- `uvicorn[standard]` — ASGI server
- `httpx` — async HTTP client for Protonmail API
- `bcrypt` — SRP password hashing for Protonmail auth
- Python stdlib only for email parsing

---

## Data Flow

```
Host .eml files (data/{account_name}/)
    │
    └─→ [Portal] scans incrementally → SQLite (accounts/senders/emails/attachments)
                                      → database/attachments/ (extracted on view)
                                      → database/deleted/     (backup before deletion)
                                      → Protonmail API        (server-side deletion)
```

---

## What's Gitignored (source/.gitignore)

- `data/` — all `.eml` files (personal email content)
- `portal/database/` — SQLite DB, attachments, deleted backups (personal data)
- `__pycache__/`, `*.pyc`, `*.pyo` — Python bytecode
- `.DS_Store`, `Thumbs.db` — OS metadata
