"""A spool's slicer presets and K values over its type's (#6262, spec §5.3): the spool's
own row for a key replaces the type's row of that key, and a key only the spool has is
kept. A key is a printer model and nozzle diameter for a preset, and a printer, extruder
and nozzle diameter for a K value. A preset row for any printer or nozzle (``*``) is
refused: the 0706Z migration made each one a ``migrated`` row per model and nozzle, as the
native API's write (`spools/native.py`) does.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, get_args
from uuid import UUID

from psycopg import Connection
from psycopg.rows import DictRow

from scadbuddy.bambuddy.models import NozzleSize
from scadbuddy.bambuddy.resolver import PRINTER_MODEL
from scadbuddy.filament import models as m

Conn = Connection[DictRow]

_PRESET_COLUMNS = ", ".join(m.SpoolPreset.model_fields)
_K_COLUMNS = ", ".join(m.SpoolKValue.model_fields)
_TYPE_PRESET_COLUMNS = ", ".join(m.TypePreset.model_fields)
_TYPE_K_COLUMNS = ", ".join(m.TypeKValue.model_fields)

#: The nozzle diameters a row for any nozzle becomes: the resolver's sizes.
NOZZLES: tuple[str, ...] = get_args(NozzleSize)
#: The printer models a row for any printer becomes, as the 0706Z migration picks them:
#: the resolver's model and each registry printer's, trimmed and upper-cased.
_MODELS = (
    "SELECT %s AS model UNION SELECT upper(btrim(model)) FROM printers"
    " WHERE nullif(btrim(model), '') IS NOT NULL"
)


def any_printer_keys(conn: Conn) -> list[tuple[str, str]]:
    """The keys a preset for any printer and nozzle is kept under: each model of
    `_MODELS` with each of `NOZZLES`, by model and nozzle."""
    rows = conn.execute(f"SELECT model FROM ({_MODELS}) k ORDER BY model", (PRINTER_MODEL,))
    return [(row["model"], nozzle) for row in rows.fetchall() for nozzle in NOZZLES]


def drop_migrated(conn: Conn, spool_id: UUID) -> list[list[dict[str, Any]]] | None:
    """Delete the spool's ``migrated`` preset rows, so its type's presets show: what a
    spool that needed a type does when it is first given one (#6262 F27). The spool's own
    rows ``[before, after]``, for its ``edited`` event; ``None`` when it had none."""
    before = own_presets(conn, spool_id)
    gone = conn.execute(
        "DELETE FROM filament_spool_presets WHERE spool_id = %s AND migrated", (spool_id,)
    ).rowcount
    return [before, own_presets(conn, spool_id)] if gone else None


def own_presets(conn: Conn, spool_id: UUID) -> list[dict[str, Any]]:
    """The spool's own preset rows, by key."""
    return conn.execute(
        f"SELECT {_PRESET_COLUMNS} FROM filament_spool_presets WHERE spool_id = %s"
        " ORDER BY printer_model, nozzle_diameter",
        (spool_id,),
    ).fetchall()


def own_k_values(conn: Conn, spool_id: UUID) -> list[dict[str, Any]]:
    """The spool's own K-value rows, by key."""
    return conn.execute(
        f"SELECT {_K_COLUMNS} FROM filament_spool_k_values WHERE spool_id = %s"
        " ORDER BY printer_id, extruder, nozzle_diameter",
        (spool_id,),
    ).fetchall()


def _type_id(conn: Conn, spool_id: UUID) -> UUID | None:
    row = conn.execute("SELECT type_id FROM filament_spools WHERE id = %s", (spool_id,)).fetchone()
    return None if row is None else row["type_id"]


def effective_presets(conn: Conn, spool_id: UUID) -> list[m.EffectivePreset]:
    """The type's presets, each replaced by the spool's row of the same key, then the
    spool's rows of keys the type lacks; by printer model and nozzle diameter."""
    type_id = _type_id(conn, spool_id)
    rows: dict[tuple[str, str], tuple[dict[str, Any], bool]] = {}
    if type_id is not None:
        for row in conn.execute(
            f"SELECT {_TYPE_PRESET_COLUMNS} FROM filament_spool_type_presets WHERE type_id = %s",
            (type_id,),
        ).fetchall():
            rows[row["printer_model"], row["nozzle_diameter"]] = (row, False)
    for row in own_presets(conn, spool_id):
        rows[row["printer_model"], row["nozzle_diameter"]] = (row, True)
    return [
        m.EffectivePreset(
            printer_model=row["printer_model"],
            nozzle_diameter=row["nozzle_diameter"],
            slicer_filament=row["slicer_filament"],
            slicer_filament_name=row["slicer_filament_name"],
            overridden=own,
        )
        for _, (row, own) in sorted(rows.items())
    ]


def effective_k_values(conn: Conn, spool_id: UUID) -> list[m.EffectiveKValue]:
    """The type's K values, each replaced by the spool's row of the same key, then the
    spool's rows of keys the type lacks; by printer, extruder and nozzle diameter."""
    type_id = _type_id(conn, spool_id)
    rows: dict[tuple[str, int, str], tuple[dict[str, Any], bool]] = {}
    if type_id is not None:
        for row in conn.execute(
            f"SELECT {_TYPE_K_COLUMNS} FROM filament_spool_type_k_values WHERE type_id = %s",
            (type_id,),
        ).fetchall():
            rows[str(row["printer_id"]), row["extruder"], row["nozzle_diameter"]] = (row, False)
    for row in own_k_values(conn, spool_id):
        rows[str(row["printer_id"]), row["extruder"], row["nozzle_diameter"]] = (row, True)
    return [
        m.EffectiveKValue(
            printer_id=row["printer_id"],
            extruder=row["extruder"],
            nozzle_diameter=row["nozzle_diameter"],
            nozzle_type=row["nozzle_type"],
            k_value=row["k_value"],
            name=row["name"],
            cali_idx=row["cali_idx"],
            setting_id=row["setting_id"],
            overridden=own,
        )
        for _, (row, own) in sorted(rows.items())
    ]


def preset_for(
    presets: Sequence[m.EffectivePreset], printer_model: str, nozzle_diameter: str
) -> m.EffectivePreset | None:
    """The preset of exactly this printer model and nozzle diameter; ``None`` when there
    is none. A near key (0.4 for 0.2) is never taken."""
    for preset in presets:
        if preset.printer_model == printer_model and preset.nozzle_diameter == nozzle_diameter:
            return preset
    return None
