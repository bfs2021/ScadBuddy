"""The older internal routes' guard (#5297 part 1): refused without a live service
credential that holds the route's class, in every mode, as the CRUD routes are."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient

from scadbuddy.auth.check import auth_check
from scadbuddy.auth.gate import SESSION_COOKIE, AuthGate
from scadbuddy.auth.internal_guard import require_service_class
from scadbuddy.auth.models import AuthSession, PersonalToken, Service
from scadbuddy.core.problems import install_problem_handlers

CREDENTIALS = {
    "sbsvc_print": Service("print", frozenset({"internal.outputs", "internal.library"})),
    "sbsvc_agent": Service("agent", frozenset({"api", "internal.workspace"})),
}
AT = datetime(2026, 11, 1, tzinfo=UTC)
SESSION = AuthSession(
    id_hash=b"\0" * 32,
    principal="user:i#s",
    issuer="i",
    subject="s",
    name=None,
    email=None,
    kind="login",
    created_at=AT,
    last_seen_at=AT,
    idle_expires_at=AT,
    absolute_expires_at=AT,
)


class Credentials:
    def resolve(self, token: str) -> Service | None:
        return CREDENTIALS.get(token)


class Sessions:
    def resolve(self, token: str) -> AuthSession | None:
        return SESSION if token == "live" else None


class Tokens:
    def resolve(self, token: str) -> PersonalToken | None:
        return PersonalToken("t1", "user:i#s", "write") if token == "sbpat_write" else None


class _Noted:
    def note(self, *args: object) -> None: ...


def _client(mode: str) -> TestClient:
    app = FastAPI(dependencies=[Depends(auth_check)])
    auth = SimpleNamespace(would_refuse=_Noted())
    app.state.scadbuddy = SimpleNamespace(
        settings=SimpleNamespace(auth_mode=mode),
        components=SimpleNamespace(get=lambda _component: auth),
    )
    router = APIRouter(
        prefix="/internal/outputs", dependencies=[require_service_class("internal.outputs")]
    )

    @router.get("/ping")
    def ping() -> dict[str, bool]:
        return {"ok": True}

    # The route is classed by its endpoint's module (`auth/routes.py` `INTERNAL_MODULES`).
    ping.__module__ = "scadbuddy.api.internal"
    app.include_router(router, prefix="/api/v1")
    install_problem_handlers(app)
    app.add_middleware(
        AuthGate,
        sessions=lambda: Sessions(),
        credentials=lambda: Credentials(),
        tokens=lambda: Tokens(),
    )
    return TestClient(app)


URL = "/api/v1/internal/outputs/ping"


def _get(client: TestClient, headers: dict[str, str] | None = None) -> Any:
    return client.get(URL, headers=headers or {})


@pytest.mark.parametrize("mode", ["off", "observe", "enforce"])
def test_the_internal_guard_refuses_in_every_mode(mode: str) -> None:
    client = _client(mode)
    for headers in (None, {"authorization": "Bearer sbsvc_dead"}):
        refused = _get(client, headers)
        assert refused.status_code == 401
        assert refused.json()["type"].endswith("/auth/signed-out")
        assert refused.headers["WWW-Authenticate"] == 'Bearer realm="scadbuddy"'
        assert refused.json()["reason"] == "no_credential"
    out_of_scope = _get(client, {"authorization": "Bearer sbsvc_agent"})
    assert out_of_scope.status_code == 403
    assert out_of_scope.json()["type"].endswith("/auth/forbidden")
    assert out_of_scope.json()["reason"] == "out_of_scope"
    assert "WWW-Authenticate" not in out_of_scope.headers
    ok = _get(client, {"authorization": "Bearer sbsvc_print"})
    assert ok.status_code == 200
    assert ok.json() == {"ok": True}


def test_a_person_or_a_personal_token_is_not_a_service() -> None:
    client = _client("off")
    for headers in (
        {"cookie": f"{SESSION_COOKIE}=live"},
        {"authorization": "Bearer sbpat_write"},
    ):
        refused = _get(client, headers)
        assert refused.status_code == 401, headers
        assert refused.json()["reason"] == "no_credential", headers
