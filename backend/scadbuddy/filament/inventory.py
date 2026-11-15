"""Which SB spool is in each AMS tray (#6262 Task 4, spec
2026-11-14-filament-management-design.md §5.3 "current tray").

A tray is resolved from what the printer's latest report shows in it (`SeenTray`): the
spool whose tag the tray reports, by an open binding of its ``tray_uuid``, then of its
``tag_uid``; else, for an untagged tray, the spool a person placed at that tray (its
``location_id`` is the tray's place, a location with ``printer_id`` set) whose
``tray_fingerprint`` still equals the tray's. A tray refilled with another material or
colour then holds no spool, and the dialog asks about it again (plan Review Focus 3).
The fingerprint keeps the alpha byte (`SeenTray.rgba`, from the report's
``tray_color``), so a translucent tray never holds an opaque spool (spec §5.1).

The shelf is every unarchived spool that no printer's latest report resolves as held
(plan F6): a spool placed at a tray whose report no longer matches is on the shelf.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from psycopg import Connection
from psycopg.rows import DictRow
from psycopg_pool import ConnectionPool
from pydantic import BaseModel

from scadbuddy.bambuddy.trays import seen_trays, tray_label
from scadbuddy.filament import models as m
from scadbuddy.filament.colour import normalise_rgba
from scadbuddy.filament.locations import LocationStore
from scadbuddy.filament.spools import FilamentSpoolStore
from scadbuddy.printers.reports import PrinterReportStore, report_status
from scadbuddy.printers.store import PrinterStore
from scadbuddy.spools.models import SeenTray, clean_tag_uid, clean_tray_uuid

Conn = Connection[DictRow]
FoundBy = Literal["tag", "link"]
#: Each tray place's spools with a fingerprint, newest placement first.
_Placed = Mapping[tuple[UUID, int, int], list[tuple[UUID, str]]]


class TrayNotFilledError(ValueError):
    """The printer's latest report does not show the tray filled."""

    def __init__(self) -> None:
        super().__init__("the printer's last report does not show that tray filled")


class TrayTagClashError(ValueError):
    """The tray reports a tag that is bound to another spool."""

    def __init__(self) -> None:
        super().__init__("the tray's tag is on another spool; that spool is the tray's")


def tray_fingerprint(material: str | None, colour: str | None) -> str:
    """``MATERIAL|#RRGGBBAA``: what a person saw in the tray when they placed a spool
    there. The material upper-cased and stripped; the colour as `normalise_rgba` writes
    it, alpha included, or nothing after the ``|`` for no colour (plan F6). Never the
    tray's ``state``, which changes as the AMS feeds."""
    part = normalise_rgba(colour) if colour else ""
    return f"{(material or '').strip().upper()}|{part}"


class TrayHolder(BaseModel):
    """One reported tray and the SB spool in it, with how it was found."""

    ams_id: int
    tray_id: int
    spool: m.Spool | None
    found_by: FoundBy | None


class TrayView(BaseModel):
    """A printer's reported trays, and the unarchived spools no printer holds."""

    trays: list[TrayHolder]
    shelf: list[m.Spool]


class _Keys:
    """The open tag bindings and the tray placements, read once."""

    def __init__(self, conn: Conn) -> None:
        self.by_tray_uuid: dict[str, UUID] = {}
        self.by_tag_uid: dict[str, UUID] = {}
        for row in conn.execute(
            "SELECT t.tray_uuid, t.tag_uid, b.spool_id FROM filament_tags t"
            " JOIN filament_tag_bindings b ON b.tag_id = t.id AND b.unbound_at IS NULL"
            " JOIN filament_spools s ON s.id = b.spool_id AND s.archived_at IS NULL"
        ).fetchall():
            if row["tray_uuid"] is not None:
                self.by_tray_uuid[row["tray_uuid"]] = row["spool_id"]
            if row["tag_uid"] is not None:
                self.by_tag_uid[row["tag_uid"]] = row["spool_id"]
        placed: dict[tuple[UUID, int, int], list[tuple[UUID, str]]] = {}
        for row in conn.execute(
            "SELECT s.id, s.tray_fingerprint, l.printer_id, l.ams_id, l.tray_id"
            " FROM filament_spools s JOIN filament_locations l ON l.id = s.location_id"
            " WHERE l.printer_id IS NOT NULL AND l.archived_at IS NULL"
            " AND s.archived_at IS NULL AND s.tray_fingerprint IS NOT NULL"
            " ORDER BY s.updated_at DESC, s.id"
        ).fetchall():
            key = (row["printer_id"], row["ams_id"], row["tray_id"])
            placed.setdefault(key, []).append((row["id"], row["tray_fingerprint"]))
        self.placed: _Placed = placed

    def hold(self, printer_id: UUID, tray: SeenTray) -> tuple[UUID | None, FoundBy | None]:
        """The spool in ``tray`` of ``printer_id`` and how it was found."""
        if tray.tray_uuid is not None and tray.tray_uuid in self.by_tray_uuid:
            return self.by_tray_uuid[tray.tray_uuid], "tag"
        if tray.tag_uid is not None and tray.tag_uid in self.by_tag_uid:
            return self.by_tag_uid[tray.tag_uid], "tag"
        if tray.tray_uuid is not None or tray.tag_uid is not None:
            return None, None
        fingerprint = tray_fingerprint(tray.material, tray.rgba or tray.colour)
        for spool_id, stored in self.placed.get((printer_id, tray.ams_id, tray.tray_id), []):
            if stored == fingerprint:
                return spool_id, "link"
        return None, None


class FilamentInventory:
    """The SB tray resolution over a pool whose connections autocommit and return dict
    rows (the settings store's). Synchronous: callers run it in a thread."""

    def __init__(self, pool: ConnectionPool[Conn]) -> None:
        self._pool = pool
        self._spools = FilamentSpoolStore(pool)
        self._locations = LocationStore(pool)

    def trays(self, printer_id: UUID, seen: Sequence[SeenTray]) -> TrayView:
        """``seen`` (``printer_id``'s reported trays) with the SB spool each holds, and
        the shelf. Every other registry printer's latest report is resolved too, so a
        spool another printer holds is not on the shelf."""
        with self._pool.connection() as conn:
            keys = _Keys(conn)
        held = {
            spool_id
            for other, trays in self._others(printer_id)
            for spool_id, _ in (keys.hold(other, tray) for tray in trays)
            if spool_id is not None
        }
        own = [(tray, *keys.hold(printer_id, tray)) for tray in seen]
        held |= {spool_id for _, spool_id, _ in own if spool_id is not None}
        spools = {spool.id: spool for spool in self._spools.list()}
        return TrayView(
            trays=[
                TrayHolder(
                    ams_id=tray.ams_id,
                    tray_id=tray.tray_id,
                    spool=None if spool_id is None else spools.get(spool_id),
                    found_by=found_by if spool_id in spools else None,
                )
                for tray, spool_id, found_by in own
            ],
            shelf=[spool for spool in spools.values() if spool.id not in held],
        )

    def link(
        self,
        printer_id: UUID,
        ams_id: int,
        tray_id: int,
        spool_id: UUID,
        seen: SeenTray,
        *,
        actor: str,
    ) -> m.Spool:
        """Place ``spool_id`` in the tray, remembering what ``seen`` shows there. The
        tray's previous holder moves to no place first, then the spool moves to the
        tray's place (`LocationStore.ensure_ams`), each with one ``moved`` event.

        A tagged tray whose tag is on no spool (or not yet known) gets that tag bound to
        the spool in the same transaction (`FilamentSpoolStore.bind_on`), so the tray
        then resolves by its tag.

        `TrayNotFilledError` when ``seen`` is not that tray filled; `TrayTagClashError`
        when either of the tray's tags is bound to another spool; `LookupError` for no
        such printer, or no such unarchived spool.

        Locks, in this order: the tray's advisory lock (`_tray_lock`), so two links or
        unlinks of one tray take turns; the tray's tags (#6261: every writer of bindings
        takes the tag first); the spools by id; then the place, ``FOR SHARE`` in
        `LocationStore.move_on`, after its spool, as `LocationStore.move` does. The
        place's row is never locked ``FOR UPDATE`` here, which would invert that order."""
        material = (seen.material or "").strip()
        if (seen.ams_id, seen.tray_id) != (ams_id, tray_id) or not material:
            raise TrayNotFilledError()
        with self._pool.connection() as conn:
            printer = conn.execute(
                "SELECT name FROM printers WHERE id = %s", (printer_id,)
            ).fetchone()
        if printer is None:
            raise LookupError(f"no printer {printer_id}")
        place = self._locations.ensure_ams(
            printer_id, ams_id, tray_id, label=f"{printer['name']} {tray_label(ams_id, tray_id)}"
        )
        with self._pool.connection() as conn, conn.transaction():
            _tray_lock(conn, printer_id, ams_id, tray_id)
            self._no_tag_clash(conn, seen, spool_id)
            rows = conn.execute(
                "SELECT id, location_id, archived_at FROM filament_spools"
                " WHERE id = %s OR location_id = %s ORDER BY id FOR UPDATE",
                (spool_id, place.id),
            ).fetchall()
            spool = next((row for row in rows if row["id"] == spool_id), None)
            if spool is None or spool["archived_at"] is not None:
                raise LookupError(f"no spool {spool_id}")
            for row in rows:
                if row["id"] != spool_id:
                    LocationStore.move_on(conn, row["id"], None, actor=actor)
            LocationStore.move_on(conn, spool_id, place.id, actor=actor)
            uid, tray = clean_tag_uid(seen.tag_uid), clean_tray_uuid(seen.tray_uuid)
            if uid is not None or tray is not None:
                kind: m.TagKind = "bambu_mifare" if tray is not None else "other"
                FilamentSpoolStore.bind_on(conn, spool_id, uid, tray, kind, False, actor)
            conn.execute(
                "UPDATE filament_spools SET tray_fingerprint = %s WHERE id = %s",
                (tray_fingerprint(material, seen.rgba or seen.colour), spool_id),
            )
            linked = FilamentSpoolStore.read(conn, spool_id)
        assert linked is not None
        return linked

    def unlink(self, printer_id: UUID, ams_id: int, tray_id: int, *, actor: str) -> None:
        """Move every spool in the tray's place to no place, each with a ``moved``
        event. Nothing is written for a tray with no place or no spool. Takes the tray's
        advisory lock first, then the spools, as `link` does."""
        with self._pool.connection() as conn, conn.transaction():
            _tray_lock(conn, printer_id, ams_id, tray_id)
            rows = conn.execute(
                "SELECT s.id FROM filament_spools s JOIN filament_locations l"
                " ON l.id = s.location_id WHERE l.printer_id = %s AND l.ams_id = %s"
                " AND l.tray_id = %s AND l.archived_at IS NULL ORDER BY s.id FOR UPDATE OF s",
                (printer_id, ams_id, tray_id),
            ).fetchall()
            for row in rows:
                LocationStore.move_on(conn, row["id"], None, actor=actor)

    # -- internals --------------------------------------------------------------------

    def _others(self, printer_id: UUID) -> list[tuple[UUID, list[SeenTray]]]:
        """Every other registry printer's trays, as its latest stored report shows them."""
        now = datetime.now(UTC)
        rows = {row.id: row for row in PrinterStore(self._pool, None).list()}
        found: list[tuple[UUID, list[SeenTray]]] = []
        for other, report in PrinterReportStore(self._pool).all().items():
            row = rows.get(other)
            if row is None or UUID(other) == printer_id:
                continue
            found.append((UUID(other), seen_trays(report_status(row, report, now=now))))
        return found

    @staticmethod
    def _no_tag_clash(conn: Conn, seen: SeenTray, spool_id: UUID) -> None:
        """`TrayTagClashError` when a tag the tray reports (its ``tray_uuid``'s or its
        ``tag_uid``'s, both checked, as `_Keys.hold` reads both) is bound to a spool other
        than ``spool_id``. Each tag found is locked."""
        for column, key in (("tray_uuid", seen.tray_uuid), ("tag_uid", seen.tag_uid)):
            if key is None:
                continue
            tag = conn.execute(
                f"SELECT id FROM filament_tags WHERE {column} = %s FOR UPDATE", (key,)
            ).fetchone()
            if tag is None:
                continue
            holder = conn.execute(
                "SELECT spool_id FROM filament_tag_bindings"
                " WHERE tag_id = %s AND unbound_at IS NULL",
                (tag["id"],),
            ).fetchone()
            if holder is not None and holder["spool_id"] != spool_id:
                raise TrayTagClashError()


def _tray_lock(conn: Conn, printer_id: UUID, ams_id: int, tray_id: int) -> None:
    """The transaction's advisory lock on one printer's tray, taken before any row lock."""
    conn.execute(
        "SELECT pg_advisory_xact_lock(hashtext(%s))",
        (f"filament_tray:{printer_id}:{ams_id}:{tray_id}",),
    )
