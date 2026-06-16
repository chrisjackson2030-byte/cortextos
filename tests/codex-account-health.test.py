#!/usr/bin/env python3
import json
import subprocess
import tempfile
from pathlib import Path


REPO_ROOT = Path("/Users/chrisjackson/cortextos")
HELPER = REPO_ROOT / "scripts" / "codex-account-health.py"


def _write_auth(home: Path) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "auth.json").write_text(
        json.dumps(
            {
                "tokens": {
                    "access_token": "header.payload.signature",
                    "refresh_token": "refresh",
                }
            }
        )
    )


def test_health_helper_filters_capped_revoked_and_limit_accounts() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        fixture = tmp_path / "fixture.json"
        acct1 = tmp_path / "acct1"
        acct2 = tmp_path / "acct2"
        acct3 = tmp_path / "acct3"

        for home in (acct1, acct2, acct3):
            _write_auth(home)

        fixture.write_text(
            json.dumps(
                {
                    str(acct1): {"state": "revoked", "detail": "token rejected"},
                    str(acct2): {"state": "capped", "detail": "weekly 100%"},
                    str(acct3): {"state": "allowed", "detail": "usage 15%"},
                }
            )
        )

        proc = subprocess.run(
            [
                "python3",
                str(HELPER),
                "--fixture",
                str(fixture),
                "--format",
                "json",
                str(acct1),
                str(acct2),
                str(acct3),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        payload = json.loads(proc.stdout)
        assert [item["state"] for item in payload["accounts"]] == ["revoked", "capped", "allowed"], payload
        assert payload["healthy_homes"] == [str(acct3)], payload


if __name__ == "__main__":
    test_health_helper_filters_capped_revoked_and_limit_accounts()
    print("codex account health test: PASS")
