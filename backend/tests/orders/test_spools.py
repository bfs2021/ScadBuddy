"""An item print's spool per slot (#4251, spec 2026-10-18 §5.4 "Spools", plan
2026-11-03 Ruling 4), and the price book's import from ScadBuddy's own spools (#4253,
#6262 Task 9, F28). Every spool here is an SB spool by its ``number``; the numbers
differ from every Bambuddy id the tests name, so a fill that read a Bambuddy id as an
SB number would fail. An opaque and a translucent spool of one hue are two filaments
(#6316)."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest

from scadbuddy.bambuddy.filaments import FilamentPlan
from scadbuddy.bambuddy.models import SlotChoice
from scadbuddy.core.problems import ApiError
from scadbuddy.filament.models import EffectivePreset, FilamentInventorySpool, TrayPlace
from scadbuddy.orders.integrations import LocalDensity, SpoolDensity
from scadbuddy.orders.models import Actor, Filament, FilamentInput, QuoteLine
from scadbuddy.orders.printing import quoted_setup
from scadbuddy.orders.spool_import import import_spools, spool_groups
from scadbuddy.orders.spools import (
    ShelfSpool,
    SpoolChoiceError,
    fill_plan,
    item_plan,
    record_rgba,
    shelf_spools,
)
from scadbuddy.orders.store import OrderStore, SpoolLink
from tests.orders.test_lifecycle import BY, Shop
from tests.support.sb_rows import sb_spool

NOW = datetime(2026, 11, 3, tzinfo=UTC)
#: A registry printer's id.
PRINTER = "printer-h2c"
#: A Bambuddy id an older plan names; no SB spool the fill should take has this number.
BB_RED = 7


def filament(colour: str = "#FF0000", brand: str | None = "Bambu", alpha: int = 255) -> Filament:
    return Filament(
        id="f" + colour,
        material="PLA",
        subtype="Basic",
        brand=brand,
        colour_name=None,
        colour=colour,
        alpha=alpha,
        cost_per_kg="20",
        density_g_cm3=None,
        archived_at=None,
        created_at=NOW,
        updated_at=NOW,
    )


def spool(spool_id: int, rgba: str | None = "#FF0000FF", **fields: object) -> ShelfSpool:
    return ShelfSpool.model_validate(
        {
            "id": spool_id,
            "material": "pla",
            "subtype": "basic",
            "brand": "bambu",
            "rgba": rgba,
            "remaining_g": 500.0,
            **fields,
        }
    )


def test_the_spool_loaded_on_the_printer_is_taken_first() -> None:
    spools = [
        spool(41, remaining_g=900),
        spool(42, loaded_printer=PRINTER, remaining_g=100),
    ]
    assert fill_plan({0: filament()}, spools, PRINTER, {}) == {1: 42}


def test_else_the_shelf_spool_with_most_left() -> None:
    spools = [
        spool(41, remaining_g=200),
        spool(42, remaining_g=700),
        spool(43, archived=True, remaining_g=999),
    ]
    assert fill_plan({0: filament()}, spools, PRINTER, {}) == {1: 42}


def test_a_spool_loaded_elsewhere_is_never_taken() -> None:
    spools = [spool(41, loaded_printer="another", remaining_g=900)]
    with pytest.raises(SpoolChoiceError) as raised:
        fill_plan({0: filament()}, spools, PRINTER, {})
    assert (raised.value.slug, raised.value.slots) == ("needs_spool_choice", [0])


def test_another_filament_or_a_name_only_spool_is_not_the_slots() -> None:
    spools = [spool(41, rgba="#00FF00FF"), spool(42, rgba=None), spool(43, brand="Elegoo")]
    with pytest.raises(SpoolChoiceError) as raised:
        fill_plan({0: filament(), 1: filament("#0000FF")}, spools, PRINTER, {})
    assert raised.value.slots == [0, 1]


def test_a_supplied_spool_must_be_the_slots_filament() -> None:
    spools = [spool(41), spool(42, rgba="#00FF00FF")]
    assert fill_plan({0: filament()}, spools, PRINTER, {1: 41}) == {1: 41}
    with pytest.raises(SpoolChoiceError) as raised:
        fill_plan({0: filament()}, spools, PRINTER, {1: 42})
    assert (raised.value.slug, raised.value.slots) == ("spool_not_filament", [0])
    # One loaded elsewhere may be named by a person.
    elsewhere = [spool(45, loaded_printer="another")]
    assert fill_plan({0: filament()}, elsewhere, PRINTER, {1: 45}) == {1: 45}


def test_a_colour_set_by_hand_still_finds_its_spools() -> None:
    """#6211 review: spools are matched as the import matches them, by the record's link
    (its spool numbers, else the spools' colour), so a hand-set colour never hides them."""
    clear = filament("#EEF3F4")
    links = {clear.id: SpoolLink("#000000", frozenset({44}))}
    by_rgb = [spool(41, rgba="#000000FF", remaining_g=300)]
    assert fill_plan({0: clear}, by_rgb, PRINTER, {}, links) == {1: 41}
    by_id = [spool(44, rgba="#111111FF")]
    assert fill_plan({0: clear}, by_id, PRINTER, {}, links) == {1: 44}
    assert fill_plan({0: clear}, by_rgb, PRINTER, {1: 41}, links) == {1: 41}
    # The spool's colour, not the record's hand-set one, and never another brand's.
    with pytest.raises(SpoolChoiceError):
        fill_plan({0: clear}, [spool(42, rgba="#EEF3F4FF")], PRINTER, {}, links)
    with pytest.raises(SpoolChoiceError):
        fill_plan({0: clear}, [spool(44, rgba="#000000FF", brand="Elegoo")], PRINTER, {}, links)
    # With no link, the record's own colour, as before.
    assert fill_plan({0: clear}, [spool(42, rgba="#EEF3F4FF")], PRINTER, {}) == {1: 42}


def test_a_slot_with_no_filament_is_left_as_given() -> None:
    assert fill_plan({}, [spool(41)], PRINTER, {2: 49}) == {2: 49}


def test_a_spool_matches_a_record_of_its_alpha_only() -> None:
    """#6316 reader 3: a translucent spool is never an opaque record's, by its link or by
    colour, and the other way round."""
    assert record_rgba(filament(alpha=0x80)) == "#FF000080"
    opaque, clear = filament(), filament(alpha=0x80)
    translucent = [spool(41, rgba="#FF000080")]
    with pytest.raises(SpoolChoiceError):
        fill_plan({0: opaque}, translucent, PRINTER, {})
    assert fill_plan({0: clear}, translucent, PRINTER, {}) == {1: 41}
    with pytest.raises(SpoolChoiceError):
        fill_plan({0: clear}, [spool(42)], PRINTER, {})
    # A link from an import that grouped both alphas names both: only one of its alpha.
    linked = {opaque.id: SpoolLink("#FF0000", frozenset({41, 42}))}
    assert fill_plan({0: opaque}, [*translucent, spool(42)], PRINTER, {}, linked) == {1: 42}


# -- the item print, on ScadBuddy's spools ---------------------------------------------


def row(
    number: int,
    rgba: str | None = "#FF0000FF",
    *,
    loaded: str | None = None,
    grams: float = 500.0,
    archived: bool = False,
    **names: Any,
) -> FilamentInventorySpool:
    """SB spool #``number`` of red Bambu PLA Basic, in a tray of registry printer
    ``loaded``, or on the shelf."""
    fields: dict[str, Any] = {"material": "PLA", "subtype": "Basic", "brand": "Bambu"} | names
    return FilamentInventorySpool(
        spool=sb_spool(number, rgba=rgba, grams=grams, archived=archived, **fields),
        loaded=None
        if loaded is None
        else TrayPlace(
            printer_id=loaded, bambuddy_printer_id=None, printer_name=None, ams_id=0, tray_id=0
        ),
    )


class Inventory:
    """`orders.spools.SpoolRows` over fixed rows, and the Bambuddy links of an older plan."""

    def __init__(self, *rows: FilamentInventorySpool, links: dict[int, int] | None = None) -> None:
        self._rows = list(rows)
        self._links = links or {}
        self.reads = 0

    def rows(self, *, include_archived: bool = False) -> list[FilamentInventorySpool]:
        self.reads += 1
        return [r for r in self._rows if include_archived or r.spool.archived_at is None]

    def bb_to_sb(self, ids: Iterable[int]) -> dict[int, int]:
        return {i: self._links[i] for i in ids if i in self._links}


def test_shelf_spools_are_the_sb_spools_by_number() -> None:
    [shelf] = shelf_spools([row(41, "#FFFFFF80", loaded=PRINTER, grams=12.5)])
    assert (shelf.id, shelf.rgba, shelf.loaded_printer, shelf.remaining_g) == (
        41,
        "#FFFFFF80",
        PRINTER,
        12.5,
    )
    assert (shelf.material, shelf.subtype, shelf.brand) == ("PLA", "Basic", "Bambu")


@pytest.fixture(name="shop")
def _shop(rows: OrderStore) -> Shop:
    return Shop(rows)


def priced_item(shop: Shop, alpha: int = 255) -> str:
    """An item whose colour slot 0 is red Bambu PLA Basic of ``alpha``."""
    record = shop.rows.insert_filament(
        FilamentInput(
            material="PLA",
            subtype="Basic",
            brand="Bambu",
            colour="#FF0000",
            alpha=alpha,
            cost_per_kg="20",
        )
    )
    order = shop.order()
    item = shop.item(order)
    shop.lifecycle.update_item(order.id, item.id, BY, filaments={0: record.id})
    return item.id


def _slots(plan: FilamentPlan | None) -> list[tuple[int, int]]:
    assert plan is not None
    assert plan.ids == "sb"
    return [(s.slot_id, s.spool_id) for s in plan.slots]


@pytest.mark.requires_postgres
async def test_the_item_print_fills_its_plan_from_its_filaments(shop: Shop) -> None:
    item_id = priced_item(shop)
    inventory = Inventory(row(41, loaded=PRINTER), row(42, grams=900))

    plan = await item_plan(shop.rows, inventory, item_id, FilamentPlan(ids="sb"), PRINTER)

    assert _slots(plan) == [(1, 41)]
    assert plan is not None and plan.force_colour_match


@pytest.mark.requires_postgres
async def test_item_print_needs_no_bambuddy(shop: Shop) -> None:
    """The fill reads ScadBuddy's spools only: no seam, no Bambuddy URL."""
    item_id = priced_item(shop)
    inventory = Inventory(row(42, grams=900))

    assert _slots(await item_plan(shop.rows, inventory, item_id, FilamentPlan(), None)) == [(1, 42)]
    assert inventory.reads == 1


@pytest.mark.requires_postgres
async def test_item_print_fills_the_spool_of_its_alpha(shop: Shop) -> None:
    """#6316 reader 3: a translucent red loaded on the printer is not the opaque red
    record's; the opaque red on the shelf is. A translucent record takes the other."""
    opaque_item = priced_item(shop)
    inventory = Inventory(
        row(41, "#FF000080", loaded=PRINTER, grams=900), row(42, "#FF0000FF", grams=100)
    )

    plan = await item_plan(shop.rows, inventory, opaque_item, FilamentPlan(ids="sb"), PRINTER)
    assert _slots(plan) == [(1, 42)]

    clear_item = priced_item(shop, alpha=0x80)
    plan = await item_plan(shop.rows, inventory, clear_item, FilamentPlan(ids="sb"), PRINTER)
    assert _slots(plan) == [(1, 41)]


@pytest.mark.requires_postgres
async def test_the_item_print_keeps_force_colour_match_off_when_asked(shop: Shop) -> None:
    item_id = priced_item(shop)
    inventory = Inventory(row(41, loaded=PRINTER), row(42, grams=900))

    plan = await item_plan(
        shop.rows, inventory, item_id, FilamentPlan(force_colour_match=False, ids="sb"), PRINTER
    )

    assert plan is not None
    assert not plan.force_colour_match


@pytest.mark.requires_postgres
async def test_the_item_print_refuses_with_no_spool(shop: Shop) -> None:
    item_id = priced_item(shop)
    with pytest.raises(ApiError) as raised:
        await item_plan(shop.rows, Inventory(), item_id, FilamentPlan(ids="sb"), PRINTER)
    assert raised.value.status == 409
    assert raised.value.type.endswith("/needs_spool_choice")


@pytest.mark.requires_postgres
async def test_a_supplied_spool_is_an_sb_number_and_an_older_plan_is_mapped(
    shop: Shop,
) -> None:
    """A supplied SB number is kept when it is of the slot's filament; an older plan's
    Bambuddy id (``ids`` ``"bb"``) is its linked SB spool's number, never SB spool #7."""
    item_id = priced_item(shop)
    decoy = row(BB_RED, "#00FF00FF")
    inventory = Inventory(row(43), decoy, row(41, loaded=PRINTER), links={BB_RED: 43})
    asked = [SlotChoice(slot_id=1, spool_id=43)]

    sb = FilamentPlan(slots=asked, ids="sb")
    assert _slots(await item_plan(shop.rows, inventory, item_id, sb, PRINTER)) == [(1, 43)]
    bb = FilamentPlan(slots=[SlotChoice(slot_id=1, spool_id=BB_RED)], ids="bb")
    assert _slots(await item_plan(shop.rows, inventory, item_id, bb, PRINTER)) == [(1, 43)]
    # A Bambuddy id with no link names no spool: the slot is filled.
    unlinked = FilamentPlan(slots=[SlotChoice(slot_id=1, spool_id=99)], ids="bb")
    assert _slots(await item_plan(shop.rows, inventory, item_id, unlinked, PRINTER)) == [(1, 41)]


@pytest.mark.requires_postgres
async def test_the_plan_a_stored_quote_names_is_kept_by_sb_number(shop: Shop) -> None:
    """A print that sends no plan prints its quote's (#4673), which Task 8 stored as SB
    numbers (``ids`` ``"sb"``): the shelf spool it names is kept over the loaded one."""
    item_id = priced_item(shop)
    line = QuoteLine(kind="manual", label="typed", quantity=1, unit_minor=100, amount_minor=100)
    with shop.rows.transaction() as conn:
        stored = shop.rows.insert_quote(
            conn,
            item_id,
            source="manual",
            lines=[line],
            unit_cost_minor=100,
            unit_price_minor=100,
            quantity=1,
            created_by=Actor(kind="browser"),
            choices={},
            filament_plan={
                "slots": [{"slot_id": 1, "spool_id": 44}],
                "force_colour_match": True,
                "ids": "sb",
            },
        )
    quote = shop.rows.quote(stored.id)
    assert quote is not None
    setup = quoted_setup(quote)
    assert setup is not None
    inventory = Inventory(row(41, loaded=PRINTER), row(44, grams=10), row(BB_RED, "#00FF00FF"))
    quoted = FilamentPlan.model_validate(setup["filament_plan"])

    plan = await item_plan(shop.rows, inventory, item_id, quoted, PRINTER)

    assert _slots(plan) == [(1, 44)]


# -- the price book's import from SB spools (#6316 readers 1 and 2) --------------------


def priced(
    number: int, rgba: str, cost: str | None = "20", **fields: Any
) -> FilamentInventorySpool:
    made = row(number, rgba, **fields)
    effective = made.spool.effective.model_copy(
        update={"cost_per_kg": None if cost is None else Decimal(cost)}
    )
    return made.model_copy(update={"spool": made.spool.model_copy(update={"effective": effective})})


def book_row(store: OrderStore, alpha: int, *, first: bool = False) -> str:
    """A ``manual`` white Bambu PLA Basic record of ``alpha``; ``first`` gives it the
    lowest id, so a match by RGB alone would take it."""
    made = store.insert_filament(
        FilamentInput(
            material="PLA",
            subtype="Basic",
            brand="Bambu",
            colour="#FFFFFF",
            alpha=alpha,
            cost_per_kg="10",
        )
    )
    if not first:
        return made.id
    with store.transaction() as conn:
        conn.execute("UPDATE filaments SET id = '0-first' WHERE id = %s", (made.id,))
    return "0-first"


def test_groups_are_sb_spools_by_names_and_rgba() -> None:
    groups = spool_groups(
        [
            priced(41, "#FFFFFFFF", "20"),
            priced(43, "#FFFFFFFF", "26.5"),
            priced(42, "#FFFFFF80", "30"),
            priced(44, "#FFFFFFFF", None, archived=True),
        ]
    )
    assert [(g.colour, g.alpha, [n for n, _ in g.spools]) for g in groups] == [
        ("#FFFFFF", 0x80, [42]),
        ("#FFFFFF", 0xFF, [41, 43]),
    ]


def _with(
    made: FilamentInventorySpool,
    presets: Sequence[tuple[str, str, str]] = (),
    names: dict[str, str | None] | None = None,
    **effective: Any,
) -> FilamentInventorySpool:
    """``made`` with these effective values, catalog names and presets
    (``(printer model, nozzle, preset id)``)."""
    spool = made.spool.model_copy(
        update={
            "effective": made.spool.effective.model_copy(update=effective),
            "names": made.spool.names.model_copy(update=names or {}),
        }
    )
    rows = [
        EffectivePreset(
            printer_model=model,
            nozzle_diameter=nozzle,
            slicer_filament=preset,
            slicer_filament_name=None,
            overridden=True,
        )
        for model, nozzle, preset in presets
    ]
    return made.model_copy(update={"spool": spool, "presets": rows})


def test_a_group_takes_its_newest_spools_names_and_look() -> None:
    """The names, colour name, stops and effect are the newest spool's (the highest
    number); a spool known only by its colour's name is never an rgba one's (#2918)."""
    groups = spool_groups(
        [
            _with(row(41, "#FFFFFFFF"), colour_name="White"),
            _with(
                row(47, "#FFFFFFFF", brand="bambu ", subtype="basic"),
                names={"effect": "Dual Color"},
                colour_name="Jade White",
                extra_colours=["#FF0000FF", "#00FF0080"],
            ),
            _with(row(44, None), colour_name="White"),
        ]
    )
    by_numbers = {tuple(n for n, _ in g.spools): g for g in groups}
    assert set(by_numbers) == {(41, 47), (44,)}
    white = by_numbers[(41, 47)]
    assert (white.brand, white.subtype, white.colour_name, white.colour, white.rgba) == (
        "bambu",
        "basic",
        "Jade White",
        "#FFFFFF",
        "#FFFFFFFF",
    )
    assert (white.extra_colours, white.effect) == (["#FF0000FF", "#00FF0080"], "dual-color")
    assert (by_numbers[(44,)].colour, by_numbers[(44,)].rgba) == (None, None)


def test_a_group_carries_what_gives_its_density() -> None:
    """#6136: the newest spool's preset id that names one (its H2C 0.4 preset first), the
    Bambuddy local preset a numeric id names, and the newest spool's own density."""
    groups = spool_groups(
        [
            _with(row(41), [("H2C", "0.4", "GFA00")], density_g_cm3=Decimal("1.24")),
            _with(row(43), [("H2C", "0.6", "GFA05"), ("H2C", "0.4", "7")]),
            _with(row(45)),
            _with(row(51, "#000000FF"), [("X1C", "0.4", "GFL99")]),
        ],
        local={"7": LocalDensity(name="My PLA", density_g_cm3="1.25")},
    )
    by_numbers = {tuple(n for n, _ in g.spools): g for g in groups}
    red = by_numbers[(41, 43, 45)]
    assert (red.slicer_filament, red.local_preset) == (
        "7",
        LocalDensity(name="My PLA", density_g_cm3="1.25"),
    )
    assert red.spool_density == SpoolDensity(number=41, density_g_cm3="1.24")
    assert (by_numbers[(51,)].slicer_filament, by_numbers[(51,)].spool_density) == ("GFL99", None)


def _import(store: OrderStore, rows: Sequence[FilamentInventorySpool]) -> list[dict[str, Any]]:
    return [r.model_dump() for r in import_spools(store, spool_groups(rows)).rows]


@pytest.mark.requires_postgres
def test_import_by_colour_keeps_alpha_apart(rows: OrderStore) -> None:
    """#6316 reader 1: an opaque group links the opaque record of its RGB, never the
    translucent one, though the translucent one comes first."""
    clear = book_row(rows, 0x80, first=True)
    opaque = book_row(rows, 0xFF)

    [imported] = _import(rows, [priced(41, "#FFFFFFFF", "24")])

    assert (imported["action"], imported["filament_id"], imported["spool_ids"]) == (
        "updated",
        opaque,
        [41],
    )
    links = rows.spool_links([clear, opaque])
    assert links[clear].spool_ids == frozenset()
    assert links[opaque].spool_ids == frozenset({41})


@pytest.mark.requires_postgres
def test_an_opaque_group_is_not_colour_taken_by_a_translucent_row(rows: OrderStore) -> None:
    """#6316 reader 2: a translucent record of the RGB does not hold an opaque group's
    colour: the import makes the opaque record beside it."""
    clear = book_row(rows, 0x80)

    [imported] = _import(rows, [priced(41, "#FFFFFFFF", "24")])

    assert (imported["action"], imported["reason"]) == ("created", None)
    made = rows.filament(imported["filament_id"])
    assert made is not None and made.id != clear
    assert (made.colour, made.alpha, made.cost_per_kg) == ("#FFFFFF", 0xFF, "24")
    kept = rows.filament(clear)
    assert kept is not None and kept.cost_per_kg == "10"


@pytest.mark.requires_postgres
def test_the_newest_priced_spool_prices_the_group(rows: OrderStore) -> None:
    [imported] = _import(
        rows,
        [
            priced(45, "#00AE42FF", None),
            priced(43, "#00AE42FF", "26.5"),
            priced(41, "#00AE42FF", "24"),
        ],
    )
    assert (imported["action"], imported["cost_per_kg"], imported["spool_ids"]) == (
        "created",
        "26.5",
        [41, 43, 45],
    )
    assert (imported["min_cost_per_kg"], imported["max_cost_per_kg"]) == ("24", "26.5")
