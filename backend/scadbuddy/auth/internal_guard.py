"""The older internal routes' guard (#5297 part 1).

A route of ``/api/v1/internal/{outputs,library,workspace-blobs}`` is refused unless the
request carries a live service credential whose scopes hold the route's class, in every
``SCADBUDDY_AUTH_MODE``, as ``crud.guard.require_crud`` refuses a CRUD route. No live
service credential (none, a dead one, a person, a personal token) is 401
``…/auth/signed-out``; a live one without the class is 403 ``…/auth/forbidden``, never
401, or the client would exchange again and loop (#5514).
"""

from __future__ import annotations

from typing import Any

from fastapi import Depends, Request

from scadbuddy.auth.check import FORBIDDEN, SIGNED_OUT
from scadbuddy.auth.gate import caller_of
from scadbuddy.auth.models import Service
from scadbuddy.core.problems import ApiError


def require_service_class(route_class: str) -> Any:
    """A dependency: the request must be a service credential with ``route_class``."""

    async def check(request: Request) -> None:
        principal = caller_of(request.scope)
        if not isinstance(principal, Service):
            raise ApiError(
                401,
                "This route needs a service credential.",
                type_=SIGNED_OUT,
                headers={"WWW-Authenticate": 'Bearer realm="scadbuddy"'},
                reason="no_credential",
            )
        if route_class not in principal.scopes:
            raise ApiError(
                403,
                "This credential's scope does not cover this route.",
                type_=FORBIDDEN,
                reason="out_of_scope",
            )

    check.__name__ = f"require_service_{route_class.replace('.', '_')}"
    return Depends(check)
