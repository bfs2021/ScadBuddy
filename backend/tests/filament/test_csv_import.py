"""The spools' CSV import (#6262 Task 15, F24, F25): rows a browser parsed from a file,
previewed with ``dry_run`` and written in one transaction."""

from __future__ import annotations

from uuid import UUID

import pytest

from scadbuddy.filament.catalog import CatalogStore
from scadbuddy.filament.component import Filament
from scadbuddy.filament.csv_import import (
    COLUMNS,
    DERIVED_COLUMNS,
    CsvRow,
    ImportRefusedError,
    import_rows,
)
from scadbuddy.filament.inventory import FilamentInventory
from scadbuddy.filament.locations import LocationStore
from scadbuddy.filament.models import (
    Brand,
    LocationCreate,
    LocationKind,
    LocationPatch,
    Material,
    SpoolCreate,
)
from scadbuddy.filament.presets import PoolSpoolPresets
from scadbuddy.filament.spools import FilamentSpoolStore
from scadbuddy.filament.types import SpoolTypeStore
from tests.conftest import PgPool

pytestmark = pytest.mark.requires_postgres


def _filament(pool: PgPool) -> Filament:
    return Filament(
        catalog=CatalogStore(pool),
        types=SpoolTypeStore(pool),
        spools=FilamentSpoolStore(pool),
        locations=LocationStore(pool),
        inventory=FilamentInventory(pool),
        presets=PoolSpoolPresets(pool),
    )


def _material(f: Filament, name: str = "PLA") -> UUID:
    rows = f.catalog.list("materials")
    return next(r.id for r in rows if isinstance(r, Material) and r.name == name)


def _spool(f: Filament, **over: object) -> int:
    body = SpoolCreate.model_validate({"material_id": _material(f)} | over)
    return f.spools.create(body, actor="ann").number


def _count(pool: PgPool, table: str) -> int:
    with pool.connection() as conn:
        row = conn.execute(f"SELECT count(*) AS n FROM {table}").fetchone()
    assert row is not None
    return int(row["n"])


def _place(f: Filament, name: str, parent: UUID | None = None) -> UUID:
    kind = next(r.id for r in f.catalog.list("location-kinds") if isinstance(r, LocationKind))
    return f.locations.create(LocationCreate(name=name, kind_id=kind, parent_id=parent)).id


def _by_number(f: Filament, number: int) -> UUID:
    found = next(s for s in f.spools.list(include_archived=True) if s.number == number)
    return found.id


def test_columns_are_the_csv_row_fields() -> None:
    assert list(CsvRow.model_fields) == COLUMNS
    assert "number" in COLUMNS and "location" in COLUMNS
    assert not set(DERIVED_COLUMNS) & set(COLUMNS)


def test_a_dry_run_writes_nothing(pg_pool: PgPool) -> None:
    f = _filament(pg_pool)
    number = _spool(f, note="old")
    brands = _count(pg_pool, "filament_brands")
    rows = [
        CsvRow(material="PLA", brand="Sunlu", colour_name="Red", rgba="#ff0000"),
        CsvRow(number=str(number), note="new"),
    ]
    preview = import_rows(f, rows, dry_run=True, actor="ann")
    assert [(r.line, r.action, r.number, r.error) for r in preview.rows] == [
        (2, "create", None, None),
        (3, "update", number, None),
    ]
    assert preview.rows[0].changes["brand"] == [None, "Sunlu", {"new": True}]
    assert preview.rows[0].changes["rgba"] == [None, "#FF0000FF"]
    assert preview.rows[1].changes == {"note": ["old", "new"]}
    assert len(f.spools.list()) == 1
    assert _count(pg_pool, "filament_brands") == brands
    assert f.spools.list()[0].note == "old"


def test_a_row_with_a_number_updates_only_what_differs(pg_pool: PgPool) -> None:
    f = _filament(pg_pool)
    number = _spool(f, note="old", colour_name="Red", label_weight_g=1000)
    rows = [
        CsvRow(
            number=str(number), material="pla", colour_name="Red", label_weight_g="1000", note="new"
        )
    ]
    done = import_rows(f, rows, dry_run=False, actor="ann")
    assert [(r.action, r.changes) for r in done.rows] == [("update", {"note": ["old", "new"]})]
    events = f.spools.events(_by_number(f, number))
    assert [e.kind for e in events] == ["created", "edited"]
    assert events[1].data == {"changes": {"note": ["old", "new"]}}
    assert events[1].actor == "ann"


def test_an_unknown_number_is_an_error_and_blocks_the_import(pg_pool: PgPool) -> None:
    f = _filament(pg_pool)
    rows = [CsvRow(material="PLA"), CsvRow(number="999", note="x")]
    preview = import_rows(f, rows, dry_run=True, actor="ann")
    assert [r.action for r in preview.rows] == ["create", "error"]
    assert preview.rows[1].error == "no spool #999"
    with pytest.raises(ImportRefusedError) as refused:
        import_rows(f, rows, dry_run=False, actor="ann")
    assert [r.line for r in refused.value.preview.rows if r.action == "error"] == [3]
    assert f.spools.list() == []


def test_a_missing_catalog_name_is_inserted_once(pg_pool: PgPool) -> None:
    f = _filament(pg_pool)
    rows = [CsvRow(material="PLA", brand="Sunlu"), CsvRow(material="PLA", brand="SUNLU")]
    done = import_rows(f, rows, dry_run=False, actor="ann")
    assert [r.action for r in done.rows] == ["create", "create"]
    assert all(r.number is not None for r in done.rows)
    brands = f.catalog.list("brands")
    sunlu = [r for r in brands if isinstance(r, Brand) and r.name.upper() == "SUNLU"]
    assert len(sunlu) == 1
    assert {s.brand_id for s in f.spools.list()} == {sunlu[0].id}


def test_a_location_is_a_move_and_must_exist(pg_pool: PgPool) -> None:
    f = _filament(pg_pool)
    shelf = _place(f, "Shelf A")
    gone = _place(f, "Old")
    f.locations.update(gone, LocationPatch(archived=True))
    number = _spool(f)
    rows = [CsvRow(number=str(number), location="shelf a")]
    done = import_rows(f, rows, dry_run=False, actor="ann")
    assert done.rows[0].changes == {"location": [None, "Shelf A"]}
    events = f.spools.events(_by_number(f, number))
    assert [e.kind for e in events] == ["created", "moved"]
    assert events[1].data == {"from": None, "to": str(shelf)}
    for name in ("Nowhere", "Old"):
        preview = import_rows(
            f, [CsvRow(number=str(number), location=name)], dry_run=True, actor="ann"
        )
        assert preview.rows[0].action == "error"
        assert preview.rows[0].error == f"no location named {name!r}"
    room, hall = _place(f, "Room"), _place(f, "Hall")
    _place(f, "Box", room)
    _place(f, "Box", hall)
    twice = import_rows(f, [CsvRow(number=str(number), location="Box")], dry_run=True, actor="ann")
    assert twice.rows[0].error == "2 locations are named 'Box'; rename one"


def test_derived_columns_are_ignored(pg_pool: PgPool) -> None:
    f = _filament(pg_pool)
    number = _spool(f, grams_left=500)
    row = CsvRow.model_validate(
        {"number": str(number), "grams_left": "12", "last_used_at": "2026-01-01", "low_stock": "x"}
    )
    done = import_rows(f, [row], dry_run=False, actor="ann")
    assert [(r.action, r.changes) for r in done.rows] == [("update", {})]
    assert f.spools.list()[0].grams_left == 500
    assert set(DERIVED_COLUMNS) >= {"grams_left", "last_used_at", "low_stock"}


def test_an_unknown_column_is_refused() -> None:
    with pytest.raises(ValueError, match="colour"):
        CsvRow.model_validate({"colour": "red"})


def test_a_bad_cell_is_a_row_error(pg_pool: PgPool) -> None:
    f = _filament(pg_pool)
    rows = [
        CsvRow(material="PLA", rgba="red"),
        CsvRow(brand="Sunlu"),
        CsvRow(material="PLA", insert_type="Nonesuch core"),
    ]
    preview = import_rows(f, rows, dry_run=True, actor="ann")
    assert [r.action for r in preview.rows] == ["error", "error", "error"]
    assert preview.rows[0].error is not None and "rgba" in preview.rows[0].error
    assert preview.rows[1].error == "a new spool needs a type or a material"
    assert preview.rows[2].error is not None and "insert type" in preview.rows[2].error


def test_a_blank_cell_changes_nothing(pg_pool: PgPool) -> None:
    f = _filament(pg_pool)
    number = _spool(f, note="keep")
    row = CsvRow.model_validate({"number": str(number), "note": "", "colour_name": " "})
    done = import_rows(f, [row], dry_run=False, actor="ann")
    assert done.rows[0].changes == {}
    assert f.spools.list()[0].note == "keep"
