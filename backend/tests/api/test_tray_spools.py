"""#3818 tier A Task 6c, #6262 Task 4: a person says which SB spool is in an untagged
tray, on the native path: the spool's tray place (`filament/inventory.py`), never
Bambuddy's assignment. The overlay tests below read the spool providers' records, which
stay until #6262 Task 12."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from scadbuddy.api.deps import STATE_ATTR, AppState
from scadbuddy.bambuddy.trays import seen_trays
from scadbuddy.filament.component import FILAMENT, Filament
from scadbuddy.filament.models import Material, SpoolCreate
from scadbuddy.printers.component import PRINTERS, Printers
from scadbuddy.printers.models import LanLink, PrinterCreate
from scadbuddy.printers.reports import report_status
from scadbuddy.spools.component import SPOOLS, Spools
from scadbuddy.spools.models import SpoolSnapshot
from scadbuddy.spools.overlay import printer_overlay
from tests.printers.conftest import KEK
from tests.support.no_bambuddy import forbid_bambuddy

pytestmark = pytest.mark.requires_postgres

SERIAL = "01P00A000000002"
UUID_A = "A1B2C3D4E5F60718293A4B5C6D7E8F90"


#: A well-formed body naming no spool, for the refusals that come first.
_ANY = {"spool_id": "8d6f3c1e-0000-4000-8000-0000000000ff"}


def _state(client: TestClient) -> AppState:
    state: AppState = getattr(client.app.state, STATE_ATTR)  # type: ignore[attr-defined]
    return state


def _printers(client: TestClient) -> Printers:
    return _state(client).components.get(PRINTERS)


def _spools(client: TestClient) -> Spools:
    return _state(client).components.get(SPOOLS)


def _report(white: str = "FFFFFFFF") -> dict[str, Any]:
    return {
        "gcode_state": "IDLE",
        "ams": {
            "ams": [
                {
                    "id": "0",
                    "tray": [
                        {
                            "id": "0",
                            "tray_type": "PLA",
                            "tray_color": "000000FF",
                            "tray_info_idx": "GFA00",
                            "state": 11,
                            "remain": 80,
                            "tray_uuid": UUID_A,
                            "tag_uid": "0102030405060708",
                        },
                        {
                            "id": "1",
                            "tray_type": "PLA",
                            "tray_color": white,
                            "state": 11,
                            "remain": -1,
                            "tray_uuid": "0" * 32,
                            "tag_uid": "0" * 16,
                        },
                        {"id": "2", "tray_type": "", "state": 9},
                    ],
                }
            ]
        },
    }


@pytest.fixture
def lan_printer(client: TestClient) -> Iterator[str]:
    """A LAN-linked row with a fresh report, written straight to the stores."""
    printers = _printers(client)
    printers.store.kek = KEK
    row = printers.store.create(PrinterCreate(serial=SERIAL, name="Garage"))
    printers.store.link_lan(
        row.id, LanLink(host="10.0.0.9", access_code="12345678"), cert_sha256="ab" * 32
    )
    printers.reports.put(row.id, _report(), datetime.now(UTC))
    yield row.id


def _bambuddy_record(client: TestClient, record_id: str = "16", **fields: Any) -> None:
    snapshot = SpoolSnapshot.model_validate(
        {
            "record_id": record_id,
            "material": "PLA",
            "colour": "#FFFFFF",
            "brand": "Inland",
            "remaining_g": 515.0,
            **fields,
        }
    )
    client.portal.call(  # type: ignore[union-attr]
        _spools(client).store.replace_records, "bambuddy", [snapshot], datetime.now(UTC)
    )


def _path(printer_id: str, ams_id: int = 0, tray_id: int = 1) -> str:
    return f"/api/v1/printers/{printer_id}/trays/{ams_id}/{tray_id}/spool"


def _overlay(client: TestClient, printer_id: str) -> Any:
    row = _printers(client).store.require(printer_id)
    report = _printers(client).reports.get(printer_id)
    assert report is not None

    async def read() -> Any:
        return await printer_overlay(_spools(client), row, report, now=datetime.now(UTC))

    return client.portal.call(read)  # type: ignore[union-attr]


def _tray(overlay: Any, ams_id: int, tray_id: int) -> Any:
    return next(t for t in overlay.trays if (t.ams_id, t.tray_id) == (ams_id, tray_id))


def _filament(client: TestClient) -> Filament:
    return _state(client).components.get(FILAMENT)


def _sb_spool(client: TestClient) -> UUID:
    filament = _filament(client)
    material = next(
        r.id
        for r in filament.catalog.list("materials")
        if isinstance(r, Material) and r.name == "PLA"
    )
    return filament.spools.create(SpoolCreate(material_id=material), actor="ann").id


def _held(client: TestClient, printer_id: str, tray_id: int = 1) -> UUID | None:
    """The SB spool the printer's latest report holds in AMS 0 ``tray_id``."""
    row = _printers(client).store.require(printer_id)
    report = _printers(client).reports.get(printer_id)
    assert report is not None
    seen = seen_trays(report_status(row, report, now=datetime.now(UTC)))
    view = _filament(client).inventory.trays(UUID(printer_id), seen)
    holder = next(t for t in view.trays if (t.ams_id, t.tray_id) == (0, tray_id))
    return None if holder.spool is None else holder.spool.id


def test_tray_spool_links_routes(
    client: TestClient, lan_printer: str, spans: InMemorySpanExporter
) -> None:
    """Link an SB spool to an untagged tray, read it back as the tray's, then unlink it;
    nothing reaches Bambuddy."""
    spool = _sb_spool(client)
    with forbid_bambuddy(spans, "https://bambuddy.test"):
        linked = client.put(_path(lan_printer), json={"spool_id": str(spool)})
        assert linked.status_code == 200, linked.text
        body = linked.json()
        assert body["id"] == str(spool) and body["location_id"] is not None
        assert _held(client, lan_printer) == spool

        gone = client.delete(_path(lan_printer))
        assert gone.status_code == 204
        assert _held(client, lan_printer) is None
        after = _filament(client).spools.get(spool)
        assert after is not None and after.location_id is None


def test_a_link_held_until_the_trays_colour_changes(client: TestClient, lan_printer: str) -> None:
    spool = _sb_spool(client)
    assert client.put(_path(lan_printer), json={"spool_id": str(spool)}).status_code == 200
    assert _held(client, lan_printer) == spool
    _printers(client).reports.put(lan_printer, _report(white="00FF00FF"), datetime.now(UTC))
    assert _held(client, lan_printer) is None


def test_an_rfid_tray_resolves_by_its_tag(client: TestClient, lan_printer: str) -> None:
    _bambuddy_record(client, "3", tray_uuid=UUID_A, colour="#000000")
    tray = _tray(_overlay(client, lan_printer), 0, 0)
    assert tray.linked_by == "rfid" and tray.records["bambuddy"].record_id == "3"


def test_the_overlay_names_a_stale_provider(client: TestClient, lan_printer: str) -> None:
    snapshot = SpoolSnapshot(record_id="3", tray_uuid=UUID_A)
    client.portal.call(  # type: ignore[union-attr]
        _spools(client).store.replace_records,
        "bambuddy",
        [snapshot],
        datetime.now(UTC) - timedelta(minutes=31),
    )
    # With no Bambuddy configured there is no one to name (#4601).
    assert "bambuddy" not in _overlay(client, lan_printer).stale
    put = client.put("/api/v1/settings", json={"bambuddy_url": "https://bambuddy.test"})
    assert put.status_code == 200, put.text
    overlay = _overlay(client, lan_printer)
    assert "bambuddy" in overlay.stale and _tray(overlay, 0, 0).records == {}


def test_a_link_names_an_sb_spool(client: TestClient, lan_printer: str) -> None:
    for body in (
        {},
        {"spool_id": "16"},
        {"provider": "bambuddy", "record_id": "16"},
        {"physical_spool_id": "8d6f3c1e-0000-4000-8000-000000000000"},
    ):
        assert client.put(_path(lan_printer), json=body).status_code == 422, body


def test_an_unknown_spool_is_404(client: TestClient, lan_printer: str) -> None:
    missing = "8d6f3c1e-0000-4000-8000-000000000000"
    answer = client.put(_path(lan_printer), json={"spool_id": missing})
    assert answer.status_code == 404 and missing in answer.json()["detail"]


def test_a_virtual_printer_has_no_trays(client: TestClient, lan_printer: str) -> None:
    """#4747: a Bambuddy virtual printer is not hardware, so no spool goes in its trays."""
    with _printers(client).store.pool.connection() as conn:
        conn.execute(
            "UPDATE printers SET kind = 'bambuddy_virtual', bambuddy_vp_id = 1 WHERE id = %s",
            (lan_printer,),
        )
    response = client.put(_path(lan_printer), json=_ANY)
    assert response.status_code == 409 and "virtual" in response.json()["detail"]


def test_an_unknown_printer_is_404(client: TestClient) -> None:
    for printer_id in ("8d6f3c1e-0000-4000-8000-000000000001", "not-a-uuid"):
        assert client.put(_path(printer_id), json=_ANY).status_code == 404
        assert client.delete(_path(printer_id)).status_code == 404


def test_a_tray_the_report_does_not_show_filled_is_409(
    client: TestClient, lan_printer: str
) -> None:
    empty = client.put(_path(lan_printer, tray_id=2), json={"spool_id": str(_sb_spool(client))})
    assert empty.status_code == 409 and "AMS-A slot 3" in empty.json()["detail"]


def test_a_printer_with_no_report_is_409(client: TestClient) -> None:
    printers = _printers(client)
    row = printers.store.create(PrinterCreate(serial="01P00A000000003", name="Attic"))
    answer = client.put(_path(row.id), json=_ANY)
    assert answer.status_code == 409


def test_a_tag_bound_elsewhere_refuses_the_link(client: TestClient, lan_printer: str) -> None:
    """Tray 0 reports tag ``UUID_A``, which is on spool B: A cannot be placed there."""
    a, b = _sb_spool(client), _sb_spool(client)
    _filament(client).spools.bind_tag(b, tray_uuid=UUID_A, kind="bambu_mifare", actor="ann")
    tagged = client.put(_path(lan_printer, tray_id=0), json={"spool_id": str(a)})
    assert tagged.status_code == 409, tagged.text
    assert "tag" in tagged.json()["detail"]


def test_a_printer_deleted_during_the_link_is_404_not_500(
    client: TestClient, lan_printer: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Rulings (from #4186's review): a printer gone between the read and the write is
    the printer's 404, not a 500."""
    spool = _sb_spool(client)
    inventory = _filament(client).inventory
    link = inventory.link

    def deleted_first(*args: Any, **kwargs: Any) -> Any:
        _printers(client).store.delete(lan_printer)
        return link(*args, **kwargs)

    monkeypatch.setattr(inventory, "link", deleted_first)
    answer = client.put(_path(lan_printer), json={"spool_id": str(spool)})
    assert answer.status_code == 404, answer.text


@pytest.mark.parametrize(("ams_id", "tray_id"), [(60, 0), (0, 4), (128, 1), (255, 2), (200, 0)])
def test_a_unit_no_printer_has_is_422(
    client: TestClient, lan_printer: str, ams_id: int, tray_id: int
) -> None:
    """#4336 review M1: AMS 0-15 with trays 0-3, an AMS-HT 128-135 with tray 0, the
    external holders 255 with trays 0-1 (`trays.unit_label`'s spaces)."""
    assert client.put(_path(lan_printer, ams_id, tray_id), json=_ANY).status_code == 422
    assert client.delete(_path(lan_printer, ams_id, tray_id)).status_code == 422


def test_bambuddys_own_assignment_seeds_the_registry_printers_tray(
    client: TestClient, lan_printer: str
) -> None:
    """#4336 review M4, the #4180 handoff end to end: the registry row's Bambuddy link
    (`BambuddyProvider.printer_key`) is the ``located`` the overlay matches a record's
    own location against."""
    _printers(client).store.link_bambuddy(lan_printer, 5)
    _bambuddy_record(
        client,
        location={"printer": "bambuddy:5", "ams_id": 0, "tray_id": 1, "fingerprint": "PLA|FFFFFF"},
    )
    tray = _tray(_overlay(client, lan_printer), 0, 1)
    assert tray.linked_by == "provider" and tray.records["bambuddy"].record_id == "16"


def test_another_bambuddy_printers_assignment_is_not_this_trays(
    client: TestClient, lan_printer: str
) -> None:
    _printers(client).store.link_bambuddy(lan_printer, 5)
    _bambuddy_record(
        client,
        location={"printer": "bambuddy:6", "ams_id": 0, "tray_id": 1, "fingerprint": "PLA|FFFFFF"},
    )
    assert _tray(_overlay(client, lan_printer), 0, 1).linked_by is None
