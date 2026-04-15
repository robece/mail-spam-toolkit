"""FastAPI application — auth endpoints and Protonmail stateless proxy.

Email data never touches this server: it lives in each user's browser (IndexedDB).
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

import bcrypt
import httpx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth, db

FRONTEND_DIR = os.environ.get("FRONTEND_DIR", "/workspace/frontend")
PROTON_API = "https://mail.proton.me/api"
PROTON_HEADERS = {
    "x-pm-appversion": "web-mail@5.0.0.109",
    "Accept": "application/vnd.protonmail.v1+json",
}


# ── lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(_app):
    db.init()
    yield


app = FastAPI(lifespan=lifespan)
_bearer = HTTPBearer()


# ── auth dependency ───────────────────────────────────────────────────────────

async def current_user(creds: HTTPAuthorizationCredentials = Depends(_bearer)) -> dict:
    user_id = auth.decode_token(creds.credentials)
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user = db.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


# ── models ────────────────────────────────────────────────────────────────────

class AuthRequest(BaseModel):
    email: str
    password: str


class ProtonSessionRequest(BaseModel):
    uid: str
    access_token: str
    session_id: str | None = None


class ProtonDeleteRequest(ProtonSessionRequest):
    ids: list[str]


class ProtonFindIdRequest(ProtonSessionRequest):
    external_id: str


# ── auth endpoints ────────────────────────────────────────────────────────────

@app.post("/auth/register", status_code=201)
async def register(body: AuthRequest):
    if not body.email or "@" not in body.email:
        raise HTTPException(status_code=400, detail="Invalid email")
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    if db.get_user_by_email(body.email):
        raise HTTPException(status_code=409, detail="Email already registered")
    hashed = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode()
    user = db.create_user(body.email, hashed)
    token = auth.create_token(user["id"])
    return {"token": token, "user": {"id": user["id"], "email": user["email"]}}


@app.post("/auth/login")
async def login(body: AuthRequest):
    user = db.get_user_by_email(body.email)
    if not user or not bcrypt.checkpw(body.password.encode(), user["password"].encode()):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = auth.create_token(user["id"])
    return {"token": token, "user": {"id": user["id"], "email": user["email"]}}


@app.get("/auth/me")
async def me(user: dict = Depends(current_user)):
    return {"id": user["id"], "email": user["email"]}


# ── Protonmail proxy (stateless) ──────────────────────────────────────────────

def _cookies(req: ProtonSessionRequest) -> dict:
    c = {f"AUTH-{req.uid}": req.access_token}
    if req.session_id:
        c["Session-Id"] = req.session_id
    return c


@app.post("/proton/verify-session")
async def verify_session(req: ProtonSessionRequest, _user: dict = Depends(current_user)):
    """Validate a pasted Protonmail session. Credentials are never stored."""
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{PROTON_API}/mail/v4/messages?Limit=1",
            cookies=_cookies(req),
            headers=PROTON_HEADERS,
            timeout=15.0,
        )
    return {"valid": r.status_code == 200, "status": r.status_code}


@app.post("/proton/delete")
async def delete_messages(req: ProtonDeleteRequest, _user: dict = Depends(current_user)):
    """Permanently delete messages from Protonmail. Credentials are never stored."""
    if not req.ids:
        raise HTTPException(status_code=400, detail="No message IDs provided")
    async with httpx.AsyncClient() as client:
        r = await client.put(
            f"{PROTON_API}/mail/v4/messages/delete",
            cookies=_cookies(req),
            headers=PROTON_HEADERS,
            json={"IDs": req.ids},
            timeout=30.0,
        )
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=r.status_code, detail="Protonmail API error")
    return r.json()


@app.post("/proton/find-id")
async def find_message_id(req: ProtonFindIdRequest, _user: dict = Depends(current_user)):
    """Resolve an RFC Message-ID to a Protonmail internal ID (for .eml without metadata)."""
    ext = req.external_id.strip("<>")
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{PROTON_API}/mail/v4/messages",
            params={"ExternalID": ext},
            cookies=_cookies(req),
            headers=PROTON_HEADERS,
            timeout=15.0,
        )
    if r.status_code != 200:
        return {"id": None}
    msgs = r.json().get("Messages", [])
    return {"id": msgs[0]["ID"] if msgs else None}


# ── static frontend (must be last) ───────────────────────────────────────────

app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="static")
