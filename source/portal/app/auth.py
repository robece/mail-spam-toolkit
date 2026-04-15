"""JWT utilities."""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

from jose import JWTError, jwt

_SECRET = os.environ.get("JWT_SECRET", "changeme-please-set-jwt-secret-in-env")
_ALGO = "HS256"
_EXPIRE_DAYS = 30


def create_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=_EXPIRE_DAYS)
    return jwt.encode({"sub": user_id, "exp": expire}, _SECRET, algorithm=_ALGO)


def decode_token(token: str) -> str | None:
    try:
        payload = jwt.decode(token, _SECRET, algorithms=[_ALGO])
        return payload.get("sub")
    except JWTError:
        return None
