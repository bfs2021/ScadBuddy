"""Filament as a component (`core/components.py`): ScadBuddy's own filament inventory
(#6261, epic #6260). Every store is built over the settings store's pool."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from scadbuddy.api.components import component_dep
from scadbuddy.core.components import Component, Components, Core, Key
from scadbuddy.filament.catalog import CatalogStore
from scadbuddy.filament.inventory import FilamentInventory, PoolSbSpoolReads
from scadbuddy.filament.locations import LocationStore
from scadbuddy.filament.presets import PoolSpoolPresets
from scadbuddy.filament.print_uses import PoolPrintUses, print_use_hook
from scadbuddy.filament.spools import FilamentSpoolStore
from scadbuddy.filament.types import SpoolTypeStore


@dataclass
class Filament:
    catalog: CatalogStore
    types: SpoolTypeStore
    spools: FilamentSpoolStore
    locations: LocationStore
    inventory: FilamentInventory
    #: What a print's plan reads of SB spools' presets (#6262 F1, `resolve_plates`).
    presets: PoolSpoolPresets

    @property
    def reads(self) -> PoolSbSpoolReads:
        """Every SB spool read a print's plan makes, as the print worker's CRUD routes
        make them (`SbSpoolReads`): Bambuddy's path's picker rows among them (#6262
        Task 7)."""
        return PoolSbSpoolReads(self.inventory, self.presets)


FILAMENT: Key[Filament] = Key("filament")


def _build(core: Core, components: Components) -> Filament:
    pool = core.settings_store.pool

    def low_stock() -> int:
        # One row, read on each use: a change applies to the next read.
        return int(core.settings_store.read({"filament_low_stock_pct"})["filament_low_stock_pct"])

    # What a native print used is settled on its SB spools as the follow reads it settled
    # (#4643, #6262 Task 6); the follow is a core service and imports no feature.
    core.print_follower.on_read.append(print_use_hook(PoolPrintUses(pool)))
    return Filament(
        catalog=CatalogStore(pool),
        types=SpoolTypeStore(pool),
        spools=FilamentSpoolStore(pool, low_stock),
        locations=LocationStore(pool),
        inventory=FilamentInventory(pool, low_stock),
        presets=PoolSpoolPresets(pool),
    )


COMPONENT = Component(FILAMENT, build=_build)

FilamentDep = Annotated[Filament, component_dep(FILAMENT)]
