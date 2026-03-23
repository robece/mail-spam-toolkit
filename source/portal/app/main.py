import asyncio
import email as email_lib
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response

from . import db
from .scanner import scan_or_load, AppData
from .session import Session

DATA_DIR     = Path(os.environ.get("DATA_DIR", "/workspace/data"))
DB_DIR       = Path(os.environ.get("DB_DIR",   "/workspace/database"))
DB_PATH      = Path(os.environ.get("DB_PATH",  "/workspace/database/spam_toolkit.db"))
FRONTEND_DIR = Path("/workspace/frontend")

# ── shared loading state ──────────────────────────────────────────────────────

app_data: AppData | None = None
_loading_progress: list[dict] = []
_subscribers: list[asyncio.Queue] = []
_loop: asyncio.AbstractEventLoop | None = None


def _enqueue_and_broadcast(item: dict) -> None:
    _loading_progress.append(item)
    for q in _subscribers:
        q.put_nowait(item)


def _progress_cb(message: str, current: int, total: int) -> None:
    done = current >= total and total > 0
    item = {"type": "loading", "data": {
        "message": message, "current": current, "total": total, "done": done,
    }}
    if _loop:
        _loop.call_soon_threadsafe(_enqueue_and_broadcast, item)


async def _load_data() -> None:
    global app_data
    loop     = asyncio.get_event_loop()
    app_data = await loop.run_in_executor(
        None, lambda: scan_or_load(DATA_DIR, _progress_cb)
    )


# ── attachment backup ─────────────────────────────────────────────────────────

def _backup_attachments(db_dir: Path, eml_path: str, sender: str) -> None:
    """Extract and save attachments from a .eml file before deletion."""
    import random, string

    def _uid() -> str:
        return "".join(random.choices(string.ascii_uppercase, k=4))

    def _clean(name: str) -> str:
        return re.sub(r"[^\w.\-]", "", name.replace(" ", ""))

    try:
        with open(eml_path, "rb") as f:
            msg = email_lib.message_from_bytes(f.read())
        if not msg.is_multipart():
            return
        out_dir = db_dir / "deleted" / sender
        saved   = False
        for part in msg.walk():
            if part.get_content_maintype() == "multipart":
                continue
            disposition = part.get_content_disposition()
            filename    = part.get_filename()
            if disposition == "attachment" or (filename and disposition != "inline"):
                raw     = filename or f"attachment.{part.get_content_subtype()}"
                fname   = f"{_uid()}_{_clean(raw)}" or f"{_uid()}_attachment"
                payload = part.get_payload(decode=True)
                if payload:
                    if not saved:
                        out_dir.mkdir(parents=True, exist_ok=True)
                        saved = True
                    (out_dir / fname).write_bytes(payload)
    except Exception:
        pass


# ── cookie parser ─────────────────────────────────────────────────────────────

def _parse_proton_cookies(cookie_str: str):
    """Returns (uid, auth_cookie, session_id) or None."""
    cookies = {}
    for part in cookie_str.split(';'):
        part = part.strip()
        if '=' in part:
            k, v = part.split('=', 1)
            cookies[k.strip()] = v.strip()
    uid = auth_val = None
    for k, v in cookies.items():
        if k.startswith('AUTH-'):
            uid = k[5:]
            auth_val = v
            break
    if not uid or not auth_val:
        return None
    return uid, auth_val, cookies.get('Session-Id', '')


# ── session import worker ─────────────────────────────────────────────────────

async def _import_session_worker(session: Session, safe_send) -> None:
    """Parse browser cookie string and save session to SQLite if valid."""
    from .protonmail import ProtonClient

    cookie_str = session._import_uid  # holds the raw cookie string

    parsed = _parse_proton_cookies(cookie_str)
    if not parsed:
        session._import_error = "Could not find AUTH-<uid> cookie in the pasted string. Make sure to copy the full Cookie header value."
        session.screen        = "import_session"
        await safe_send(session.render())
        return

    uid, auth_val, session_id = parsed

    client = ProtonClient()
    client.set_cookie_session(uid, auth_val, session_id)
    try:
        test = await client._client().get(
            "/mail/v4/messages", params={"Limit": 1},
            headers=client._auth_headers(),
        )
        if test.status_code != 200:
            session._import_error = f"Session rejected by Protonmail (HTTP {test.status_code})"
            session.screen        = "import_session"
            await safe_send(session.render())
            return
    except Exception as exc:
        session._import_error = str(exc)
        session.screen        = "import_session"
        await safe_send(session.render())
        return

    # Valid — save and proceed to deletion
    db.save_proton_session(session._proton_user, uid, auth_val, session_id)
    session._proton_client = client
    session._auth_error    = ""
    session._import_uid    = ""
    session._import_error  = ""
    session._delete_done     = 0
    session._delete_errors   = 0
    session._delete_complete = False
    session.screen           = "delete_progress"
    print(f"[proton] imported cookie session saved for {session._proton_user}", flush=True)
    await safe_send(session.render())
    asyncio.create_task(_deletion_worker(session, safe_send))


# ── email verification send worker ────────────────────────────────────────────

async def _email_send_worker(session: Session, safe_send) -> None:
    """Call authenticate() with hv_type=email to trigger Protonmail to send the code."""
    from .protonmail import ProtonClient, HumanVerificationRequired

    if "email" not in session._hv_methods:
        session._hv_email_error = "Email verification is not available. Please use CAPTCHA."
        await safe_send(session.render())
        return

    try:
        client = ProtonClient()
        await client.authenticate(
            session._proton_user,
            session._proton_password,
            session._human_verify_token,
            "email",
        )
        await client.close()
        # Unexpected success — go straight to deletion
        session._proton_client = client
        session._hv_email_sent = True
        session.pending_delete = True
    except HumanVerificationRequired as exc:
        # Expected: Protonmail sent the email and returned a new token
        session._human_verify_token = exc.token
        session._hv_methods         = exc.methods
        session._hv_web_url         = exc.web_url
        session._hv_email_sent      = True
        session._hv_email_error     = ""
    except Exception as exc:
        session._hv_email_error = str(exc)

    await safe_send(session.render())


# ── deletion worker ───────────────────────────────────────────────────────────

async def _deletion_worker(session: Session, safe_send) -> None:
    from .protonmail import ProtonClient, HumanVerificationRequired, read_message_id

    try:
        # Try to reuse a saved Proton session before doing full re-auth
        if session._proton_client is None:
            saved = db.load_proton_session(session._proton_user)
            if saved:
                uid, stored_token, stored_session_id = saved
                candidate = ProtonClient()
                if stored_session_id:
                    # Cookie-based session
                    candidate.set_cookie_session(uid, stored_token, stored_session_id)
                else:
                    # Bearer token session
                    candidate.set_session(uid, stored_token)
                try:
                    test = await candidate._client().get(
                        "/mail/v4/messages", params={"Limit": 1},
                        headers=candidate._auth_headers(),
                    )
                    if test.status_code == 200:
                        session._proton_client = candidate
                        session._proton_password = ""
                        print("[proton] reused saved session", flush=True)
                except Exception:
                    pass
                if session._proton_client is None:
                    db.clear_proton_session(session._proton_user)

        # No cached client and no valid saved session — ask user to import
        if session._proton_client is None:
            session._import_uid   = ""
            session._import_error = ""
            session.screen        = "import_session"
            await safe_send(session.render())
            return
        client = session._proton_client
        sender = session.current_sender

        for idx, eml_path in enumerate(session._emails_to_delete):
            # 1. Backup attachments before any destructive action
            _backup_attachments(DB_DIR, eml_path, sender)

            # 2. Delete from Protonmail server
            ok = False
            msg_id = read_message_id(eml_path)
            if msg_id:
                try:
                    internal_id = await client.find_id(msg_id)
                    if internal_id:
                        await client.delete_permanently([internal_id])
                        ok = True
                except Exception:
                    pass

            # 3. Mark server deleted in DB
            db.mark_email_server_deleted(eml_path)

            # 4. Delete local .eml file
            try:
                Path(eml_path).unlink(missing_ok=True)
            except Exception:
                pass

            # 5. Mark locally deleted in DB
            db.mark_email_local_deleted(eml_path)

            # 6. Remove from in-memory AppData
            if app_data:
                emails = app_data.all_emails.get(sender, [])
                app_data.all_emails[sender] = [e for e in emails if e.eml_path != eml_path]
                for r in app_data.records:
                    if r.sender == sender:
                        r.count = len(app_data.all_emails[sender])
                        break

            if ok:
                session._delete_done   += 1
            else:
                session._delete_errors += 1

            await safe_send(session.render())

        # 7. Post-deletion cleanup
        session._delete_complete = True
        session.selection_state.pop(sender, None)
        session._sender_deleted_count = db.count_deleted_emails_for_sender(sender)

        if app_data:
            # Remove sender from records if no active emails remain
            app_data.records = [r for r in app_data.records if r.count > 0]

        remaining = len(app_data.all_emails.get(sender, [])) if app_data else 0
        if remaining == 0:
            session.screen = "senders"
            session.status = f"All emails deleted for {sender}"
        else:
            session.email_cursor = min(session.email_cursor, remaining - 1)
            session.email_cursor = max(0, session.email_cursor)

        await safe_send(session.render())

    except Exception as exc:
        session._proton_password  = ""
        session._delete_error_msg = str(exc)
        session._delete_complete  = True
        await safe_send(session.render())


# ── FastAPI app ───────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _loop
    _loop = asyncio.get_event_loop()
    db.init(DB_PATH)
    (DB_DIR / "attachments").mkdir(parents=True, exist_ok=True)
    (DB_DIR / "deleted").mkdir(parents=True, exist_ok=True)
    _enqueue_and_broadcast({"type": "loading", "data": {
        "message": "Initializing…", "current": 0, "total": 1, "done": False,
    }})
    asyncio.create_task(_load_data())
    yield


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

# ── shared httpx client for captcha proxy ─────────────────────────────────────

_proxy_client: httpx.AsyncClient | None = None


def _get_proxy_client() -> httpx.AsyncClient:
    global _proxy_client
    if _proxy_client is None:
        _proxy_client = httpx.AsyncClient(follow_redirects=True, timeout=30.0)
    return _proxy_client


_CAPTCHA_ORIGIN    = "https://verify.proton.me"
_CAPTCHA_PREFIX    = "/captcha-proxy"
_STRIP_REQ_HEADERS = {"host", "transfer-encoding", "content-length"}
_STRIP_RES_HEADERS = {
    "x-frame-options", "content-security-policy",
    "x-content-type-options", "strict-transport-security",
    "transfer-encoding", "content-encoding", "content-length",
}

_HV_JS_INJECT = """\
<script>
(function(){
  var PREFIX='/captcha-proxy',ORIGIN='https://verify.proton.me';
  var LOC=window.location.origin;
  function rw(u){
    if(typeof u!=='string')return u;
    if(u.startsWith(ORIGIN))return PREFIX+u.slice(ORIGIN.length);
    if(u.startsWith(LOC+'/') && !u.startsWith(LOC+PREFIX))return LOC+PREFIX+u.slice(LOC.length);
    if(u.startsWith('/')&&!u.startsWith(PREFIX))return PREFIX+u;
    return u;
  }
  // Patch fetch
  var _f=window.fetch;
  window.fetch=function(r,i){
    if(typeof r==='string')r=rw(r);
    else if(r&&r.url)r=new Request(rw(r.url),r);
    return _f.call(this,r,i);
  };
  // Patch XHR
  var _o=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    return _o.apply(this,[m,rw(u)].concat(Array.prototype.slice.call(arguments,2)));
  };
  // Patch DOM insertions — catches webpack dynamic chunk loading via appendChild/insertBefore
  function patchEl(el){
    if(!el||!el.tagName)return el;
    var t=el.tagName.toLowerCase();
    try{ if((t==='script'||t==='img'||t==='iframe')&&el.src)el.src=rw(el.src); }catch(e){}
    try{ if(t==='link'&&el.href)el.href=rw(el.href); }catch(e){}
    return el;
  }
  var _ac=Node.prototype.appendChild;
  Node.prototype.appendChild=function(n){return _ac.call(this,patchEl(n));};
  var _ib=Node.prototype.insertBefore;
  Node.prototype.insertBefore=function(n,r){return _ib.call(this,patchEl(n),r);};
  // Patch setAttribute so webpack public path assignments are caught
  var _sa=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(k,v){
    if((k==='src'||k==='href')&&typeof v==='string')v=rw(v);
    return _sa.call(this,k,v);
  };
  // Patch postMessage to parent so any targetOrigin is accepted
  try{
    var _pm=window.parent.postMessage.bind(window.parent);
    window.parent.postMessage=function(d,o,t){_pm(d,'*',t);};
  }catch(e){}
})();
</script>"""


async def _captcha_proxy_handler(request: Request, path: str = "") -> Response:
    url = f"{_CAPTCHA_ORIGIN}/{path}"
    if request.url.query:
        url = f"{url}?{request.url.query}"

    # Forward cookies from the browser, spoofing origin/referer to look like verify.proton.me
    _STRIP_REQ = _STRIP_REQ_HEADERS | {"origin", "referer"}
    fwd_headers: dict[str, str] = {}
    for k, v in request.headers.items():
        if k.lower() not in _STRIP_REQ:
            fwd_headers[k] = v
    fwd_headers["host"]    = "verify.proton.me"
    fwd_headers["origin"]  = "https://verify.proton.me"
    fwd_headers["referer"] = "https://verify.proton.me/"

    body = await request.body()

    upstream = await _get_proxy_client().request(
        method=request.method,
        url=url,
        headers=fwd_headers,
        content=body if body else None,
    )

    # Build response headers — strip unwanted, fix cookies
    res_headers: dict[str, str] = {}
    set_cookie_values: list[str] = []
    for k, v in upstream.headers.multi_items():
        kl = k.lower()
        if kl in _STRIP_RES_HEADERS:
            continue
        if kl == "set-cookie":
            # Strip "; Secure" and replace SameSite=None with SameSite=Lax
            v = re.sub(r";\s*Secure", "", v, flags=re.IGNORECASE)
            v = re.sub(r"SameSite=None", "SameSite=Lax", v, flags=re.IGNORECASE)
            set_cookie_values.append(v)
        else:
            res_headers[k] = v

    content = upstream.content
    content_type = res_headers.get("content-type", "")

    # Rewrite HTML
    if "text/html" in content_type:
        try:
            text = content.decode("utf-8", errors="replace")
            text = re.sub(r'(src|href)="/', r'\1="/captcha-proxy/', text)
            text = text.replace(_CAPTCHA_ORIGIN + "/", _CAPTCHA_PREFIX + "/")
            text = text.replace(_CAPTCHA_ORIGIN, _CAPTCHA_PREFIX)
            text = text.replace("</head>", _HV_JS_INJECT + "\n</head>", 1)
            content = text.encode("utf-8")
        except Exception:
            pass
    # Rewrite CSS — fixes url(/assets/...) for fonts and other assets
    elif "text/css" in content_type:
        try:
            text = content.decode("utf-8", errors="replace")
            text = re.sub(r'url\((/(?!captcha-proxy)[^)]*)\)', r'url(/captcha-proxy\1)', text)
            text = text.replace(_CAPTCHA_ORIGIN + "/", _CAPTCHA_PREFIX + "/")
            content = text.encode("utf-8")
        except Exception:
            pass

    response = Response(
        content=content,
        status_code=upstream.status_code,
        headers=res_headers,
        media_type=content_type or None,
    )
    for cv in set_cookie_values:
        response.headers.append("set-cookie", cv)
    return response


@app.api_route("/captcha-proxy", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
async def captcha_proxy_root(request: Request) -> Response:
    return await _captcha_proxy_handler(request, "")


@app.api_route("/captcha-proxy/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
async def captcha_proxy(request: Request, path: str) -> Response:
    return await _captcha_proxy_handler(request, path)


@app.get("/download/{rel_path:path}")
async def download_file(rel_path: str):
    base      = (DB_DIR / "attachments").resolve()
    file_path = (base / rel_path).resolve()
    if not str(file_path).startswith(str(base)):
        raise HTTPException(status_code=403)
    if not file_path.exists():
        raise HTTPException(status_code=404)
    return FileResponse(
        file_path,
        filename=file_path.name,
        headers={"Content-Disposition": f'attachment; filename="{file_path.name}"'},
    )




@app.get("/")
async def index():
    return FileResponse(FRONTEND_DIR / "index.html")


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()

    # ── loading phase ─────────────────────────────────────────────────────────
    if app_data is None:
        q: asyncio.Queue = asyncio.Queue()
        _subscribers.append(q)
        try:
            for item in list(_loading_progress):
                await websocket.send_json(item)
                if item.get("data", {}).get("done"):
                    break
            while app_data is None:
                try:
                    item = await asyncio.wait_for(q.get(), timeout=0.5)
                    await websocket.send_json(item)
                    if item.get("data", {}).get("done"):
                        break
                except asyncio.TimeoutError:
                    if _loading_progress:
                        await websocket.send_json(_loading_progress[-1])
        except WebSocketDisconnect:
            return
        finally:
            try:
                _subscribers.remove(q)
            except ValueError:
                pass

    # ── normal session ────────────────────────────────────────────────────────
    while app_data is None:
        await asyncio.sleep(0.05)

    session   = Session(app_data, DB_DIR, DATA_DIR)
    send_lock = asyncio.Lock()

    async def safe_send(data: dict) -> None:
        async with send_lock:
            try:
                await websocket.send_json(data)
            except Exception:
                pass

    await safe_send(session.render())

    try:
        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_json(), timeout=0.4)
            except asyncio.TimeoutError:
                if session.screen == "delete_progress" and not session._delete_complete:
                    await safe_send(session.render())
                continue

            if "goto" in data:
                n = int(data["goto"])
                if session.screen == "deleted_senders":
                    session.deleted_senders_cursor = max(0, min(len(session._deleted_senders_cache) - 1, n))
                else:
                    session.cursor = max(0, min(len(session.data.records) - 1, n))
            elif "text_input" in data:
                session.handle_text_input(data["text_input"])
            elif "hv_result" in data:
                hv = data["hv_result"]
                session.handle_hv_result(hv.get("token", ""), hv.get("type", "captcha"))
            else:
                session.handle_key(data.get("key", ""))

            if session.pending_create_account:
                session.pending_create_account = False
                name     = session._account_name_input
                provider = session._account_provider
                try:
                    db.create_account(name, provider)
                    account_dir = DATA_DIR / name
                    account_dir.mkdir(parents=True, exist_ok=True)
                    stat = DATA_DIR.stat()
                    os.chown(account_dir, stat.st_uid, stat.st_gid)
                    os.chmod(account_dir, stat.st_mode)
                    return_screen = session._account_setup_return
                    if return_screen == "accounts":
                        session._accounts_cache  = db.load_accounts(include_disabled=True)
                        session._accounts_cursor = 0
                        session.screen           = "accounts"
                    else:
                        session.screen = "senders"
                    session.status = f"Account '{name}' created. Place .eml files in data/{name}/ and restart."
                except Exception as exc:
                    session._account_error = str(exc)

            if session.pending_import_session:
                session.pending_import_session = False
                asyncio.create_task(_import_session_worker(session, safe_send))

            if session.pending_email_send:
                session.pending_email_send = False
                asyncio.create_task(_email_send_worker(session, safe_send))

            if session.pending_delete:
                session.pending_delete = False
                asyncio.create_task(_deletion_worker(session, safe_send))

            await safe_send(session.render())

    except WebSocketDisconnect:
        if session._proton_client:
            await session._proton_client.close()
