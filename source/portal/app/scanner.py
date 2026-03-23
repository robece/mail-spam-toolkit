import email
import re
from dataclasses import dataclass, field as dc_field
from pathlib import Path
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser


@dataclass
class SenderRecord:
    sender:           str
    url:              str | None
    count:            int = 0
    account_name:     str | None = None
    account_provider: str | None = None


@dataclass
class EmailRecord:
    subject: str
    date_str: str
    preview: str
    has_attachments: bool = False
    attachments: list = dc_field(default_factory=list)  # [{filename, content_type, size_bytes}]
    eml_path: str = ""


@dataclass
class AppData:
    records: list[SenderRecord]        # sorted by email_count desc
    all_emails: dict[str, list[EmailRecord]]


# ── HTML → text ───────────────────────────────────────────────────────────────

class _HtmlToText(HTMLParser):
    BLOCK = {"p","div","br","li","h1","h2","h3","h4","h5","h6","tr","td","th","blockquote"}
    SKIP  = {"script","style","head"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP: self._skip_depth += 1
        if tag in self.BLOCK and not self._skip_depth: self._parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP: self._skip_depth = max(0, self._skip_depth - 1)
        if tag in self.BLOCK and not self._skip_depth: self._parts.append("\n")

    def handle_data(self, data):
        if not self._skip_depth: self._parts.append(data)

    def get_text(self) -> str:
        text = "".join(self._parts)
        text = text.replace("\r\n","\n").replace("\r","\n").replace("\xa0"," ")
        text = re.sub(r"[ \t]+"," ",text)
        text = re.sub(r" *\n *","\n",text)
        text = re.sub(r"\n{3,}","\n\n",text)
        return text.strip()


def _html_to_text(raw_html: str) -> str:
    cleaned = re.sub(r"<!--.*?-->","",raw_html,flags=re.DOTALL)
    p = _HtmlToText()
    try:
        p.feed(cleaned)
        return p.get_text()
    except Exception:
        return re.sub(r"<[^>]+"," ",raw_html)


# ── email parsing helpers ─────────────────────────────────────────────────────

def _decode_subject(raw: str) -> str:
    parts = email.header.decode_header(raw)
    result = ""
    for part, charset in parts:
        if isinstance(part, bytes):
            result += part.decode(charset or "utf-8", errors="replace")
        else:
            result += part
    return result.strip()


def _extract_preview(msg) -> str:
    try:
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    charset = part.get_content_charset() or "utf-8"
                    text = part.get_payload(decode=True).decode(charset, errors="replace")
                    return re.sub(r"\s+"," ",text).strip()[:2000]
            for part in msg.walk():
                if part.get_content_type() == "text/html":
                    charset = part.get_content_charset() or "utf-8"
                    return _html_to_text(part.get_payload(decode=True).decode(charset, errors="replace"))[:2000]
        else:
            payload = msg.get_payload(decode=True)
            if payload:
                charset = msg.get_content_charset() or "utf-8"
                text = payload.decode(charset, errors="replace")
                if msg.get_content_type() == "text/html":
                    return _html_to_text(text)[:2000]
                return re.sub(r"\s+"," ",text).strip()[:2000]
    except Exception:
        pass
    return ""


def _parse_sender(from_header: str) -> str:
    addresses = email.utils.getaddresses([from_header])
    return addresses[0][1].lower().strip() if addresses else from_header.lower().strip()


def _extract_url(header: str) -> str | None:
    m = re.findall(r"<(https?://[^>]+)>", header)
    return m[0] if m else None


def _get_attachments(msg) -> tuple[bool, list[dict]]:
    attachments = []
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_maintype() == "multipart":
                continue
            disposition = part.get_content_disposition()
            filename = part.get_filename()
            if disposition == "attachment" or (filename and disposition != "inline"):
                fname = filename or f"attachment.{part.get_content_subtype()}"
                payload = part.get_payload(decode=True) or b""
                attachments.append({
                    "filename": fname,
                    "content_type": part.get_content_type(),
                    "size_bytes": len(payload),
                })
    return bool(attachments), attachments


# ── main entry point ──────────────────────────────────────────────────────────

def _detect_account(path_str: str, data_dir: Path, account_names: set[str]) -> str | None:
    """Returns the account name if the path is inside data_dir/{account_name}/."""
    try:
        rel = Path(path_str).relative_to(data_dir)
        first = rel.parts[0] if len(rel.parts) > 1 else None
        if first and first in account_names:
            return first
    except ValueError:
        pass
    return None


def scan_or_load(data_dir: Path, progress_cb=None) -> AppData:
    """
    Checks the database for already-scanned files.
    Only scans new .eml files; loads everything else from SQLite.
    Reconciles DB by removing records for files manually deleted from disk.
    progress_cb(message: str, current: int, total: int)
    """
    from . import db

    # ── reconciliation: remove records for files no longer on disk ────────────
    active_paths = db.get_active_paths()
    missing = {p for p in active_paths if not Path(p).exists()}
    if missing:
        if progress_cb:
            progress_cb(f"Reconciling {len(missing)} removed file(s)…", 0, 1)
        for path in missing:
            db.hard_delete_email(path)

    all_paths = {str(p) for p in data_dir.rglob("*.eml")}
    total_all = len(all_paths)

    if not all_paths:
        if progress_cb:
            progress_cb("No .eml files found.", 1, 1)
        return AppData(records=[], all_emails={})

    account_names = {a["name"] for a in db.load_accounts()}

    known_paths = db.get_known_paths()
    new_paths = sorted(all_paths - known_paths)
    total_new = len(new_paths)

    if total_new:
        grand = total_new * 2
        if progress_cb:
            progress_cb(
                f"Found {total_all} emails ({total_new} new). Scanning…",
                0, grand,
            )
        scan_results = _collect_scan_data(new_paths, progress_cb, total_new, data_dir, account_names)
        if progress_cb:
            progress_cb("Saving to database…", total_new, grand)
        db.bulk_insert(scan_results)
        if progress_cb:
            progress_cb("Loading from database…", grand - 1, grand)
    else:
        if progress_cb:
            progress_cb(f"Found {total_all} emails. Loading from database…", 0, 1)

    app_data = _load_app_data()
    final = total_new * 2 if total_new else 1
    if progress_cb:
        progress_cb(f"Ready — {len(app_data.records)} senders loaded.", final, final)
    return app_data


def _collect_scan_data(new_paths: list[str], progress_cb, total: int,
                       data_dir: Path | None = None,
                       account_names: set[str] | None = None) -> list[dict]:
    """Single pass over new files. Returns data ready for db.bulk_insert()."""
    step = max(1, total // 40)
    grand = total * 2
    sender_map: dict[str, dict] = {}

    for i, path_str in enumerate(new_paths, 1):
        if (i % step == 0 or i == total) and progress_cb:
            progress_cb(f"Scanning new emails… {i}/{total}", i, grand)
        try:
            with open(path_str, "rb") as f:
                msg = email.message_from_bytes(f.read())
        except Exception:
            continue

        from_h = msg.get("From", "")
        if not from_h:
            continue
        sender_email = _parse_sender(from_h)
        if not sender_email:
            continue

        account_name = None
        if data_dir and account_names:
            account_name = _detect_account(path_str, data_dir, account_names)

        if sender_email not in sender_map:
            uh = msg.get("List-Unsubscribe", "")
            sender_map[sender_email] = {
                "sender_email":  sender_email,
                "sender_url":    _extract_url(uh) if uh else None,
                "account_name":  account_name,
                "emails": [],
            }
        elif sender_map[sender_email]["sender_url"] is None:
            uh = msg.get("List-Unsubscribe", "")
            if uh:
                sender_map[sender_email]["sender_url"] = _extract_url(uh)

        raw_subj = msg.get("Subject", "").strip()
        subject = _decode_subject(raw_subj) if raw_subj else "(no subject)"
        date_h = msg.get("Date", "")
        try:
            date_str = parsedate_to_datetime(date_h).strftime("%Y-%m-%d") if date_h else "N/A"
        except Exception:
            date_str = "N/A"

        has_att, attachments = _get_attachments(msg)
        sender_map[sender_email]["emails"].append({
            "eml_path": path_str,
            "subject": subject,
            "date_str": date_str,
            "preview": _extract_preview(msg),
            "has_attachments": has_att,
            "attachments": attachments,
        })

    return list(sender_map.values())


def _load_app_data() -> AppData:
    """Load complete AppData from SQLite (3 queries total)."""
    from . import db

    sender_rows        = db.load_senders()
    emails_by_sender   = db.load_all_emails()       # {sender_id: [email_dict]}
    atts_by_email      = db.load_all_attachments()  # {email_id:  [att_dict]}

    records: list[SenderRecord] = []
    all_emails: dict[str, list[EmailRecord]] = {}

    for s in sender_rows:
        records.append(SenderRecord(
            sender=s["email"],
            url=s["unsubscribe_url"],
            count=s["email_count"],
            account_name=s.get("account_name"),
            account_provider=s.get("account_provider"),
        ))
        email_rows = emails_by_sender.get(s["id"], [])
        all_emails[s["email"]] = [
            EmailRecord(
                subject=e["subject"],
                date_str=e["date_str"],
                preview=e["preview"],
                has_attachments=bool(e["has_attachments"]),
                attachments=atts_by_email.get(e["id"], []) if e["has_attachments"] else [],
                eml_path=e["eml_path"],
            )
            for e in email_rows
        ]

    return AppData(records=records, all_emails=all_emails)
