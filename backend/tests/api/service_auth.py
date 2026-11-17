"""A live service credential for a test client (#5297): the internal routes refuse a
request without one, in every mode."""

from __future__ import annotations

from fastapi.testclient import TestClient

from scadbuddy.api.deps import STATE_ATTR
from scadbuddy.auth.service_credentials import ServiceCaller, ServiceCredentialStore


def authorize(client: TestClient, caller: ServiceCaller) -> TestClient:
    """Send ``caller``'s credential on every request of ``client``, minted as the
    exchange mints one (`tests/api/test_service_credentials.py`)."""
    state = getattr(client.app.state, STATE_ATTR)  # type: ignore[attr-defined]
    store = ServiceCredentialStore(state.settings_store.pool)
    token = store.issue(caller, "bootstrap", rate_limited=False).token
    client.headers["Authorization"] = f"Bearer {token}"
    return client
