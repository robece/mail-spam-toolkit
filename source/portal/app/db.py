import sqlite3
from datetime import datetime, timezone
from pathlib import Path

_db_path: Path | None = None


# ── init ──────────────────────────────────────────────────────────────────────

def init(db_path: Path) -> None:
    global _db_path
    _db_path = db_path
    db_dir = db_path.parent
    db_dir.mkdir(parents=True, exist_ok=True)
    with _conn() as conn:
        _create_schema(conn)
        _migrate_schema(conn)


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS accounts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT UNIQUE NOT NULL,
            provider    TEXT NOT NULL DEFAULT 'protonmail',
            created_at  TEXT NOT NULL,
            disabled_at TEXT DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS senders (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            email             TEXT UNIQUE NOT NULL,
            unsubscribe_url   TEXT,
            email_count       INTEGER NOT NULL DEFAULT 0,
            status            TEXT NOT NULL DEFAULT 'active',
            status_updated_at TEXT,
            scanned_at        TEXT NOT NULL,
            account_id        INTEGER REFERENCES accounts(id)
        );

        CREATE TABLE IF NOT EXISTS emails (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id          INTEGER NOT NULL REFERENCES senders(id),
            eml_path           TEXT UNIQUE NOT NULL,
            subject            TEXT NOT NULL DEFAULT '',
            date_str           TEXT NOT NULL DEFAULT '',
            preview            TEXT NOT NULL DEFAULT '',
            has_attachments    INTEGER NOT NULL DEFAULT 0,
            scanned_at         TEXT NOT NULL,
            server_deleted_at  TEXT DEFAULT NULL,
            local_deleted_at   TEXT DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS attachments (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            email_id     INTEGER NOT NULL REFERENCES emails(id),
            filename     TEXT NOT NULL,
            content_type TEXT NOT NULL DEFAULT '',
            size_bytes   INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_emails_sender   ON emails(sender_id);
        CREATE INDEX IF NOT EXISTS idx_atts_email      ON attachments(email_id);
        CREATE INDEX IF NOT EXISTS idx_emails_eml_path ON emails(eml_path);

        CREATE TABLE IF NOT EXISTS proton_sessions (
            username     TEXT PRIMARY KEY,
            uid          TEXT NOT NULL,
            access_token TEXT NOT NULL,
            session_id   TEXT NOT NULL DEFAULT '',
            saved_at     TEXT NOT NULL
        );
    """)


def _migrate_schema(conn: sqlite3.Connection) -> None:
    """Add new columns to existing tables if they don't exist (safe migration)."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(emails)").fetchall()}
    if "server_deleted_at" not in cols:
        conn.execute("ALTER TABLE emails ADD COLUMN server_deleted_at TEXT DEFAULT NULL")
    if "local_deleted_at" not in cols:
        conn.execute("ALTER TABLE emails ADD COLUMN local_deleted_at TEXT DEFAULT NULL")

    ps_cols = {row[1] for row in conn.execute("PRAGMA table_info(proton_sessions)").fetchall()}
    if "session_id" not in ps_cols:
        conn.execute("ALTER TABLE proton_sessions ADD COLUMN session_id TEXT NOT NULL DEFAULT ''")

    s_cols = {row[1] for row in conn.execute("PRAGMA table_info(senders)").fetchall()}
    if "account_id" not in s_cols:
        conn.execute("ALTER TABLE senders ADD COLUMN account_id INTEGER REFERENCES accounts(id)")

    a_cols = {row[1] for row in conn.execute("PRAGMA table_info(accounts)").fetchall()}
    if "disabled_at" not in a_cols:
        conn.execute("ALTER TABLE accounts ADD COLUMN disabled_at TEXT DEFAULT NULL")


# ── write ─────────────────────────────────────────────────────────────────────

def bulk_insert(scan_results: list[dict]) -> None:
    """
    scan_results: list of {
        sender_email:  str,
        sender_url:    str | None,
        account_name:  str | None,   # optional: name of the account folder
        emails: list of {
            eml_path: str, subject: str, date_str: str, preview: str,
            has_attachments: bool,
            attachments: [{filename, content_type, size_bytes}]
        }
    }
    All inserts happen in a single transaction for performance.
    """
    now = _now()
    with _conn() as conn:
        for sd in scan_results:
            account_id = None
            if sd.get("account_name"):
                row = conn.execute(
                    "SELECT id FROM accounts WHERE name = ?", (sd["account_name"],)
                ).fetchone()
                if row:
                    account_id = row["id"]

            conn.execute("""
                INSERT INTO senders (email, unsubscribe_url, email_count, scanned_at, account_id)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET
                    unsubscribe_url = COALESCE(unsubscribe_url, excluded.unsubscribe_url),
                    account_id      = COALESCE(senders.account_id, excluded.account_id)
            """, (sd["sender_email"], sd["sender_url"], len(sd["emails"]), now, account_id))

            sender_id = conn.execute(
                "SELECT id FROM senders WHERE email = ?", (sd["sender_email"],)
            ).fetchone()["id"]

            for em in sd["emails"]:
                conn.execute("""
                    INSERT OR IGNORE INTO emails
                        (sender_id, eml_path, subject, date_str, preview,
                         has_attachments, scanned_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (sender_id, em["eml_path"], em["subject"], em["date_str"],
                      em["preview"], 1 if em["has_attachments"] else 0, now))

                if em["has_attachments"] and em["attachments"]:
                    email_row = conn.execute(
                        "SELECT id FROM emails WHERE eml_path = ?", (em["eml_path"],)
                    ).fetchone()
                    if email_row:
                        conn.executemany("""
                            INSERT INTO attachments
                                (email_id, filename, content_type, size_bytes)
                            VALUES (?, ?, ?, ?)
                        """, [(email_row["id"], a["filename"],
                               a["content_type"], a["size_bytes"])
                              for a in em["attachments"]])


def update_status(sender_email: str, status: str) -> None:
    with _conn() as conn:
        conn.execute("""
            UPDATE senders SET status = ?, status_updated_at = ? WHERE email = ?
        """, (status, _now(), sender_email))


def mark_email_server_deleted(eml_path: str) -> None:
    with _conn() as conn:
        conn.execute(
            "UPDATE emails SET server_deleted_at = ? WHERE eml_path = ?",
            (_now(), eml_path),
        )


def mark_email_local_deleted(eml_path: str) -> None:
    with _conn() as conn:
        conn.execute(
            "UPDATE emails SET local_deleted_at = ? WHERE eml_path = ?",
            (_now(), eml_path),
        )


def hard_delete_email(eml_path: str) -> None:
    """Permanently remove email record (for files manually deleted from disk)."""
    with _conn() as conn:
        conn.execute("DELETE FROM emails WHERE eml_path = ?", (eml_path,))


# ── read ──────────────────────────────────────────────────────────────────────

def get_known_paths() -> set[str]:
    """All tracked eml_paths (active + soft-deleted)."""
    with _conn() as conn:
        rows = conn.execute("SELECT eml_path FROM emails").fetchall()
    return {r["eml_path"] for r in rows}


def get_active_paths() -> set[str]:
    """Only paths that have not been locally deleted."""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT eml_path FROM emails WHERE local_deleted_at IS NULL"
        ).fetchall()
    return {r["eml_path"] for r in rows}


def load_senders() -> list[dict]:
    """Returns senders that have at least one active (non-deleted) email."""
    with _conn() as conn:
        rows = conn.execute("""
            SELECT s.id, s.email, s.unsubscribe_url, s.status,
                   COUNT(e.id) AS email_count,
                   a.name     AS account_name,
                   a.provider AS account_provider
            FROM senders s
            JOIN emails e ON e.sender_id = s.id AND e.local_deleted_at IS NULL
            LEFT JOIN accounts a ON a.id = s.account_id
            GROUP BY s.id
            ORDER BY email_count DESC
        """).fetchall()
    return [dict(r) for r in rows]


def load_deleted_senders() -> list[dict]:
    """Returns senders that have at least one locally deleted email."""
    with _conn() as conn:
        rows = conn.execute("""
            SELECT s.id, s.email, s.unsubscribe_url, s.status,
                   COUNT(e.id) AS deleted_count
            FROM senders s
            INNER JOIN emails e ON e.sender_id = s.id AND e.local_deleted_at IS NOT NULL
            GROUP BY s.id
            ORDER BY deleted_count DESC
        """).fetchall()
    return [dict(r) for r in rows]


def load_all_emails() -> dict[int, list[dict]]:
    """Returns {sender_id: [email_dict, ...]} for active emails only, sorted by date DESC."""
    with _conn() as conn:
        rows = conn.execute("""
            SELECT id, sender_id, eml_path, subject, date_str, preview, has_attachments
            FROM emails
            WHERE local_deleted_at IS NULL
            ORDER BY sender_id, date_str DESC
        """).fetchall()
    result: dict[int, list] = {}
    for r in rows:
        sid = r["sender_id"]
        if sid not in result:
            result[sid] = []
        result[sid].append(dict(r))
    return result


def load_deleted_emails_for_sender(sender_email: str) -> list[dict]:
    """Returns soft-deleted emails for a sender, most recently deleted first."""
    with _conn() as conn:
        rows = conn.execute("""
            SELECT e.subject, e.date_str, e.local_deleted_at, e.has_attachments, e.preview
            FROM emails e
            JOIN senders s ON s.id = e.sender_id
            WHERE s.email = ? AND e.local_deleted_at IS NOT NULL
            ORDER BY e.local_deleted_at DESC
        """, (sender_email,)).fetchall()
    return [dict(r) for r in rows]


def count_deleted_emails_for_sender(sender_email: str) -> int:
    with _conn() as conn:
        row = conn.execute("""
            SELECT COUNT(*) AS cnt FROM emails e
            JOIN senders s ON s.id = e.sender_id
            WHERE s.email = ? AND e.local_deleted_at IS NOT NULL
        """, (sender_email,)).fetchone()
    return row["cnt"] if row else 0


def load_all_attachments() -> dict[int, list[dict]]:
    """Returns {email_id: [att_dict, ...]}."""
    with _conn() as conn:
        rows = conn.execute("""
            SELECT email_id, filename, content_type, size_bytes
            FROM attachments
        """).fetchall()
    result: dict[int, list] = {}
    for r in rows:
        eid = r["email_id"]
        if eid not in result:
            result[eid] = []
        result[eid].append(dict(r))
    return result


def load_statuses() -> dict[str, str]:
    """Returns {email: 'unsubscribed'} for all non-active senders."""
    with _conn() as conn:
        rows = conn.execute("""
            SELECT email, status FROM senders WHERE status != 'active'
        """).fetchall()
    return {r["email"]: r["status"] for r in rows}


# ── accounts ──────────────────────────────────────────────────────────────────

def load_accounts(include_disabled: bool = False) -> list[dict]:
    with _conn() as conn:
        if include_disabled:
            rows = conn.execute(
                "SELECT id, name, provider, created_at, disabled_at FROM accounts ORDER BY created_at"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, name, provider, created_at, disabled_at FROM accounts WHERE disabled_at IS NULL ORDER BY created_at"
            ).fetchall()
    return [dict(r) for r in rows]


def create_account(name: str, provider: str) -> None:
    with _conn() as conn:
        conn.execute(
            "INSERT INTO accounts (name, provider, created_at) VALUES (?, ?, ?)",
            (name, provider, _now()),
        )


def disable_account(name: str) -> None:
    with _conn() as conn:
        conn.execute(
            "UPDATE accounts SET disabled_at = ? WHERE name = ?", (_now(), name)
        )


def enable_account(name: str) -> None:
    with _conn() as conn:
        conn.execute(
            "UPDATE accounts SET disabled_at = NULL WHERE name = ?", (name,)
        )


# ── proton sessions ───────────────────────────────────────────────────────────

def save_proton_session(username: str, uid: str, access_token: str, session_id: str = "") -> None:
    with _conn() as conn:
        conn.execute("""
            INSERT INTO proton_sessions (username, uid, access_token, session_id, saved_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
                uid          = excluded.uid,
                access_token = excluded.access_token,
                session_id   = excluded.session_id,
                saved_at     = excluded.saved_at
        """, (username, uid, access_token, session_id, _now()))


def load_proton_session(username: str) -> tuple[str, str, str] | None:
    """Returns (uid, access_token, session_id) or None if no saved session exists."""
    with _conn() as conn:
        row = conn.execute(
            "SELECT uid, access_token, session_id FROM proton_sessions WHERE username = ?",
            (username,),
        ).fetchone()
    if row is None:
        return None
    return (row["uid"], row["access_token"], row["session_id"])


def clear_proton_session(username: str) -> None:
    with _conn() as conn:
        conn.execute(
            "DELETE FROM proton_sessions WHERE username = ?", (username,)
        )
