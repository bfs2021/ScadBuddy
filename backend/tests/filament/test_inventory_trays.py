"""Which SB spool is in each AMS tray (#6262 Task 4, spec §5.3 "current tray"): a tag's
open binding first, else the spool a person placed at the tray while the tray still
shows what they saw (`filament/inventory.py`)."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest

from scadbuddy.filament.catalog import CatalogStore
from scadbuddy.filament.inventory import (
    FilamentInventory,
    TrayHolder,
    TrayNotFilledError,
    TrayTagClashError,
    TrayView,
    tray_fingerprint,
)
from scadbuddy.filament.locations import LocationStore
from scadbuddy.filament.models import Material, SpoolCreate
from scadbuddy.filament.spools import FilamentSpoolStore
from scadbuddy.printers.reports import PrinterReportStore
from scadbuddy.spools.models import SeenTray
from tests.conftest import PgPool

pytestmark = pytest.mark.requires_postgres

UUID_A = "A1B2C3D4E5F60718293A4B5C6D7E8F90"


def _spool(pool: PgPool) -> UUID:
    material = next(
        r.id
        for r in CatalogStore(pool).list("materials")
        if isinstance(r, Material) and r.name == "PLA"
    )
    return FilamentSpoolStore(pool).create(SpoolCreate(material_id=material), actor="ann").id


def _printer(pool: PgPool) -> UUID:
    printer = uuid4()
    with pool.connection() as conn:
        conn.execute(
            "INSERT INTO printers (id, serial, name) VALUES (%s, %s, 'Garage')",
            (printer, f"SN{printer.hex[:8]}"),
        )
    return printer


def _seen(colour: str | None = "#FF0000FF", **keys: str) -> SeenTray:
    return SeenTray(ams_id=0, tray_id=1, material="PLA", colour=colour, **keys)


def _holder(view: TrayView, ams_id: int = 0, tray_id: int = 1) -> TrayHolder:
    return next(t for t in view.trays if (t.ams_id, t.tray_id) == (ams_id, tray_id))


def _held(view: TrayView) -> UUID | None:
    spool = _holder(view).spool
    return None if spool is None else spool.id


def _moves(pool: PgPool, spool_id: UUID) -> int:
    return len([e for e in FilamentSpoolStore(pool).events(spool_id) if e.kind == "moved"])


def test_an_empty_colour_fingerprints() -> None:
    assert tray_fingerprint("PLA", "") == "PLA|"
    assert tray_fingerprint("PLA", None) == "PLA|"
    assert tray_fingerprint(" pla ", "#ff0000") == "PLA|#FF0000FF"
    assert tray_fingerprint(None, "FFFFFF80") == "|#FFFFFF80"


def test_a_tagged_tray_is_its_bound_spool(pg_pool: PgPool) -> None:
    a, b = _spool(pg_pool), _spool(pg_pool)
    spools = FilamentSpoolStore(pg_pool)
    spools.bind_tag(a, tray_uuid=UUID_A, kind="bambu_mifare", actor="ann")
    spools.bind_tag(b, tag_uid="0102030405060708", kind="other", actor="ann")
    printer = _printer(pg_pool)
    view = FilamentInventory(pg_pool).trays(
        printer,
        [
            SeenTray(ams_id=0, tray_id=0, tray_uuid=UUID_A, material="PLA", colour="#000000"),
            SeenTray(ams_id=0, tray_id=1, tag_uid="0102030405060708", material="PLA"),
            SeenTray(ams_id=0, tray_id=2, tray_uuid="F" * 32, material="PLA"),
        ],
    )
    found = [(t.tray_id, t.spool.id if t.spool else None, t.found_by) for t in view.trays]
    assert found == [(0, a, "tag"), (1, b, "tag"), (2, None, None)]
    assert view.shelf == []


def test_an_untagged_link_holds_while_the_tray_matches(pg_pool: PgPool) -> None:
    """Review Focus 3: a linked tray refilled with another colour holds no spool, and the
    spool is on the shelf again."""
    a, printer = _spool(pg_pool), _printer(pg_pool)
    inventory = FilamentInventory(pg_pool)
    linked = inventory.link(printer, 0, 1, a, _seen("#FF0000FF"), actor="ann")
    assert linked.id == a and linked.location_id is not None

    held = _holder(inventory.trays(printer, [_seen("#FF0000FF")]))
    assert (held.spool.id if held.spool else None, held.found_by) == (a, "link")

    view = inventory.trays(printer, [_seen("#00FF00FF")])
    changed = _holder(view)
    assert (changed.spool, changed.found_by) == (None, None)
    assert [s.id for s in view.shelf] == [a]


def test_alpha_is_part_of_the_fingerprint(pg_pool: PgPool) -> None:
    a, printer = _spool(pg_pool), _printer(pg_pool)
    inventory = FilamentInventory(pg_pool)
    inventory.link(printer, 0, 1, a, _seen("#FFFFFFFF"), actor="ann")
    assert _held(inventory.trays(printer, [_seen("#FFFFFF80")])) is None
    # A six-digit colour reads as opaque.
    assert _held(inventory.trays(printer, [_seen("#FFFFFF")])) == a


def test_link_moves_the_previous_holder_off(pg_pool: PgPool) -> None:
    a, b, printer = _spool(pg_pool), _spool(pg_pool), _printer(pg_pool)
    inventory = FilamentInventory(pg_pool)
    inventory.link(printer, 0, 1, b, _seen(), actor="ann")
    inventory.link(printer, 0, 1, a, _seen(), actor="ann")
    spools = FilamentSpoolStore(pg_pool)
    moved_b, moved_a = spools.get(b), spools.get(a)
    assert moved_b is not None and moved_a is not None
    assert moved_b.location_id is None
    assert moved_a.location_id is not None
    # B: in, then out. A: in once.
    assert (_moves(pg_pool, b), _moves(pg_pool, a)) == (2, 1)
    assert _held(inventory.trays(printer, [_seen()])) == a


def test_a_relink_of_the_same_spool_writes_no_move(pg_pool: PgPool) -> None:
    a, printer = _spool(pg_pool), _printer(pg_pool)
    inventory = FilamentInventory(pg_pool)
    inventory.link(printer, 0, 1, a, _seen("#FF0000FF"), actor="ann")
    inventory.link(printer, 0, 1, a, _seen("#0000FFFF"), actor="ann")
    assert _moves(pg_pool, a) == 1
    assert _held(inventory.trays(printer, [_seen("#0000FFFF")])) == a


def test_a_move_forgets_the_fingerprint(pg_pool: PgPool) -> None:
    """`LocationStore.move` clears ``tray_fingerprint``: a spool moved away and back by
    hand is not held until it is linked again."""
    a, printer = _spool(pg_pool), _printer(pg_pool)
    inventory = FilamentInventory(pg_pool)
    linked = inventory.link(printer, 0, 1, a, _seen(), actor="ann")
    place = linked.location_id
    locations = LocationStore(pg_pool)
    locations.move(a, None, actor="ann")
    locations.move(a, place, actor="ann")
    with pg_pool.connection() as conn:
        row = conn.execute(
            "SELECT tray_fingerprint FROM filament_spools WHERE id = %s", (a,)
        ).fetchone()
    assert row is not None and row["tray_fingerprint"] is None
    assert _held(inventory.trays(printer, [_seen()])) is None


def test_a_tag_bound_elsewhere_refuses_the_link(pg_pool: PgPool) -> None:
    a, b, printer = _spool(pg_pool), _spool(pg_pool), _printer(pg_pool)
    FilamentSpoolStore(pg_pool).bind_tag(b, tray_uuid=UUID_A, kind="bambu_mifare", actor="ann")
    inventory = FilamentInventory(pg_pool)
    with pytest.raises(TrayTagClashError):
        inventory.link(printer, 0, 1, a, _seen(tray_uuid=UUID_A), actor="ann")
    # The tag's own spool may be placed there.
    assert inventory.link(printer, 0, 1, b, _seen(tray_uuid=UUID_A), actor="ann").id == b


def test_a_tag_uid_bound_elsewhere_refuses_the_link(pg_pool: PgPool) -> None:
    """Both keys are checked: the tray_uuid's tag is on no spool, the tag_uid's on C."""
    a, c, printer = _spool(pg_pool), _spool(pg_pool), _printer(pg_pool)
    spools = FilamentSpoolStore(pg_pool)
    spools.bind_tag(a, tray_uuid=UUID_A, kind="bambu_mifare", actor="ann")
    tag = next(t for t in spools.tags() if t.tray_uuid == UUID_A)
    spools.unbind_tag(tag.id, actor="ann")
    spools.bind_tag(c, tag_uid="0102030405060708", kind="other", actor="ann")
    with pytest.raises(TrayTagClashError):
        FilamentInventory(pg_pool).link(
            printer, 0, 1, a, _seen(tray_uuid=UUID_A, tag_uid="0102030405060708"), actor="ann"
        )


@pytest.mark.parametrize("known", [False, True])
def test_a_link_binds_the_trays_free_tag(pg_pool: PgPool, known: bool) -> None:
    """A tagged tray whose tag no spool holds (seen before or not): the link binds the tag
    to the spool in the same transaction, so the tray resolves by its tag."""
    a, b, printer = _spool(pg_pool), _spool(pg_pool), _printer(pg_pool)
    spools = FilamentSpoolStore(pg_pool)
    if known:
        spools.bind_tag(b, tray_uuid=UUID_A, kind="bambu_mifare", actor="ann")
        tag = next(t for t in spools.tags() if t.tray_uuid == UUID_A)
        spools.unbind_tag(tag.id, actor="ann")
    inventory = FilamentInventory(pg_pool)
    inventory.link(printer, 0, 1, a, _seen(tray_uuid=UUID_A), actor="ann")
    held = _holder(inventory.trays(printer, [_seen("#00FF00FF", tray_uuid=UUID_A)]))
    assert (held.spool.id if held.spool else None, held.found_by) == (a, "tag")
    assert spools.open_binding(a) is not None
    assert [e.kind for e in spools.events(a)].count("tag_bound") == 1


def _tag_kind(pool: PgPool, spool_id: UUID) -> str | None:
    with pool.connection() as conn:
        row = conn.execute(
            "SELECT t.kind FROM filament_tags t JOIN filament_tag_bindings b ON b.tag_id = t.id"
            " WHERE b.spool_id = %s AND b.unbound_at IS NULL",
            (spool_id,),
        ).fetchone()
    return None if row is None else str(row["kind"])


def test_a_link_takes_an_archived_spools_tag(pg_pool: PgPool) -> None:
    """An open binding on an archived spool does not hold the tag (as the BB pull's
    `_bind` reads it): the link rebinds it to the live spool."""
    s0, a, printer = _spool(pg_pool), _spool(pg_pool), _printer(pg_pool)
    spools = FilamentSpoolStore(pg_pool)
    spools.bind_tag(s0, tray_uuid=UUID_A, kind="bambu_mifare", actor="ann")
    with pg_pool.connection() as conn:
        conn.execute("UPDATE filament_spools SET archived_at = now() WHERE id = %s", (s0,))
    inventory = FilamentInventory(pg_pool)
    inventory.link(printer, 0, 1, a, _seen(tray_uuid=UUID_A), actor="ann")
    assert spools.open_binding(s0) is None
    assert spools.open_binding(a) is not None
    unbound = [e for e in spools.events(s0) if e.kind == "tag_unbound"]
    assert [e.data.get("reason") for e in unbound] == ["rebound"]
    held = _holder(inventory.trays(printer, [_seen(tray_uuid=UUID_A)]))
    assert (held.spool.id if held.spool else None, held.found_by) == (a, "tag")


def test_a_link_rebinds_a_spool_to_the_trays_tag(pg_pool: PgPool) -> None:
    """Ruling: the tray's reading is the spool's tag; one tag per spool."""
    a, printer = _spool(pg_pool), _printer(pg_pool)
    spools = FilamentSpoolStore(pg_pool)
    spools.bind_tag(a, tag_uid="04AABBCCDD", kind="ntag_openspool", actor="ann")
    FilamentInventory(pg_pool).link(printer, 0, 1, a, _seen(tray_uuid=UUID_A), actor="ann")
    tags = {t.tag_uid or t.tray_uuid: t for t in spools.tags(include_unbound=True)}
    assert tags["04AABBCCDD"].binding is None
    assert tags[UUID_A].binding is not None and tags[UUID_A].spool_number is not None
    unbound = [e for e in spools.events(a) if e.kind == "tag_unbound"]
    assert [e.data.get("reason") for e in unbound] == ["rebound"]


def test_a_tag_uid_only_tray_binds_an_other_tag(pg_pool: PgPool) -> None:
    a, printer = _spool(pg_pool), _printer(pg_pool)
    inventory = FilamentInventory(pg_pool)
    inventory.link(printer, 0, 1, a, _seen(tag_uid="0102030405060708"), actor="ann")
    assert _tag_kind(pg_pool, a) == "other"
    held = _holder(inventory.trays(printer, [_seen(tag_uid="0102030405060708")]))
    assert held.found_by == "tag"


def test_two_links_to_one_tray_serialise(pg_pool: PgPool) -> None:
    """The tray's advisory lock: links racing for one tray leave one holder."""
    spools = [_spool(pg_pool) for _ in range(3)]
    printer = _printer(pg_pool)
    inventory = FilamentInventory(pg_pool)
    # Three threads on the test pool's four connections: each link holds one at a time.
    with ThreadPoolExecutor(3) as workers:
        list(workers.map(lambda s: inventory.link(printer, 0, 1, s, _seen(), actor="ann"), spools))
    with pg_pool.connection() as conn:
        placed = conn.execute(
            "SELECT count(*) AS n FROM filament_spools s JOIN filament_locations l"
            " ON l.id = s.location_id WHERE l.printer_id = %s",
            (printer,),
        ).fetchone()
    assert placed is not None and placed["n"] == 1


def test_an_unfilled_tray_refuses_the_link(pg_pool: PgPool) -> None:
    a, printer = _spool(pg_pool), _printer(pg_pool)
    with pytest.raises(TrayNotFilledError):
        FilamentInventory(pg_pool).link(
            printer, 0, 1, a, SeenTray(ams_id=0, tray_id=1, material=""), actor="ann"
        )


def test_an_unknown_spool_or_printer_is_a_lookup_error(pg_pool: PgPool) -> None:
    inventory = FilamentInventory(pg_pool)
    with pytest.raises(LookupError):
        inventory.link(_printer(pg_pool), 0, 1, uuid4(), _seen(), actor="ann")
    with pytest.raises(LookupError):
        inventory.link(uuid4(), 0, 1, _spool(pg_pool), _seen(), actor="ann")


def test_unlink_moves_the_spool_to_no_place(pg_pool: PgPool) -> None:
    a, printer = _spool(pg_pool), _printer(pg_pool)
    inventory = FilamentInventory(pg_pool)
    inventory.link(printer, 0, 1, a, _seen(), actor="ann")
    inventory.unlink(printer, 0, 1, actor="ann")
    spool = FilamentSpoolStore(pg_pool).get(a)
    assert spool is not None and spool.location_id is None
    assert _moves(pg_pool, a) == 2
    inventory.unlink(printer, 0, 1, actor="ann")
    assert _moves(pg_pool, a) == 2


def test_the_shelf_leaves_out_what_another_printers_report_holds(pg_pool: PgPool) -> None:
    """F6: a spool another printer's latest report resolves as held is not on this
    printer's shelf."""
    a, b = _spool(pg_pool), _spool(pg_pool)
    FilamentSpoolStore(pg_pool).bind_tag(a, tray_uuid=UUID_A, kind="bambu_mifare", actor="ann")
    other, printer = _printer(pg_pool), _printer(pg_pool)
    with pg_pool.connection() as conn:
        conn.execute("UPDATE printers SET lan_host = '10.0.0.9' WHERE id = %s", (other,))
    report = {
        "ams": {
            "ams": [
                {
                    "id": "0",
                    "tray": [
                        {
                            "id": "0",
                            "tray_type": "PLA",
                            "tray_color": "000000FF",
                            "state": 11,
                            "tray_uuid": UUID_A,
                        }
                    ],
                }
            ]
        }
    }
    PrinterReportStore(pg_pool).put(str(other), report, datetime.now(UTC))
    view = FilamentInventory(pg_pool).trays(printer, [_seen()])
    assert [s.id for s in view.shelf] == [b]


def test_the_summary_counts_spools_in_a_tray_place(pg_pool: PgPool) -> None:
    a, printer = _spool(pg_pool), _printer(pg_pool)
    _spool(pg_pool)
    spools = FilamentSpoolStore(pg_pool)
    assert spools.summary().loaded == 0
    FilamentInventory(pg_pool).link(printer, 0, 1, a, _seen(), actor="ann")
    assert spools.summary().loaded == 1
