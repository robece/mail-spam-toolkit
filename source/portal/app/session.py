import email as email_lib
import os
import re
from pathlib import Path
from .scanner import AppData, EmailRecord
from . import db

MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]


class Session:
    def __init__(self, app_data: AppData, db_dir: Path, data_dir: Path | None = None, temp_dir: Path | None = None):
        self.data            = app_data
        self.db_dir          = db_dir
        self.data_dir        = data_dir
        self.temp_dir        = temp_dir or (db_dir / "temp")
        self.screen          = "senders"
        self.cursor          = 0
        self.email_cursor    = 0
        self.current_sender  = ""
        self.selection_state: dict[str, set[int]] = {}
        self.unsub_state: dict[str, str]          = db.load_statuses()
        self.status          = f"Loaded {len(app_data.records)} senders."
        self.attachment_info: list[dict]          = []
        self._open_url: str | None                = None
        self.analytics_year: int | None           = None

        # ── deleted emails view ────────────────────────────────────────────
        self.deleted_email_cursor: int            = 0
        self._deleted_emails_cache: list[dict]    = []
        self._sender_deleted_count: int           = 0
        self._deleted_emails_return: str          = "emails"

        # ── deleted senders view ───────────────────────────────────────────
        self.deleted_senders_cursor: int          = 0
        self._deleted_senders_cache: list[dict]   = []

        # ── account setup ──────────────────────────────────────────────────
        self._account_setup_step: str             = "provider"  # "provider" | "name"
        self._account_provider: str               = ""
        self._account_name_input: str             = ""
        self._account_error: str                  = ""
        self._account_setup_return: str           = "senders"
        self.pending_create_account: bool         = False

        # ── accounts management ────────────────────────────────────────────
        self._accounts_cursor: int                = 0
        self._accounts_cache: list[dict]          = []

        if not db.load_accounts():
            self.screen = "account_setup"

        # ── Protonmail deletion state ──────────────────────────────────────
        self._proton_user: str                    = os.environ.get("PROTONMAIL_USER", "")
        self._proton_password: str                = ""
        self._proton_client                       = None
        self._auth_error: str                     = ""
        self._emails_to_delete: list[str]         = []
        self._delete_total: int                   = 0
        self._delete_done: int                    = 0
        self._delete_errors: int                  = 0
        self._delete_complete: bool               = False
        self._delete_error_msg: str               = ""
        self.pending_delete: bool                 = False
        self.pending_email_send: bool             = False
        self.pending_import_session: bool         = False
        self._import_uid: str                     = ""
        self._import_error: str                   = ""
        self._human_verify_token: str             = ""
        self._human_verify_captcha: str           = ""
        self._hv_type: str                        = "captcha"
        self._hv_methods: list                    = []
        self._hv_web_url: str                     = ""
        self._hv_email_sent: bool                 = False
        self._hv_email_error: str                 = ""

    # ── key handling ──────────────────────────────────────────────────────────

    def handle_key(self, key: str) -> None:
        {
            "account_setup":         self._key_account_setup,
            "accounts":              self._key_accounts,
            "senders":               self._key_senders,
            "emails":                self._key_emails,
            "attachments":           self._key_attachments,
            "analytics":             self._key_analytics,
            "sender_analytics":      self._key_sender_analytics,
            "deleted_emails":        self._key_deleted_emails,
            "deleted_senders":       self._key_deleted_senders,
            "server_select":         self._key_server_select,
            "auth_prompt":           self._key_auth_prompt,
            "delete_progress":       self._key_delete_progress,
            "human_verify":          self._key_human_verify,
            "import_session":        self._key_import_session,
        }.get(self.screen, lambda k: None)(key)

    def handle_hv_result(self, token: str, hv_type: str) -> None:
        """Called when the CAPTCHA popup posts back a verified token."""
        if token:
            self._human_verify_captcha = token
            self._hv_type              = hv_type
            self._auth_error           = ""
            self._delete_done          = 0
            self._delete_errors        = 0
            self._delete_complete      = False
            self.screen                = "delete_progress"
            self.pending_delete        = True

    def handle_text_input(self, text: str) -> None:
        if self.screen == "account_setup" and self._account_setup_step == "name" and text:
            name = text.strip()
            if not re.match(r'^[a-zA-Z0-9][a-zA-Z0-9._@+-]*$', name):
                self._account_error = "Invalid name. Use letters, numbers, and . _ @ + - only. No spaces."
            else:
                self._account_name_input  = name
                self._account_error       = ""
                self.pending_create_account = True
            return
        if self.screen == "auth_prompt" and text:
            self._proton_password = text
            self.screen           = "delete_progress"
            self.pending_delete   = True
        elif self.screen == "import_session" and text:
            self._import_uid            = text
            self._import_error          = ""
            self.pending_import_session = True
        elif self.screen == "human_verify" and text:
            # Protonmail expects "{T2}:{code}" — the new HV token from the email-send
            # step combined with the 6-digit code the user received.
            self._human_verify_captcha = f"{self._human_verify_token}:{text}"
            self._auth_error           = ""
            self._delete_done          = 0
            self._delete_errors        = 0
            self._delete_complete      = False
            self.screen                = "delete_progress"
            self.pending_delete        = True

    def _key_account_setup(self, key: str) -> None:
        if self._account_setup_step == "provider":
            if key == "1":
                self._account_provider    = "protonmail"
                self._account_setup_step  = "name"
                self._account_error       = ""
            elif key.lower() in ("b", "escape") and self._account_setup_return == "accounts":
                self.screen = "accounts"
        elif self._account_setup_step == "name":
            if key == "Escape":
                self._account_setup_step = "provider"
                self._account_error      = ""

    def _key_accounts(self, key: str) -> None:
        n = len(self._accounts_cache)
        k = key.lower()
        if key == "ArrowUp":
            self._accounts_cursor = max(0, self._accounts_cursor - 1)
        elif key == "ArrowDown":
            self._accounts_cursor = min(max(0, n - 1), self._accounts_cursor + 1)
        elif k == "d" and self._accounts_cache:
            acc = self._accounts_cache[self._accounts_cursor]
            if acc["disabled_at"]:
                db.enable_account(acc["name"])
            else:
                db.disable_account(acc["name"])
            self._accounts_cache = db.load_accounts(include_disabled=True)
        elif k == "n":
            self._account_setup_step   = "provider"
            self._account_provider     = ""
            self._account_name_input   = ""
            self._account_error        = ""
            self._account_setup_return = "accounts"
            self.screen                = "account_setup"
        elif k in ("b", "escape", "q"):
            self._accounts_cursor = 0
            self.screen           = "senders"

    def _key_senders(self, key: str) -> None:
        records = self.data.records
        n = len(records)
        k = key.lower()

        if key == "ArrowUp":
            self.cursor = max(0, self.cursor - 1)
            self.status = ""
        elif key == "ArrowDown":
            self.cursor = min(n - 1, self.cursor + 1)
            self.status = ""
        elif key == "Enter":
            self.screen         = "emails"
            self.email_cursor   = 0
            self.current_sender = records[self.cursor].sender
            self.status         = ""
        elif k == "o":
            rec = records[self.cursor]
            if rec.url:
                self._open_url = rec.url
                self.status    = f"Opening: {rec.sender}"
            else:
                self.status    = f"No unsubscribe URL for {rec.sender}"
        elif k == "s":
            if records:
                self.current_sender  = records[self.cursor].sender
                self.analytics_year  = None
                self.screen          = "sender_analytics"
                self.status          = ""
        elif k == "a":
            self.screen = "analytics"
            self.status = ""
        elif k == "x":
            self._deleted_senders_cache = db.load_deleted_senders()
            self.deleted_senders_cursor = 0
            self.screen                 = "deleted_senders"
            self.status                 = ""
        elif k == "c":
            self._accounts_cache  = db.load_accounts(include_disabled=True)
            self._accounts_cursor = 0
            self.screen           = "accounts"
            self.status           = ""
        elif k in ("q", "escape"):
            self.status = "Press Ctrl+W or close the tab to exit."

    def _key_emails(self, key: str) -> None:
        sender   = self.current_sender
        emails   = self.data.all_emails.get(sender, [])
        n        = len(emails)
        selected = self.selection_state.get(sender, set())
        k        = key.lower()

        if key == "ArrowUp":
            self.email_cursor = max(0, self.email_cursor - 1)
        elif key == "ArrowDown":
            self.email_cursor = min(n - 1, self.email_cursor + 1)
        elif key == " ":
            if self.email_cursor in selected:
                selected.discard(self.email_cursor)
            else:
                selected.add(self.email_cursor)
            self.selection_state[sender] = selected
        elif k == "a":
            self.selection_state[sender] = set(range(n)) if len(selected) < n else set()
        elif k == "o":
            em = emails[self.email_cursor] if emails and 0 <= self.email_cursor < len(emails) else None
            if em and em.has_attachments:
                self.attachment_info = self._extract_attachments(em, self.email_cursor)
                self.screen          = "attachments"
        elif k == "s":
            self.analytics_year = None
            self.screen         = "sender_analytics"
        elif k == "d":
            sel = self.selection_state.get(sender, set())
            if not sel:
                self.status = "No emails selected. Use Space or A to select."
            else:
                rec = next((r for r in self.data.records if r.sender == sender), None)
                if rec and rec.account_name:
                    # Provider known from account — skip server_select
                    self._emails_to_delete   = [emails[i].eml_path for i in sorted(sel)]
                    self._delete_total       = len(self._emails_to_delete)
                    self._delete_done        = 0
                    self._delete_errors      = 0
                    self._delete_complete    = False
                    self._delete_error_msg   = ""
                    self._human_verify_token = ""
                    if self._proton_client is not None:
                        self.pending_delete = True
                        self.screen         = "delete_progress"
                    else:
                        self._import_uid   = ""
                        self._import_error = ""
                        self.screen        = "import_session"
                elif not self._proton_user:
                    self.status = "Set PROTONMAIL_USER env var to enable server deletion."
                else:
                    self.screen = "server_select"
                    self.status = ""
        elif k in ("b", "q", "escape"):
            self.screen = "senders"
            sel = len(self.selection_state.get(sender, set()))
            self.status = f"{sel} email(s) selected for {sender}"

    def _key_attachments(self, key: str) -> None:
        if key.lower() in ("b", "q", "escape") or key == "Enter":
            self.screen = "emails"

    def _key_analytics(self, key: str) -> None:
        if key.lower() in ("b", "q", "escape"):
            self.screen = "senders"
            self.status = "Back from analytics."

    def _key_sender_analytics(self, key: str) -> None:
        years = self._sender_years()
        if key == "ArrowLeft" and years and self.analytics_year in years:
            idx = years.index(self.analytics_year)
            self.analytics_year = years[min(len(years) - 1, idx + 1)]
        elif key == "ArrowRight" and years and self.analytics_year in years:
            idx = years.index(self.analytics_year)
            self.analytics_year = years[max(0, idx - 1)]
        elif key.lower() in ("b", "q", "escape"):
            self.screen = "emails"

    def _key_deleted_emails(self, key: str) -> None:
        n = len(self._deleted_emails_cache)
        if key == "ArrowUp":
            self.deleted_email_cursor = max(0, self.deleted_email_cursor - 1)
        elif key == "ArrowDown":
            self.deleted_email_cursor = min(max(0, n - 1), self.deleted_email_cursor + 1)
        elif key.lower() in ("b", "escape", "q"):
            self.screen               = self._deleted_emails_return
            self.deleted_email_cursor = 0

    def _key_deleted_senders(self, key: str) -> None:
        n = len(self._deleted_senders_cache)
        k = key.lower()
        if key == "ArrowUp":
            self.deleted_senders_cursor = max(0, self.deleted_senders_cursor - 1)
        elif key == "ArrowDown":
            self.deleted_senders_cursor = min(max(0, n - 1), self.deleted_senders_cursor + 1)
        elif key == "Enter" and self._deleted_senders_cache:
            sender = self._deleted_senders_cache[self.deleted_senders_cursor]["email"]
            self.current_sender         = sender
            self._deleted_emails_cache  = db.load_deleted_emails_for_sender(sender)
            self.deleted_email_cursor   = 0
            self._deleted_emails_return = "deleted_senders"
            self.screen                 = "deleted_emails"
        elif k == "u" and self._deleted_senders_cache:
            sender = self._deleted_senders_cache[self.deleted_senders_cursor]["email"]
            if self.unsub_state.get(sender) == "unsubscribed":
                db.update_status(sender, "active")
                self.unsub_state.pop(sender, None)
                self.status = f"Cleared: {sender}"
            else:
                db.update_status(sender, "unsubscribed")
                self.unsub_state[sender] = "unsubscribed"
                self.status = f"Marked unsubscribed: {sender}"
            self._deleted_senders_cache = db.load_deleted_senders()
        elif k in ("b", "escape", "q"):
            self.deleted_senders_cursor = 0
            self.screen                 = "senders"

    def _key_server_select(self, key: str) -> None:
        if key == "1":
            sender   = self.current_sender
            emails   = self.data.all_emails.get(sender, [])
            selected = self.selection_state.get(sender, set())
            self._emails_to_delete   = [emails[i].eml_path for i in sorted(selected)]
            self._delete_total       = len(self._emails_to_delete)
            self._delete_done        = 0
            self._delete_errors      = 0
            self._delete_complete    = False
            self._delete_error_msg   = ""
            self._human_verify_token = ""
            if self._proton_client is not None:
                self.pending_delete = True
                self.screen         = "delete_progress"
            else:
                self._import_uid   = ""
                self._import_error = ""
                self.screen        = "import_session"
        elif key.lower() in ("b", "escape", "q"):
            self.screen = "emails"

    def _key_auth_prompt(self, key: str) -> None:
        if key.lower() == "i":
            self._import_uid   = ""
            self._import_error = ""
            self.screen        = "import_session"
        elif key == "Escape" or key.lower() == "b":
            self._auth_error = ""
            self.screen      = "server_select"

    def _key_delete_progress(self, key: str) -> None:
        if self._delete_complete and key.lower() in ("b", "escape"):
            self.screen = "emails"

    def _key_import_session(self, key: str) -> None:
        if key.lower() in ("b", "escape", "q"):
            self._import_uid   = ""
            self._import_error = ""
            self.screen        = "server_select"


    def _key_human_verify(self, key: str) -> None:
        if key == "1" and "email" in self._hv_methods and not self._hv_email_sent:
            self._hv_email_error    = ""
            self._hv_type           = "email"
            self.pending_email_send = True
        elif key.lower() in ("b", "escape", "q"):
            self._human_verify_token = ""
            self._hv_email_sent      = False
            self._hv_email_error     = ""
            self.screen              = "server_select"

    # ── helpers ───────────────────────────────────────────────────────────────

    def _sender_years(self) -> list[int]:
        emails = self.data.all_emails.get(self.current_sender, [])
        years: set[int] = set()
        for em in emails:
            if em.date_str and em.date_str != "N/A":
                try:
                    years.add(int(em.date_str[:4]))
                except ValueError:
                    pass
        return sorted(years, reverse=True)

    def _extract_attachments(self, em: EmailRecord, idx: int) -> list[dict]:
        results = []
        try:
            with open(em.eml_path, "rb") as f:
                msg = email_lib.message_from_bytes(f.read())
            safe_sender = re.sub(r"[^\w\-.]", "_", self.current_sender)
            att_base    = self.temp_dir
            out_dir     = att_base / safe_sender / str(idx)
            out_dir.mkdir(parents=True, exist_ok=True)
            if msg.is_multipart():
                for part in msg.walk():
                    if part.get_content_maintype() == "multipart":
                        continue
                    disposition = part.get_content_disposition()
                    filename    = part.get_filename()
                    if disposition == "attachment" or (filename and disposition != "inline"):
                        fname   = filename or f"attachment.{part.get_content_subtype()}"
                        payload = part.get_payload(decode=True)
                        if payload:
                            out_path = out_dir / fname
                            out_path.write_bytes(payload)
                            rel = out_path.relative_to(att_base)
                            results.append({
                                "filename":     fname,
                                "content_type": part.get_content_type(),
                                "size_bytes":   len(payload),
                                "download_url": f"/download/{rel}",
                            })
        except Exception:
            pass
        return results

    # ── rendering ─────────────────────────────────────────────────────────────

    def render(self) -> dict:
        return {
            "account_setup":         self._render_account_setup,
            "accounts":              self._render_accounts,
            "senders":               self._render_senders,
            "emails":                self._render_emails,
            "attachments":           self._render_attachments,
            "analytics":             self._render_analytics,
            "sender_analytics":      self._render_sender_analytics,
            "deleted_emails":        self._render_deleted_emails,
            "deleted_senders":       self._render_deleted_senders,
            "server_select":         self._render_server_select,
            "auth_prompt":           self._render_auth_prompt,
            "delete_progress":       self._render_delete_progress,
            "human_verify":          self._render_human_verify,
            "import_session":        self._render_import_session,
        }.get(self.screen, self._render_senders)()

    def _render_accounts(self) -> dict:
        rows = [
            {
                "index":    i,
                "name":     a["name"],
                "provider": a["provider"],
                "disabled": a["disabled_at"] is not None,
                "is_cursor": i == self._accounts_cursor,
            }
            for i, a in enumerate(self._accounts_cache)
        ]
        return {"type": "accounts", "data": {
            "rows":   rows,
            "total":  len(rows),
            "cursor": self._accounts_cursor,
        }}

    def _render_account_setup(self) -> dict:
        return {"type": "account_setup", "data": {
            "step":     self._account_setup_step,
            "provider": self._account_provider,
            "error":    self._account_error,
        }}

    def _render_senders(self) -> dict:
        records      = self.data.records
        unsub_count  = sum(1 for s in self.unsub_state.values() if s == "unsubscribed")
        total_sel    = sum(len(v) for v in self.selection_state.values())
        total_emails = sum(r.count for r in records)

        rows = []
        for i, r in enumerate(records):
            rows.append({
                "index": i, "num": i + 1,
                "sender": r.sender,
                "can_unsubscribe": r.url is not None,
                "unsubscribed":    self.unsub_state.get(r.sender) == "unsubscribed",
                "email_count":     r.count,
                "is_cursor":       i == self.cursor,
            })

        open_url, self._open_url = self._open_url, None
        return {"type": "senders", "data": {
            "total": len(records), "total_emails": total_emails,
            "unsub_count": unsub_count,
            "total_selected": total_sel, "cursor": self.cursor,
            "status": self.status, "rows": rows,
            "open_url": open_url,
        }}

    def _render_emails(self) -> dict:
        sender   = self.current_sender
        emails   = self.data.all_emails.get(sender, [])
        selected = self.selection_state.get(sender, set())

        rows = [{"index": i, "subject": em.subject, "date": em.date_str,
                 "selected": i in selected, "is_cursor": i == self.email_cursor,
                 "has_attachments": em.has_attachments}
                for i, em in enumerate(emails)]

        preview = emails[self.email_cursor].preview if emails and 0 <= self.email_cursor < len(emails) else ""

        return {"type": "emails", "data": {
            "sender": sender, "total": len(emails),
            "selected_count":  len(selected),
            "cursor":          self.email_cursor,
            "status":          self.status,
            "rows": rows, "preview": preview,
        }}

    def _render_attachments(self) -> dict:
        sender = self.current_sender
        emails = self.data.all_emails.get(sender, [])
        em     = emails[self.email_cursor] if emails and 0 <= self.email_cursor < len(emails) else None
        return {"type": "attachments", "data": {
            "subject": em.subject if em else "",
            "sender":  sender,
            "attachments": self.attachment_info,
        }}

    def _render_analytics(self) -> dict:
        from collections import Counter
        records      = self.data.records
        total_emails = sum(r.count for r in records)
        unsub_count  = sum(1 for s in self.unsub_state.values() if s == "unsubscribed")

        top_senders = sorted(records, key=lambda r: r.count, reverse=True)[:15]
        max_count   = top_senders[0].count if top_senders else 1

        domain_counts: Counter = Counter()
        for r in records:
            domain = r.sender.split("@")[-1] if "@" in r.sender else r.sender
            domain_counts[domain] += r.count
        top_domains = domain_counts.most_common(15)
        max_domain  = top_domains[0][1] if top_domains else 1

        return {"type": "analytics", "data": {
            "total_senders": len(records),
            "total_emails":  total_emails,
            "unsubscribed":  unsub_count,
            "top_senders": [{"sender": r.sender, "count": r.count,
                             "pct": round(r.count / max_count * 100)}
                            for r in top_senders],
            "top_domains": [{"domain": d, "count": c,
                             "pct": round(c / max_domain * 100)}
                            for d, c in top_domains],
        }}

    def _render_sender_analytics(self) -> dict:
        sender = self.current_sender
        years  = self._sender_years()

        if not years:
            return {"type": "sender_analytics", "data": {
                "sender": sender, "years": [], "year": None,
                "months": [], "max_count": 0, "total_year": 0,
                "has_prev": False, "has_next": False,
            }}

        if self.analytics_year not in years:
            self.analytics_year = years[0]

        emails       = self.data.all_emails.get(sender, [])
        month_counts = [0] * 12
        for em in emails:
            if em.date_str and em.date_str != "N/A":
                try:
                    y = int(em.date_str[:4])
                    m = int(em.date_str[5:7])
                    if y == self.analytics_year and 1 <= m <= 12:
                        month_counts[m - 1] += 1
                except ValueError:
                    pass

        max_count = max(month_counts) or 1
        months    = [
            {"month": MONTHS[i], "count": month_counts[i],
             "pct": round(month_counts[i] / max_count * 100)}
            for i in range(12)
        ]

        year_idx = years.index(self.analytics_year)
        return {"type": "sender_analytics", "data": {
            "sender":     sender,
            "years":      years,
            "year":       self.analytics_year,
            "has_prev":   year_idx < len(years) - 1,
            "has_next":   year_idx > 0,
            "months":     months,
            "max_count":  max_count,
            "total_year": sum(month_counts),
        }}

    def _render_deleted_emails(self) -> dict:
        rows = [
            {
                "subject":    r["subject"],
                "date_str":   r["date_str"],
                "deleted_at": (r["local_deleted_at"] or "")[:10],
                "has_backup": bool(r["has_attachments"]),
                "is_cursor":  i == self.deleted_email_cursor,
            }
            for i, r in enumerate(self._deleted_emails_cache)
        ]
        preview = ""
        cache = self._deleted_emails_cache
        if cache and 0 <= self.deleted_email_cursor < len(cache):
            preview = cache[self.deleted_email_cursor].get("preview", "")
        return {"type": "deleted_emails", "data": {
            "sender":  self.current_sender,
            "rows":    rows,
            "total":   len(rows),
            "cursor":  self.deleted_email_cursor,
            "preview": preview,
        }}

    def _render_deleted_senders(self) -> dict:
        rows = [
            {
                "index":         i,
                "email":         r["email"],
                "deleted_count": r["deleted_count"],
                "unsubscribed":  r["status"] == "unsubscribed",
                "can_unsub":     r["unsubscribe_url"] is not None,
                "is_cursor":     i == self.deleted_senders_cursor,
            }
            for i, r in enumerate(self._deleted_senders_cache)
        ]
        return {"type": "deleted_senders", "data": {
            "rows":  rows,
            "total": len(rows),
            "cursor": self.deleted_senders_cursor,
        }}

    def _render_server_select(self) -> dict:
        sender   = self.current_sender
        selected = self.selection_state.get(sender, set())
        return {"type": "server_select", "data": {
            "count":  len(selected),
            "sender": sender,
        }}

    def _render_auth_prompt(self) -> dict:
        return {"type": "auth_prompt", "data": {
            "username": self._proton_user,
            "error":    self._auth_error,
            "count":    len(self._emails_to_delete),
        }}

    def _render_delete_progress(self) -> dict:
        return {"type": "delete_progress", "data": {
            "total":    self._delete_total,
            "done":     self._delete_done,
            "errors":   self._delete_errors,
            "complete": self._delete_complete,
            "error":    self._delete_error_msg,
            "sender":   self.current_sender,
        }}

    def _render_import_session(self) -> dict:
        return {"type": "import_session", "data": {
            "error": self._import_error,
        }}

    def _render_human_verify(self) -> dict:
        return {"type": "human_verify", "data": {
            "sender":      self.current_sender,
            "count":       len(self._emails_to_delete),
            "methods":     self._hv_methods,
            "web_url":     self._hv_web_url,
            "email_sent":  self._hv_email_sent,
            "email_error": self._hv_email_error,
        }}
