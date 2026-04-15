"""Protonmail cookie-string parser helper.

The actual API calls are proxied through main.py endpoints.
This module provides a utility to parse the raw Cookie header
that users copy from browser DevTools.
"""
from __future__ import annotations


def parse_cookie_string(raw: str) -> dict | None:
    """Parse a raw Cookie header into { uid, access_token, session_id }.

    Expected format (from browser DevTools → Network → any request → Cookie header):
        AUTH-<uid>=<access_token>; Session-Id=<session_id>; ...

    Returns None if the AUTH-* cookie is not found.
    """
    cookies: dict[str, str] = {}
    for part in raw.split(";"):
        part = part.strip()
        if not part:
            continue
        idx = part.find("=")
        if idx < 0:
            continue
        key = part[:idx].strip()
        val = part[idx + 1:].strip()
        cookies[key] = val

    auth_key = next((k for k in cookies if k.startswith("AUTH-")), None)
    if not auth_key:
        return None

    return {
        "uid": auth_key[len("AUTH-"):],
        "access_token": cookies[auth_key],
        "session_id": cookies.get("Session-Id"),
    }
