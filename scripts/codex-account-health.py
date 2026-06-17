#!/usr/bin/env python3
"""Probe Codex account availability from auth.json plus a lightweight usage check."""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

OAUTH_URL = "https://auth.openai.com/oauth/token"
USAGE_URL = "https://chatgpt.com/backend-api/codex/usage"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"


def _decode_payload(token: str) -> dict[str, Any]:
    seg = token.split(".")[1]
    seg += "=" * (-len(seg) % 4)
    return json.loads(base64.urlsafe_b64decode(seg))


def _refresh_access_token(refresh_token: str) -> str:
    req = urllib.request.Request(
        OAUTH_URL,
        data=json.dumps(
            {
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": CLIENT_ID,
            }
        ).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        payload = json.loads(response.read())
    token = payload.get("access_token", "")
    if not token:
        raise RuntimeError("refresh_missing_access_token")
    return token


def probe_home(home: Path, fixture: dict[str, Any] | None = None) -> dict[str, Any]:
    if fixture and str(home) in fixture:
        entry = fixture[str(home)]
        state = str(entry.get("state", "error"))
        return {
            "home": str(home),
            "name": home.name,
            "state": state,
            "detail": str(entry.get("detail", "fixture")),
            "email": entry.get("email"),
            "usable": state == "allowed",
        }

    auth_path = home / "auth.json"
    if not auth_path.exists():
        return {
            "home": str(home),
            "name": home.name,
            "state": "auth-missing",
            "detail": "auth.json_not_found",
            "email": None,
            "usable": False,
        }

    try:
        auth = json.loads(auth_path.read_text())
    except Exception as exc:  # noqa: BLE001
        return {
            "home": str(home),
            "name": home.name,
            "state": "error",
            "detail": f"auth_read_failed:{type(exc).__name__}",
            "email": None,
            "usable": False,
        }

    tokens = auth.get("tokens", auth)
    access_token = str(tokens.get("access_token", "") or "")
    refresh_token = str(tokens.get("refresh_token", "") or "")
    if not access_token:
        return {
            "home": str(home),
            "name": home.name,
            "state": "revoked" if refresh_token else "auth-missing",
            "detail": "no_access_token",
            "email": None,
            "usable": False,
        }

    try:
        payload = _decode_payload(access_token)
    except Exception as exc:  # noqa: BLE001
        return {
            "home": str(home),
            "name": home.name,
            "state": "error",
            "detail": f"token_decode_failed:{type(exc).__name__}",
            "email": None,
            "usable": False,
        }

    if payload.get("exp", 0) - time.time() <= 300:
        if not refresh_token:
            return {
                "home": str(home),
                "name": home.name,
                "state": "revoked",
                "detail": "token_expired_no_refresh",
                "email": None,
                "usable": False,
            }
        try:
            access_token = _refresh_access_token(refresh_token)
        except urllib.error.HTTPError as exc:
            state = "revoked" if exc.code in (400, 401, 403) else "error"
            return {
                "home": str(home),
                "name": home.name,
                "state": state,
                "detail": f"refresh_http_{exc.code}",
                "email": None,
                "usable": False,
            }
        except Exception as exc:  # noqa: BLE001
            return {
                "home": str(home),
                "name": home.name,
                "state": "error",
                "detail": f"refresh_failed:{type(exc).__name__}",
                "email": None,
                "usable": False,
            }

    request = urllib.request.Request(
        USAGE_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "User-Agent": "codex-account-health",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            usage = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            state = "revoked"
        elif exc.code == 429:
            state = "capped"
        else:
            state = "error"
        return {
            "home": str(home),
            "name": home.name,
            "state": state,
            "detail": f"usage_http_{exc.code}",
            "email": None,
            "usable": False,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "home": str(home),
            "name": home.name,
            "state": "error",
            "detail": f"usage_failed:{type(exc).__name__}",
            "email": None,
            "usable": False,
        }

    rate_limit = usage.get("rate_limit", {}) or {}
    secondary = rate_limit.get("secondary_window", {}) or {}
    used_percent = secondary.get("used_percent")
    reset_seconds = secondary.get("reset_after_seconds")
    state = "allowed" if rate_limit.get("allowed", True) and not rate_limit.get("limit_reached", False) else "capped"
    detail_parts = []
    if used_percent is not None:
        detail_parts.append(f"used={float(used_percent):.0f}%")
    if reset_seconds:
        detail_parts.append(f"reset={int(reset_seconds // 60)}m")
    if not detail_parts:
        detail_parts.append("usage_ok" if state == "allowed" else "usage_limited")
    return {
        "home": str(home),
        "name": home.name,
        "state": state,
        "detail": ",".join(detail_parts),
        "email": usage.get("email"),
        "usable": state == "allowed",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe Codex account health.")
    parser.add_argument("--fixture", help="JSON fixture for deterministic tests")
    parser.add_argument("--format", choices=("json", "lines"), default="json")
    parser.add_argument("homes", nargs="+")
    args = parser.parse_args()

    fixture = json.loads(Path(args.fixture).read_text()) if args.fixture else None

    def _probe_retry(home_path: Path) -> dict[str, Any]:
        # "error" is a TRANSIENT network/API failure (unlike "revoked"/"capped", which are
        # real). Retry once before trusting a 0/dead result, so a momentary blip cannot
        # report a healthy account as unusable (false RED, B caught 2026-06-16).
        import time as _t
        r = probe_home(home_path, fixture=fixture)
        if r.get("state") == "error" and fixture is None:
            _t.sleep(2)
            r2 = probe_home(home_path, fixture=fixture)
            if r2.get("usable") or r2.get("state") != "error":
                return r2
        return r

    accounts = [_probe_retry(Path(home).expanduser()) for home in args.homes]
    payload = {
        "accounts": accounts,
        "healthy_homes": [account["home"] for account in accounts if account["usable"]],
    }
    if args.format == "json":
        json.dump(payload, sys.stdout)
        sys.stdout.write("\n")
    else:
        for account in accounts:
            print(
                f"{account['name']}:{account['state']}:{account['detail']}:"
                f"{account.get('email') or 'unknown'}:{account['home']}"
            )
        print("healthy_homes=" + ",".join(payload["healthy_homes"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
