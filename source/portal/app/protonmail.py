"""Protonmail API client — SRP authentication and permanent mail deletion."""
from __future__ import annotations

import base64
import email as email_lib
import hashlib
import re
import secrets

import bcrypt
import httpx

BASE_URL = "https://mail.proton.me/api"
SRP_LEN  = 256  # 2048-bit modulus = 256 bytes

# ── base64 helpers ────────────────────────────────────────────────────────────

# Alphabet mapping: standard base64 → bcrypt base64 (positional substitution)
_STD_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
_BCT_B64 = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
_STD_TO_BCT = str.maketrans(_STD_B64, _BCT_B64)


def _b64d(s: str) -> bytes:
    s = s.replace(" ", "").replace("\n", "")
    pad = (-len(s)) % 4
    return base64.b64decode(s + "=" * pad)


def _b64e(b: bytes) -> str:
    return base64.b64encode(b).decode()


# ── SRP helpers ───────────────────────────────────────────────────────────────

def _expand_hash(data: bytes) -> bytes:
    """Protonmail SRP hash: 4×SHA-512 with byte suffixes 0-3 → 256 bytes."""
    return b"".join(hashlib.sha512(data + bytes([i])).digest() for i in range(4))


def _itob(n: int, length: int = SRP_LEN) -> bytes:
    """Integer → little-endian bytes, zero-padded to `length`."""
    return n.to_bytes(length, "little")


def _btoi(b: bytes) -> int:
    """Little-endian bytes → integer."""
    return int.from_bytes(b, "little")


def _extract_modulus(signed: str) -> bytes:
    """Extract raw modulus bytes from Protonmail's PGP-signed message."""
    match = re.search(r"Hash:.*?\n\n(.*?)-----BEGIN PGP SIGN", signed, re.DOTALL)
    if not match:
        raise ValueError("Cannot parse modulus from signed message")
    content = match.group(1).strip().replace("\n", "")
    return _b64d(content)


def _make_bcrypt_salt(raw_16: bytes) -> bytes:
    """Encode 16 raw bytes as a $2y$10$... bcrypt salt."""
    b64 = base64.b64encode(raw_16).decode().rstrip("=")[:22]
    bct = b64.translate(_STD_TO_BCT)
    return f"$2y$10${bct}".encode()


def _srp_proof(
    password: str,
    salt_b64: str,
    modulus_bytes: bytes,
    server_ephemeral_b64: str,
) -> tuple[str, str]:
    """Return (client_ephemeral_b64, client_proof_b64) for SRP-6a."""
    # Hash password with bcrypt, then expand with modulus → 256-byte x
    raw_salt = (_b64d(salt_b64) + b"proton")[:16]
    bcrypt_salt = _make_bcrypt_salt(raw_salt)
    pw_hash = bcrypt.hashpw(password.encode(), bcrypt_salt)
    # Python's bcrypt normalises $2y$ → $2b$ in the returned string; restore
    # $2y$ to match Protonmail's Go implementation, which uses $2y$ throughout.
    if pw_hash.startswith(b"$2b$"):
        pw_hash = b"$2y$" + pw_hash[4:]
    x = _btoi(_expand_hash(pw_hash + modulus_bytes))

    N = _btoi(modulus_bytes)
    g = 2
    k = _btoi(_expand_hash(_itob(N) + _itob(g)))

    # Client ephemeral
    a     = _btoi(secrets.token_bytes(SRP_LEN))
    A     = pow(g, a, N)
    A_b   = _itob(A)

    # Server ephemeral (pad to SRP_LEN if shorter)
    B_b   = _b64d(server_ephemeral_b64)
    B_b   = B_b + b"\x00" * (SRP_LEN - len(B_b))
    B     = _btoi(B_b)

    u     = _btoi(_expand_hash(A_b + B_b))
    base  = (B - k * pow(g, x, N)) % N
    S     = pow(base, a + u * x, N)
    S_b   = _itob(S)

    M1    = _expand_hash(A_b + B_b + S_b)
    return _b64e(A_b), _b64e(M1)


# ── Human verification ────────────────────────────────────────────────────────

class HumanVerificationRequired(Exception):
    """Raised when Protonmail requires human verification before auth can proceed."""
    def __init__(self, token: str, methods: list | None = None, web_url: str = ""):
        super().__init__("Human verification required")
        self.token   = token
        self.methods = methods or []
        self.web_url = web_url


# ── ProtonClient ──────────────────────────────────────────────────────────────

class ProtonClient:
    def __init__(self) -> None:
        self._http: httpx.AsyncClient | None = None
        self._uid            = ""
        self._access_token   = ""

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                base_url=BASE_URL,
                headers={"x-pm-appversion": "Other", "Content-Type": "application/json"},
                timeout=30.0,
            )
        return self._http

    def _auth_headers(self) -> dict:
        if self._access_token:
            return {"Authorization": f"Bearer {self._access_token}", "x-pm-uid": self._uid}
        return {"x-pm-uid": self._uid}  # cookie auth — no Bearer needed

    def set_session(self, uid: str, access_token: str) -> None:
        self._uid          = uid
        self._access_token = access_token

    def set_cookie_session(self, uid: str, auth_cookie: str, session_id: str = "") -> None:
        """Use browser cookies for auth instead of Bearer token."""
        self._uid = uid
        self._access_token = ""
        c = self._client()
        c.cookies.set(f"AUTH-{uid}", auth_cookie)
        if session_id:
            c.cookies.set("Session-Id", session_id)

    async def authenticate(self, username: str, password: str,
                           hv_token: str = "", hv_type: str = "captcha") -> None:
        c = self._client()

        r = await c.post("/auth/v4/info", json={"Username": username})
        r.raise_for_status()
        info = r.json()

        modulus = _extract_modulus(info["Modulus"])
        ceph, proof = _srp_proof(password, info["Salt"], modulus, info["ServerEphemeral"])

        extra: dict = {}
        if hv_token:
            extra["x-pm-human-verification-token"]      = hv_token
            extra["x-pm-human-verification-token-type"] = hv_type
            print(f"[proton] HV token={hv_token!r} type={hv_type!r}", flush=True)

        r = await c.post("/auth/v4", json={
            "Username":        username,
            "SRPSession":      info["SRPSession"],
            "ClientEphemeral": ceph,
            "ClientProof":     proof,
        }, headers=extra)
        try:
            r.raise_for_status()
        except httpx.HTTPStatusError as exc:
            body: dict = {}
            try:
                body = exc.response.json()
            except Exception:
                pass
            print(f"[proton] /auth/v4 response {exc.response.status_code}: {body}", flush=True)
            if exc.response.status_code == 422 and body.get("Code") == 9001:
                details = body.get("Details", {})
                token   = details.get("HumanVerificationToken", "")
                methods = details.get("HumanVerificationMethods", [])
                web_url = details.get("WebUrl", "")
                raise HumanVerificationRequired(token, methods, web_url)
            detail = body.get("Error", exc.response.text[:200])
            raise ValueError(f"Auth failed ({exc.response.status_code}): {detail}")

        d = r.json()
        self._uid          = d["UID"]
        self._access_token = d["AccessToken"]

    async def find_id(self, external_id: str) -> str | None:
        """Return Protonmail internal message ID for a given RFC Message-ID."""
        ext = external_id.strip("<>")
        r   = await self._client().get(
            "/mail/v4/messages",
            params={"ExternalID": ext},
            headers=self._auth_headers(),
        )
        r.raise_for_status()
        msgs = r.json().get("Messages", [])
        return msgs[0]["ID"] if msgs else None

    async def delete_permanently(self, ids: list[str]) -> None:
        """Permanently delete messages, bypassing trash."""
        if not ids:
            return
        r = await self._client().put(
            "/mail/v4/messages/delete",
            json={"IDs": ids},
            headers=self._auth_headers(),
        )
        r.raise_for_status()

    async def close(self) -> None:
        if self._http:
            await self._http.aclose()
            self._http = None


# ── .eml helper ──────────────────────────────────────────────────────────────

def read_message_id(eml_path: str) -> str | None:
    """Read Message-ID header from a .eml file."""
    try:
        with open(eml_path, "rb") as f:
            msg = email_lib.message_from_bytes(f.read())
        return msg.get("Message-ID", "").strip() or None
    except Exception:
        return None
