"""ScadBuddy spools as the Bambuddy path's picker reads them (#6262 Task 7).

`rows_of` turns Bambuddy's recorded spools and assignments into
`FilamentInventorySpool` rows in memory, for the tests that drive the join without
Postgres; `seed_sb_spools` and `seed_app_sb_spools` write them to a store. Either way
each SB spool is numbered as its Bambuddy spool's id and linked to it, so a recording's
ids read the same on both sides."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
from psycopg import sql

from scadbuddy.api.deps import STATE_ATTR, AppState
from scadbuddy.bambuddy.models import Spool as BbSpool
from scadbuddy.bambuddy.models import SpoolAssignment
from scadbuddy.filament.bambuddy_pull import pull
from scadbuddy.filament.component import FILAMENT, Filament
from scadbuddy.filament.models import FilamentInventorySpool, Spool, SpoolPresetCreate, TrayPlace
from tests.bambuddy.conftest import recording

NOW = datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
#: The H2C nozzle sizes a seeded spool gets a preset for.
NOZZLE_SIZES = ("0.2", "0.4", "0.6", "0.8")

_NO_VALUES = dict.fromkeys(
    name for name, field in Spool.model_fields.items() if field.is_required()
)


def sb_spool(
    number: int,
    *,
    material: str | None = "PLA",
    subtype: str | None = None,
    brand: str | None = None,
    rgba: str | None = "#000000FF",
    colour_name: str | None = None,
    grams: float | None = 640.0,
    label_weight_g: int | None = 1000,
    archived: bool = False,
) -> Spool:
    """SB spool #``number`` of a type, its values the effective ones."""
    return Spool.model_validate(
        _NO_VALUES
        | {
            "id": uuid4(),
            "created_at": NOW,
            "updated_at": NOW,
            "number": number,
            "type_id": uuid4(),
            "weight_locked": False,
            "grams_left": grams,
            "archived_at": NOW if archived else None,
            "effective": {
                "rgba": rgba,
                "colour_name": colour_name,
                "label_weight_g": label_weight_g,
            },
            "names": {"brand": brand, "material": material, "subtype": subtype},
        }
    )


def rows_of(
    spools: Sequence[BbSpool], assignments: Sequence[SpoolAssignment] = ()
) -> list[FilamentInventorySpool]:
    """Bambuddy's ``spools`` as SB spools numbered by their Bambuddy id and linked to it,
    each in the tray its last assignment names (the registry's printer id unknown)."""
    placed = {assignment.spool_id: assignment for assignment in assignments}
    rows: list[FilamentInventorySpool] = []
    for bb in spools:
        where = placed.get(bb.id)
        rows.append(
            FilamentInventorySpool(
                spool=sb_spool(
                    bb.id,
                    material=bb.material,
                    subtype=bb.subtype,
                    brand=bb.brand,
                    rgba=f"#{bb.rgba}" if bb.rgba else None,
                    colour_name=bb.color_name,
                    grams=bb.remaining_g,
                    label_weight_g=bb.label_weight or None,
                    archived=bb.archived_at is not None,
                ),
                loaded=None
                if where is None
                else TrayPlace(
                    printer_id=None,
                    bambuddy_printer_id=where.printer_id,
                    printer_name=where.printer_name,
                    ams_id=where.ams_id,
                    tray_id=where.tray_id,
                ),
                bb_spool_id=bb.id,
            )
        )
    return rows


def seed_sb_spools(filament: Filament, spools: Sequence[BbSpool]) -> None:
    """Pull Bambuddy's ``spools`` into SB spools (`bambuddy_pull.pull`), each numbered
    as its Bambuddy id and linked to it, so an API test's recorded ids name the same
    spools on the Bambuddy path's picker (#6262 Task 7). The numbering restarts the
    identity before each spool; only a test database may be seeded. Tags are left off: the
    recordings redact every tag to one value, which would make each spool after the first
    the first one again. A spool Bambuddy names a ``slicer_filament`` for gets it as its
    own H2C preset at every nozzle size, the preset the Bambuddy path read from it before
    #6262 Task 7 (the pull does not carry it over: see the task's report)."""
    for bb in sorted(spools, key=lambda spool: spool.id):
        with filament.spools.transaction() as conn:
            conn.execute(
                sql.SQL("ALTER TABLE filament_spools ALTER COLUMN number RESTART WITH {}").format(
                    sql.Literal(bb.id)
                )
            )
        pull(filament, [bb.model_copy(update={"tag_uid": None, "tray_uuid": None})], now=NOW)
        found = filament.inventory.by_number(bb.id)
        assert found is not None and found[1] == bb.id, bb.id
        if bb.slicer_filament:
            rows = [
                SpoolPresetCreate(
                    printer_model="H2C",
                    nozzle_diameter=size,
                    slicer_filament=bb.slicer_filament,
                    slicer_filament_name=bb.slicer_filament_name,
                )
                for size in NOZZLE_SIZES
            ]
            assert filament.spools.set_presets(found[0], rows, actor="test") is not None


def seed_app_sb_spools(client: TestClient, rows: Sequence[dict[str, Any]] | None = None) -> None:
    """:func:`seed_sb_spools` into the app's own store: Bambuddy's spool rows ``rows``,
    else the recorded inventory (``inventory-spools.json``)."""
    state: AppState = getattr(client.app.state, STATE_ATTR)  # type: ignore[attr-defined]
    listed = recording("inventory-spools.json") if rows is None else rows
    seed_sb_spools(state.components.get(FILAMENT), [BbSpool.model_validate(r) for r in listed])


def drop_app_sb_presets(client: TestClient, numbers: Sequence[int]) -> None:
    """SB spools ``numbers`` with no presets of their own, so a plan falls back to their
    Bambuddy spools' (`resolve_plates`' ``bb_spools`` read)."""
    state: AppState = getattr(client.app.state, STATE_ATTR)  # type: ignore[attr-defined]
    filament: Filament = state.components.get(FILAMENT)
    for number in numbers:
        found = filament.inventory.by_number(number)
        assert found is not None, number
        assert filament.spools.set_presets(found[0], [], actor="test") is not None


class FakeSbRows:
    """`filaments.SbRows` over fixed rows: ``rows`` answers them whatever Bambuddy assigns
    (they carry their trays already), and ``bb_to_sb`` maps each row's Bambuddy id."""

    def __init__(self, rows: Sequence[FilamentInventorySpool]) -> None:
        self._rows = list(rows)
        self.assignments: list[Sequence[SpoolAssignment]] = []

    async def rows(self, bb_assignments: Sequence[SpoolAssignment]) -> list[FilamentInventorySpool]:
        self.assignments.append(bb_assignments)
        return list(self._rows)

    async def bb_to_sb(self, ids: Sequence[int]) -> dict[int, int]:
        links = {row.bb_spool_id: row.spool.number for row in self._rows if row.bb_spool_id}
        return {bb_id: links[bb_id] for bb_id in ids if bb_id in links}
