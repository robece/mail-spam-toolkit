# mail-spam-toolkit

Multi-user web app for bulk analysis and deletion of spam/newsletter emails.

**Privacy model:** email data never leaves the browser. The server handles only user authentication and acts as a stateless Protonmail API proxy. Each user's email index is stored in their own browser's IndexedDB.

## Architecture

```
Browser
├── File System Access API  — reads .eml / .metadata.json locally
├── EML parser (JS)         — extracts sender, subject, date, Protonmail ID
├── IndexedDB               — persists parsed data per user, keyed by user ID
└── Protonmail delete flow  — user pastes session cookie, client calls proxy

Server (FastAPI)
├── POST /auth/register     — creates user (email + bcrypt password)
├── POST /auth/login        — returns JWT
├── GET  /auth/me           — validates token
├── POST /proton/verify-session — validates a pasted Protonmail cookie (stateless)
├── POST /proton/delete     — proxies deletion to Protonmail API (stateless)
└── POST /proton/find-id    — resolves RFC Message-ID to Protonmail internal ID
```

The server stores **only** the `users` table (id, email, hashed password). No email content, senders, or subjects are ever stored server-side.

## Services

| Service | Port | Description |
|---|---|---|
| `mail-spam-toolkit-portal` | 8080 | Portal web app (FastAPI + static SPA) |
| `mail-spam-toolkit-sqlite` | 8081 | SQLite Web — database browser (dev only) |

## Setup

### Prerequisites
- Docker Desktop (Windows/Mac) or Docker Engine + Compose (Linux)
- WSL or Git Bash (Windows)

### Quick start

```bash
# Optional but recommended: set a real secret before starting
export JWT_SECRET=$(openssl rand -hex 32)

bash deploy/setup.sh
```

Open **http://localhost:8080**, register an account, then import your email export directory.

### Windows firewall

```powershell
# Run as Administrator to open ports 8080 and 8081
.\deploy\firewall-config.ps1

# Remove rules
.\deploy\firewall-config.ps1 -Remove
```

### Teardown

```bash
bash deploy/teardown.sh
```

## Importing emails

### Protonmail Export

1. In Protonmail web: Settings → Export → Export all messages
2. Extract the ZIP — you'll get a folder with `.eml` + `.metadata.json` pairs
3. In the app: **Import** → **Choose Folder** → select the exported folder
4. The app reads all files locally and indexes them in your browser

The `.metadata.json` files contain the Protonmail internal message ID, which is required for server-side deletion.

### Other providers (.eml only)

Select the folder containing `.eml` files. The app parses headers client-side. Server-side deletion is not available without Protonmail metadata, but you can still browse and analyze senders.

## Deleting emails from Protonmail

1. Select a sender → choose emails → click **Delete selected**
2. Open Protonmail in another tab → F12 → Network → click any request → copy the **Cookie** header value
3. Paste it into the session field and click **Verify**
4. Confirm deletion — messages are permanently removed from the server
5. The session credentials are used once and discarded (never stored)

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | `change-this-secret-in-production` | Secret key for JWT signing — **must be set in production** |
| `DB_PATH` | `/workspace/database/spam_toolkit.db` | Path to the SQLite database inside the container |

## Repository structure

```
mail-spam-toolkit/
├── docker-compose.yml
├── deploy/
│   ├── setup.sh
│   ├── teardown.sh
│   └── firewall-config.ps1
└── source/
    └── portal/
        ├── Dockerfile
        ├── requirements.txt
        ├── app/
        │   ├── auth.py         JWT utilities
        │   ├── db.py           SQLite (users table only)
        │   ├── main.py         FastAPI app (auth + Protonmail proxy)
        │   └── protonmail.py   Cookie-string parser helper
        └── frontend/
            ├── index.html      SPA shell
            ├── app.js          Full client-side app (EML parser, IndexedDB, screens)
            └── style.css       GitHub-dark theme
```
