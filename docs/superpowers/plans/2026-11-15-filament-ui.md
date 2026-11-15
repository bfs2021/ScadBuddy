# Filament UI and SB spools everywhere (#6262) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **UI tasks (13-20):** the implementer loads `frontend-design:frontend-design` before writing any UI. Pass this line on to every UI subagent too.

**Size.** This is too big for one review, but the owner wants one PR per issue. So it is
one PR (`feat/filament-ui`) built as four stacked parts. Each part is a run of commits
that passes CI on its own. Review each part as a unit:

| Part | Tasks | What it leaves working |
|---|---|---|
| A. Backend reads and presets | 1-3 | New filament routes; no `('*','*')` presets |
| B. SB spools in every reader | 4-10 | Dialog, hot path, orders, agent inventory read SB spools; #6316 |
| C. Retire the old surface | 11-13 | No native API, no overlay, old tables dropped; Settings' Filament section |
| D. The Filament section | 14-20 | `/filament`, spool edit page, picker UI, e2e, docs |

Part B changes what a plan's `spool_id` means (Task 7). Tasks 7 and 8 must land in the
same deploy. They are in the same PR, so they do.

**Goal:** ScadBuddy's own spools (`filament_*`) are the only inventory the print dialog,
the hot path, orders and the agent read, and a person manages them in a top-level
Filament section instead of Settings.

**Architecture:** One backend module (`filament/inventory.py`) answers "which SB spools
exist, and which tray holds each" from Postgres alone, and every reader uses it: the
dialog's options on both paths, the print worker (through one CRUD route), orders and the
agent's inventory route. The provider overlay (`spools/` providers, `spool_provider_records`,
`physical_spools`, `tray_spool_links`) and the native API are removed, and their tables
dropped after their data is carried over. The frontend gets `/filament` with tabs that
read `/api/v1/filament/*`, a spool edit page, and an RGBA swatch and colour field.

**Tech Stack:** Python 3.12, FastAPI, psycopg 3, pydantic v2, Temporal Python SDK,
Postgres 18; React 19, Vite, shadcn/ui, msw, vitest, Playwright; TypeScript agent tools
(zod, msw).

**Spec:** `docs/superpowers/specs/2026-11-14-filament-management-design.md` (§5.1 colour,
§5.3 overrides, §5.4 tags, §5.5 ledger, §10 UI, §11 parity, §12 row #6262, §13). Phase 1
plan: `docs/superpowers/plans/2026-11-14-filament-data-model.md`; its "Decisions made while
building (#6261)" bind this plan. Issues: #6262, #6316 (folded in). Epic #6260.

## Global Constraints

- **Database access (#5295):** only the CRUD service has SQL. The print worker reads SB
  spools through a `crud_router("print")` route, area `spools`, with its service credential.
  No new pool, grant or cross-service table read. No untrusted code near a DB secret.
- **Migrations (#491):** new files only, `backend/scadbuddy/migrations/$(date -u +%Y%m%dT%H%MZ)_<slug>.sql`.
  Never edit a merged file. A data migration guards each row it rewrites, so it is a no-op elsewhere.
- **Generated API files are never committed** (`backend/openapi.json`, both `schema.d.ts`).
  Run `pnpm gen:api` in `frontend/` and `agent/` after every backend route change.
- **Every route** sets `summary=` and `description=`. Every new public `/api/v1` operation
  gets an agent tool or a `NOT_A_TOOL` entry with a reason (`agent/src/tools/coverage.ts`,
  `agent/test/coverage.test.ts`). A removed operation leaves no stale `NOT_A_TOOL` entry.
- **Every tool works in every mode** (classic and durable).
- **Colour is `#RRGGBBAA`** in every new field. A `#RRGGBB` input reads as alpha `FF`
  (`filament/colour.py` `normalise_rgba`). A translucent spool never matches an opaque one
  by colour alone (spec §5.1).
- **Remembered choices (owner rule):** every print or quote option a person picks is a
  remembered choice behind the dialog's existing Remember toggle, never a hard-coded
  value. This PR adds no new print option; the SB spool per slot and "Wait for the right
  colour" stay in `ModelPrintChoices.filament_plan` and `force_colour_match`.
- **Hot path:** a native run touches Bambuddy nowhere. `e2e-stack/`'s recorder pass stays
  at zero calls (backend/CLAUDE.md, hot path).
- **Workflow changes** go behind `workflow.patched(...)`; `tests/test_spool_refresh_replay.py`
  and the slice/print replay fixtures still pass.
- **Images and files are blobs** with `{name, mediaType}` pointers, never base64
  (`lint-base64-images.sh`). This PR adds no image path.
- **Citations (#259):** every external fact in code comments and docs gets a link; every
  measured fact says where and how it was measured. Bambuddy facts cite the 1.2.6b1
  OpenAPI measured in spec §3.
- **Frontend e2e:** msw-mocked Playwright against `pnpm preview`; new mocks go in
  `src/mocks/features/filament/` and export `handlers` (and `reset`); one route has one
  feature module (`mocks/features.test.ts`). A type error in a test fails all three
  `frontend-e2e` shards, so run `pnpm typecheck` first. Shared test helpers go in `src/test/`.
- **UI links** to ScadBuddy pages use `AppLink`/`appUrl` (host the user is on).
- **Commands:** backend `cd backend && SCADBUDDY_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/scadbuddy_test uv run --frozen pytest <files>`,
  then `uv run --frozen ruff check . && uv run --frozen ruff format --check . && uv run --frozen mypy`;
  frontend `cd frontend && pnpm gen:api && pnpm lint && pnpm typecheck && pnpm exec vitest run <file>`,
  `pnpm exec playwright test e2e/<spec>`; agent `cd agent && pnpm gen:api && pnpm test <file> && pnpm typecheck`.

## Decisions this plan makes

1. **Hot-path replacement for the native provider:** `filament/inventory.py`
   `FilamentInventory.trays(printer_id, seen)` resolves each reported tray to an SB spool:
   an open tag binding by `tray_uuid`, then `tag_uid`; else, for an untagged tray, the
   spool whose stored `tray_place` is that tray and whose `tray_fingerprint` still equals
   the tray's (`MATERIAL|#RRGGBBAA`). The print worker calls it through
   `POST /api/v1/internal/crud/print/filament/trays` (area `spools`). A LAN start's
   estimates and the settle move from `spools/native.py` to `filament/print_uses.py`
   (same ledger rows, same `ref_id` form), behind `…/filament/print-uses` CRUD routes with
   an `Idempotency-Key`. Cost if wrong: one more CRUD round trip per plan, as today.
2. **A plan's `spool_id` is the SB spool's `number`** on both paths; a tray chosen for
   itself keeps its negative id (`tray_spool_id`). `SpoolOption` gains `sb_spool_id`.
   One migration (Task 8) rewrites every stored Bambuddy spool id through
   `filament_bb_links`; an id with no link is dropped (the picker then auto-matches that
   slot). Cost: a remembered choice of a never-pulled BB spool is forgotten once.
3. **Bambuddy path:** the options are SB spools. Where each is loaded comes from the SB
   tray resolution over every registry printer's latest report, else Bambuddy's
   assignment of the linked BB spool (until #6263 captures loads). Presets: the SB
   effective preset for the printer model and nozzle, else the linked BB spool's
   `filament-presets` (one read per chosen spool, as today; dropped by #6265). Queueing is
   unchanged: Bambuddy still gets type and colour only (`queue_filaments`).
4. **Presets:** every `('*','*')` row in `filament_spool_presets` and
   `filament_spool_type_presets` is expanded to one row per registry printer model ×
   nozzle `0.2, 0.4, 0.6, 0.8` (the H2C's nozzles, spec §9 step 7 lists them), then
   deleted, and a CHECK refuses `'*'` from then on. Readers ask only for
   `(printer_model, nozzle_diameter)`.
5. **Native API retired, not redirected (owner ruling, 2026-11-15: no aliases):** `/api/v1/native-spools*` and the four
   `native_spool_*` tools are removed. Each has a `filament_*` equivalent
   (`list`→`filament_spool_list`, `get`, `upsert`, `delete`), the native shape loses alpha
   (`#RRGGBB`, the defect §5.1 names), and a second write path would need its own
   tests for every rule the filament store enforces. A `NOT_A_TOOL` entry would describe a
   route that no longer exists. The four tools (`native_spool_list`, `native_spool_get`,
   `native_spool_upsert`, `native_spool_delete`) are removed with no aliases; the PR body
   (Task 20) names them, so a saved flow's author knows what to change.
6. **Overlay removed with its tables.** Before the drop, one migration carries
   `tray_spool_links` into SB tray places (spool id = physical spool id, the #6261
   migration's rule) and `spool_record_links` of provider `bambuddy` into
   `filament_bb_links` where the SB spool has none. `SpoolRefresh` keeps its schedule for
   the held presets and the BB pull; its provider steps are skipped behind
   `workflow.patched("spool-providers-gone")`, and the old activity names stay registered
   as no-ops until no history names them.
7. **Restore and tags:** a restore never rebinds a tag silently (anti-goal: a silent
   overwrite). The spool page shows the last tag the spool held (`last_tag`): "Bind tag
   again" when it is free, or "Tag is on spool #N — Move it here", which rebinds through
   the existing rebind rule (ledger events on both spools).
8. **Price book editor moves, not deleted:** `FilamentsEditor` leaves Settings → Orders
   and becomes the Types tab's "Price book" panel (book rows with no type stay
   editable). Pricing rates stay in Settings → Orders (configuration).
9. **Settings → Printing → Filament** holds what exists now: `filament_bb_pull`
   (`off` | `bb_to_sb`; the other directions arrive with #6265), the pull interval (the
   renamed `spool_overlay_refresh_seconds`, label "Pull from Bambuddy every"),
   `filament_low_stock_pct` (default 20, our call), `filament_default_cost_per_kg`
   (default none), and the currency shown read-only with a link to Orders (one setting,
   `orders_currency`). RFID override mode and weight-sync policy arrive with #6264 and
   #6268. Old anchors `#inventory` and `#native-spools` resolve to this section.
10. **Tabs shown now:** Spools, Types, Tags, Locations, Catalog, Ledger. Suppliers,
    Invoices, Shopping list and Metrics are in the tab registry with `available: false`
    and render nowhere until #6266/#6269 flip them.
11. **Spools tab scope (owner ruling, 2026-11-15):** table and cards views, filters,
    columns picker, group by, bulk archive/restore/delete/move/set type, summary tiles,
    CSV export **and CSV import** (Task 15). Labels with QR codes (§7) go to #6264. The
    forecast view (it needs the burn rate, §5.7) goes to #6269.
12. **Picker colour matching:** a slot's colour is opaque unless its source carries alpha
    (OpenSCAD's alpha byte is ignored, CLAUDE.md). `colours_match` is false when one side
    is translucent (`alpha < FF`) and the other opaque; a person can still pick it.
13. **Deploy skew:** the old CRUD routes (`/spools/overlay`, `/native-spools*`) are removed
    in the same PR. A print worker on the old build gets 404 and its activity retries
    until the new build (AUTO_UPGRADE) takes it. Cost: a few minutes of retried plans
    during a rollout.

## Review Focus

1. A remembered plan or quote that names a Bambuddy spool id with no SB link: after
   Task 8 the slot has no choice and auto-matches; it never names an unrelated SB spool
   whose `number` happens to equal the old id (Task 8 test).
2. An opaque and a translucent spool of one hue are both loaded: the picker suggests the
   opaque one for an RGB slot, an item print fills the right one, and the price-book
   import keeps two rows (Tasks 5, 9).
3. An untagged tray a person linked, then refilled with another colour: the link no
   longer counts, and the dialog asks about the tray again (Task 4).
4. A restored spool whose last tag is now on another spool: nothing moves on restore;
   "Move it here" moves it with `tag_unbound`/`tag_bound` events on both (Tasks 2, 17).
5. A spool overrides its type's colour, then the person resets it: PATCH `rgba: null`, the
   effective colour is the type's again, the "overridden" mark is gone, and one `edited`
   event records it (Task 17 test, backend rule already from #6261).

---

## File structure

```
backend/scadbuddy/migrations/
  <ts>_filament_presets_per_nozzle.sql      Task 3
  <ts>_filament_tray_place.sql              Task 4
  <ts>_filament_plan_spool_numbers.sql      Task 8
  <ts>_filament_insert_bb_catalog.sql       Task 10
  <ts>_filament_carry_overlay.sql           Task 12
  <ts>_drop_native_and_overlay.sql          Task 12
backend/scadbuddy/filament/
  presets.py        effective presets and K values per spool       Task 1
  inventory.py      SB spools with where each is loaded; trays     Tasks 4, 7
  print_uses.py     a LAN run's estimates and settle (from native) Task 6
  spools.py, models.py, ledger.py, bambuddy_pull.py (modify)       Tasks 1, 2, 10
backend/scadbuddy/api/filament.py           new read and preset routes Tasks 1, 2, 9
backend/scadbuddy/api/crud_print.py, crud/print.py  trays + print-uses routes Task 6
backend/scadbuddy/api/tray_spools.py        tray links on SB spools     Task 4
backend/scadbuddy/bambuddy/filaments.py, trays.py, resolver.py, print_run.py  Tasks 5, 7
backend/scadbuddy/orders/spools.py, spool_import.py, bambuddy.py, integrations.py  Task 9
backend/scadbuddy/api/farm.py               inventory routes removed    Task 9
deleted: spools/native.py, overlay.py, providers.py, spool_providers.py, store.py (overlay
  parts), bambuddy/spool_providers.py, api/native_spools.py            Tasks 11, 12
agent/src/tools/filament.ts, traySpools.ts, farm.ts, coverage.ts; nativeSpools.ts deleted
frontend/src/pages/filament/                FilamentPage + one file per tab  Tasks 14-19
frontend/src/components/filament/           RgbaSwatch, RgbaColourField, SpoolForm…
frontend/src/api/filament.ts                typed client for /filament/*
frontend/src/mocks/features/filament/       msw handlers and seed data
frontend/src/pages/settings/sections/filament.tsx  config section   Task 13
frontend/e2e/filament.spec.ts                                        Task 20
```

---

## Part A — backend reads and presets

### Task 1: A spool's own presets and K values, and the effective set

**Files:**
- Create: `backend/scadbuddy/filament/presets.py`
- Modify: `backend/scadbuddy/filament/spools.py`, `filament/models.py`, `api/filament.py`, `agent/src/tools/filament.ts`
- Test: `backend/tests/filament/test_presets.py`, `backend/tests/api/test_filament.py`, `agent/test/filament.test.ts`

**Interfaces:**
- Consumes: `filament_spool_presets`, `filament_spool_k_values`, the type tables (#6261); `SpoolPresetCreate`, `SpoolKValueCreate` (already in `models.py`).
- Produces in `models.py`: `EffectivePreset(printer_model: str, nozzle_diameter: str, slicer_filament: str, slicer_filament_name: str | None, overridden: bool)`; `EffectiveKValue(printer_id: UUID, extruder: int, nozzle_diameter: str, nozzle_type: str | None, k_value: Decimal, name: str | None, cali_idx: int | None, setting_id: str | None, overridden: bool)`.
- Produces in `presets.py`: `effective_presets(conn, spool_id: UUID) -> list[EffectivePreset]` (type rows, each replaced by the spool's row of the same key; `overridden` true for a spool row); `effective_k_values(conn, spool_id) -> list[EffectiveKValue]`; `preset_for(presets: Sequence[EffectivePreset], printer_model: str, nozzle_diameter: str) -> EffectivePreset | None` (exact key only).
- Produces on `FilamentSpoolStore`: `presets(spool_id) -> list[EffectivePreset] | None`, `set_presets(spool_id, rows: list[SpoolPresetCreate], *, actor) -> list[EffectivePreset] | None` (replaces the spool's own rows; writes one `edited` event `data={"changes": {"presets": [before, after]}}`), and the same pair for K values.
- Routes: `GET/PUT /filament/spools/{id}/presets`, `GET/PUT /filament/spools/{id}/k-values`. Tools: `filament_spool_set_presets`, `filament_spool_set_k_values` (write); the GETs are covered by `filament_spool_get` (Task 2 adds them to its answer), so they get `NOT_A_TOOL` entries naming that.

- [ ] **Step 1: Failing tests:** `test_a_spool_preset_overrides_its_types_for_that_key` (type rows H2C/0.4 `GFA00` and H2C/0.6 `GFA01`; spool row H2C/0.4 `P1` → effective H2C/0.4 is `P1` `overridden=True`, H2C/0.6 is `GFA01` `overridden=False`); `test_setting_an_empty_list_resets_to_the_type` (PUT `[]` → every row `overridden=False`, one `edited` event); `test_preset_for_is_exact` (`preset_for(rows, "H2C", "0.2")` is `None` when only 0.4 exists); API `PUT` with an unknown spool → 404.
- [ ] **Step 2:** Run `uv run --frozen pytest tests/filament/test_presets.py tests/api/test_filament.py` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run backend tests; `cd agent && pnpm gen:api && pnpm test filament coverage && pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(filament): a spool's own presets and K values (#6262)`.

### Task 2: Reads the Filament section needs

**Files:**
- Modify: `backend/scadbuddy/filament/spools.py`, `ledger.py`, `models.py`, `api/filament.py`, `agent/src/tools/filament.ts`
- Test: `backend/tests/filament/test_spool_detail.py`, `backend/tests/api/test_filament.py`, `agent/test/filament.test.ts`

**Interfaces:**
- `Spool` gains `names: SpoolNames` (`brand`, `material`, `subtype`, `category`, `effect`, `insert_type`, `location` as text or `None`, resolved from the effective ids by `_hydrate`), so list rows carry them too.
- Produces `SpoolDetail(Spool)` with `tag: Tag | None` (the open binding's), `last_tag: LastTag | None` (`tag: Tag`, `unbound_at`, `reason`, `held_by: int | None` — the `number` of the spool that holds it now), `presets: list[EffectivePreset]`, `k_values: list[EffectiveKValue]`, `basis: GramsBasis` (`anchor: SpoolEvent | None`, `deltas: list[SpoolEvent]`; spec §5.5 "the UI shows the anchor and the deltas"), `in_use: bool` (any `print_started`/`print_ended` event; the UI offers delete only when false).
- `GET /filament/spools/{id}` answers `SpoolDetail` (was `Spool`).
- `ledger.basis(events, *, weight_locked, label_weight_g) -> GramsBasis` — the same walk as `grams_left`, returning the anchor and the deltas it used. `grams_left` is reimplemented on it, so the two never disagree.
- `GET /filament/tags?include_unbound=bool` → `list[TagRow]` (`Tag` + `binding: TagBinding | None` + `spool_number: int | None`); `GET /filament/tags/{id}` → `TagDetail` (+ `history: list[TagBinding]`).
- `GET /filament/events?spool_id&kind&source&since&before&limit≤500` → `EventPage(events: list[LedgerRow], next_before: datetime | None)`; `LedgerRow = SpoolEvent + spool_number`. Ordered `(at, seq)` descending.
- `GET /filament/summary` → `InventorySummary(spools: int, grams_left: float, value_left: Decimal | None, by_material: list[MaterialStock], loaded: int, low_stock: int, needs_type: int)`; low stock is `grams_left / label_weight_g * 100 < effective low_stock_pct`, else the setting `filament_low_stock_pct` (Task 13 adds it; until then the default 20 is the store's constant `DEFAULT_LOW_STOCK_PCT`); value uses `cost_per_kg`, else `filament_default_cost_per_kg`.
- Tools: `filament_tag_list`, `filament_tag_get`, `filament_ledger_list`, `filament_summary` (read). `filament_spool_get` describes the new fields.

- [ ] **Step 1: Failing tests:** `test_detail_names_the_last_tag_and_its_holder` (bind T to A, archive A, bind T to B → A's `last_tag.held_by == B.number`; restore A → `tag is None`); `test_basis_matches_grams_left` (scale 800, print_actual −50, ams_reading 700 on a locked spool → `basis.anchor.source == "scale"`, one delta of −50, and `grams_left == 750`); `test_events_page_by_time` (three spools' events, `limit=2` → two rows, `next_before` the second's `at`); `test_low_stock_uses_the_spool_then_the_setting` (spool 15% left with `low_stock_pct` 10 → not low; with none → low at default 20); `test_in_use_follows_print_events`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run backend tests, agent `pnpm gen:api && pnpm test filament coverage && pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(filament): spool detail, tags, ledger and summary reads (#6262)`.

### Task 3: Presets per printer and nozzle only

**Files:**
- Create: `backend/scadbuddy/migrations/<ts>_filament_presets_per_nozzle.sql`
- Modify: `backend/scadbuddy/spools/native.py` (its `preset` read, until Task 11 deletes it: the H2C/0.4 row), `filament/models.py` (`Name` for `printer_model`/`nozzle_diameter` refuses `*`)
- Test: `backend/tests/filament/test_presets_migration.py`

**Interfaces:**
- Produces: no `'*'` key in either preset table; CHECK `printer_model <> '*' AND nozzle_diameter <> '*'` on `filament_spool_presets` and `filament_spool_type_presets`.
- The migration's model key must equal what `bambuddy/resolver.py` compares (`PRINTER_MODEL = "H2C"`). Step 3 measures the registry's `printers.model` values (dev database and `backend/tests/bambuddy/recordings/` printer bodies) and writes the expression that maps them to that form; it is recorded in a comment in the file with where it was measured. With no registry printer, the rows expand to `H2C` (the only model ScadBuddy slices for, `PRINTER_MODEL`).

- [ ] **Step 1: Failing test** (the `MIGRATIONS[:idx]` pattern of `tests/test_pg_migrations.py`): before the file, a spool with a `('*','*')` preset `P1` and one registry H2C printer; after it, rows H2C/0.2, 0.4, 0.6, 0.8 all `P1`, no `*` row; inserting `('*','0.4')` raises `CheckViolation`; a spool that already had H2C/0.4 `P2` keeps `P2` there.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Measure the model values; write the migration (`INSERT … SELECT … ON CONFLICT DO NOTHING`, then `DELETE`, then the CHECKs).
- [ ] **Step 4:** Run it, `tests/test_pg_migrations.py`, `tests/spools/test_native.py` — PASS.
- [ ] **Step 5:** Commit `feat(filament): presets per printer model and nozzle, no wildcard row (#6262)`.

## Part B — SB spools in every reader

### Task 4: Which SB spool is in each tray

**Files:**
- Create: `backend/scadbuddy/filament/inventory.py`, `backend/scadbuddy/migrations/<ts>_filament_tray_place.sql`
- Modify: `backend/scadbuddy/filament/locations.py` (`move` clears the tray place), `backend/scadbuddy/api/tray_spools.py`, `agent/src/tools/traySpools.ts`
- Test: `backend/tests/filament/test_inventory_trays.py`, `backend/tests/api/test_tray_spools.py`, `agent/test/traySpools.test.ts`

**Interfaces:**
- Migration: `filament_spools` gains `tray_fingerprint text` (derived and stored, spec §5.3 "current tray"); the tray place is the spool's `location_id` when that location has `printer_id` set.
- Produces in `inventory.py`:
  - `tray_fingerprint(material: str | None, colour: str | None) -> str` = `f"{material.strip().upper()}|{normalise_rgba(colour)}"`, `"|"` part empty when colour is `None`. Alpha is included (spec §5.1; the old `material|RRGGBB` in `spools/models.py` drops it).
  - `TrayHolder(ams_id: int, tray_id: int, spool: Spool | None, found_by: Literal["tag", "link"] | None)`; `TrayView(trays: list[TrayHolder], shelf: list[Spool])` — shelf: unarchived spools no tray of any printer holds.
  - `class FilamentInventory(pool)`: `trays(printer_id: UUID, seen: Sequence[SeenTray]) -> TrayView` (Postgres only; order: open binding by `tray_uuid`, then `tag_uid`; else for an untagged tray the spool placed at `(printer, ams, tray)` whose `tray_fingerprint == tray_fingerprint(seen.material, seen.colour)`); `link(printer_id, ams_id, tray_id, spool_id: UUID, seen: SeenTray, *, actor) -> Spool` (`LocationStore.ensure_ams` + `move`, then sets `tray_fingerprint`; raises `TrayNotFilledError` when `seen` is not filled, `TrayTagClashError` when the tray's tag is bound to another spool); `unlink(printer_id, ams_id, tray_id, *, actor) -> None` (moves the spool to no location).
- `PUT /printers/{printer_id}/trays/{ams_id}/{tray_id}/spool` body becomes `{spool_id: UUID}` (an SB spool), 409 for the two errors, 404 for an unknown printer or spool. `DELETE` unchanged. Tool `link_tray_spool` takes `spool_id` (uuid) only; descriptions drop "provider record".

- [ ] **Step 1: Failing tests:** `test_a_tagged_tray_is_its_bound_spool`; `test_an_untagged_link_holds_while_the_tray_matches` (link A to tray 0/1 seen `PLA` `#FF0000FF` → found_by `link`; then seen `PLA` `#00FF00FF` → that tray's spool is `None` and A is on the shelf) — Review Focus 3; `test_alpha_is_part_of_the_fingerprint` (linked at `#FFFFFFFF`, seen `#FFFFFF80` → `None`); `test_link_is_a_ledger_move` (one `moved` event, `data.to` the tray location); `test_a_tag_bound_elsewhere_refuses_the_link` (409 through the API).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run backend tests and `cd agent && pnpm gen:api && pnpm test traySpools && pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(filament): which SB spool each tray holds (#6262)`.

### Task 5: The native dialog's options from SB spools

**Files:**
- Modify: `backend/scadbuddy/bambuddy/filaments.py`, `bambuddy/trays.py`, `bambuddy/resolver.py`, `bambuddy/print_run.py`, `api/printing.py`, `api/storefront_slice.py`
- Test: `backend/tests/bambuddy/test_trays.py`, `test_resolver.py`, `test_filaments.py`, `backend/tests/api/test_printing_native.py` (existing names; adapt their overlay fixtures)

**Interfaces:**
- Consumes: `FilamentInventory.trays` (Task 4), `effective_presets`/`preset_for` (Task 1).
- `SpoolOption` loses `physical_spool_id` and `records`; gains `sb_spool_id: UUID | None`, `sb_number: int | None` (for a tray: the SB spool in it; for a spool row: equal to `spool_id`), `rgba: str | None` (`#RRGGBBAA`), `needs_type: bool = False`. `colour` stays `#RRGGBB` (the render splits by RGB).
- `FilamentOptions` loses `overlay_notes` and `provider_labels`.
- `gather_plate_options(..., trays_from=status, held: TrayView | None = None)` replaces `overlay=` and `provider_labels=`. `loaded_trays(status, printer_id, printer_name, held)` fills brand, colour name, grams left, label weight and `rgba` from the held SB spool's effective values and `Spool.names`, else the tray's own. `tray_questions(status, held)` asks about each filled, untagged, unheld tray with shelf spools of its material whose colour `colours_match`; `shelf_options(held.shelf)` gives each its SB `number` as `spool_id`.
- `colours_match(slot_colour, spool_colour, *, slot_alpha="FF", spool_alpha="FF") -> bool`: false when exactly one alpha is below `FF` (Decision 12); `_match_score` passes the spool's alpha.
- `resolve(..., spool_presets: dict[int, list[SpoolFilamentPreset]])` is keyed by `sb_number` for a tray option too; `_record_preset` is deleted, its place taken by `spool_presets.get(option.sb_number)` matched on `(PRINTER_MODEL, size)`.
- `resolve_plates` builds `spool_presets` from `effective_presets` of every chosen `sb_number` (one read through the store, or the worker's CRUD route in Task 6), with the BB fallback of Decision 3 only for a linked spool with no SB row and only when `client` is not `None`.

- [ ] **Step 1: Failing tests:** `test_a_tray_option_carries_its_sb_spool` (tray tagged and bound to spool #7 → option `sb_number=7`, `brand` from the type, `remaining_g` the ledger's); `test_an_opaque_slot_does_not_suggest_a_translucent_spool` (two trays `#FFFFFFFF`, `#FFFFFF80`, slot `#FFFFFF` → suggested the opaque tray) — Review Focus 2; `test_a_trays_preset_comes_from_its_spool` (spool #7 H2C/0.4 `Bambu PLA Basic @BBL H2C` → resolver ref that preset on a 0.4 nozzle, none on 0.6 → falls back to the tray's `tray_info_idx`); `test_native_options_read_no_bambuddy` (client `None`, no `TypeError`).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement; `api/printing.py` and `api/storefront_slice.py` call `FilamentInventory.trays` instead of `status_overlay`.
- [ ] **Step 4:** Run `tests/bambuddy tests/api/test_printing*.py tests/api/test_storefront_slice.py` — PASS.
- [ ] **Step 5:** Commit `feat(print): the native dialog reads SB spools (#6262)`.

### Task 6: The print worker reads SB spools through CRUD

**Files:**
- Create: `backend/scadbuddy/filament/print_uses.py`
- Modify: `backend/scadbuddy/api/crud_print.py`, `backend/scadbuddy/crud/print.py`, `backend/scadbuddy/workflows/print_activities.py`, `printers/print_activities.py`, `worker.py`, `main.py`
- Test: `backend/tests/filament/test_print_uses.py`, `backend/tests/crud/test_crud_filament.py`, existing `tests/spools/test_native_uses.py` cases moved to `test_print_uses.py`

**Interfaces:**
- Produces in `print_uses.py` (moved from `NativeSpoolStore`, same rules, same `ref_id = run_id/subtask/slot`): `record_uses(pool, run_id: str, subtask: str, uses: Sequence[SlotUse]) -> int`, `settle_uses(pool, run_id: str, stages: Sequence[str]) -> bool`, `settle_uses_in(conn, run_id, stages) -> bool`; `SlotUse(slot_id: int, spool_id: UUID, grams: float, plate_started_at: datetime)`.
- `print_use_hook(uses: PrintUses) -> ReadHook` replaces `native_use_hook` (no recache step: there is no cache).
- CRUD routes on `crud_router("print")`, area `spools`: `POST /filament/trays` (body `{printer_id, seen: list[SeenTray]}` → `TrayView`), `POST /filament/presets` (body `{spool_ids: list[int]}` → `dict[int, list[EffectivePreset]]`), `POST /filament/print-uses` and `POST /filament/print-uses/settle` (both take `Idempotency-Key`). Client classes in `crud/print.py`: `RemoteFilamentTrays`, `RemotePrintUses`, named in `CRUD_AREAS` like `RemoteNativeSpools`.
- The worker's plan (`workflows/print_activities.py` line ~486) reads `RemoteFilamentTrays.trays` instead of `printer_overlay`.

- [ ] **Step 1: Failing tests:** `test_a_lan_start_books_estimates_on_sb_spools` (tray held by #7, start 12 g → one `print_started`/`print_estimate` −12 on #7); `test_settle_replaces_the_estimate_once` (settle twice → one `print_ended`; grams −10 when sliced 10 and `done`, 0 when `failed`); `test_the_trays_route_needs_the_print_credential` (no credential → 401, the print credential → 200 with a `TrayView`); `test_a_retried_print_uses_call_writes_once` (same `Idempotency-Key` → one set of events).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement and wire the worker.
- [ ] **Step 4:** Run `tests/filament tests/crud tests/printers tests/workflows`; run `e2e-stack/run.sh --mode recorder` and confirm the recorder reports zero Bambuddy calls — PASS.
- [ ] **Step 5:** Commit `feat(print): the hot path reads SB spools through CRUD routes (#6262)`.

### Task 7: The Bambuddy path's options from SB spools

**Files:**
- Modify: `backend/scadbuddy/filament/inventory.py`, `bambuddy/filaments.py` (`build_options`, `gather_plate_options`), `bambuddy/print_run.py` (`resolve_plates`), `api/printing.py` (the Bambuddy-path tray question `POST /print/printers/{id}/trays/{ams}/{tray}/spool`), `agent/src/tools/print.ts` (descriptions that say "Bambuddy spool id")
- Test: `backend/tests/filament/test_inventory_rows.py`, `backend/tests/bambuddy/test_filaments.py`, `backend/tests/api/test_printing.py`

**Interfaces:**
- Produces in `inventory.py`: `TrayPlace(printer_id: str, bambuddy_printer_id: int | None, printer_name: str | None, ams_id: int, tray_id: int)`; `InventorySpool(spool: Spool, loaded: TrayPlace | None, bb_spool_id: int | None)`; `FilamentInventory.rows(*, include_archived=False, bb_assignments: Sequence[SpoolAssignment] = ()) -> list[InventorySpool]` — `loaded` from `trays()` over each registry printer's latest report (`printers/reports.py`), else a BB assignment of the linked BB spool (Decision 3).
- `build_options(*, library_file_id, rows: Sequence[InventorySpool], requirements, printer, slot_materials)` replaces the BB `spools`/`assignments` pair. `spool_id = spool.number`; `remaining_g` = the slot's `inventory-remain` when the spool is loaded in this printer and BB reconciled it, else `grams_left`.
- `resolve_plates`: `spool_presets` from SB effective presets; BB `spool_filament_presets(bb_spool_id)` only for a chosen spool with no SB row for the model and nozzle.
- The Bambuddy-path tray answer takes `{spool_id: int}` (an SB number): it calls `FilamentInventory.link` and, when the spool has a BB link, writes Bambuddy's assignment as today.

- [ ] **Step 1: Failing tests:** `test_rows_place_a_spool_by_its_tray_then_by_bb` (SB tray link → `loaded.printer_id` registry id; no SB place, BB assignment of its BB spool → that place; neither → `None`); `test_bambuddy_options_are_sb_numbers` (SB #3 linked to BB 41 → option `spool_id == 3`, `sb_spool_id` set); `test_a_bb_preset_is_read_only_without_an_sb_one`; `test_queue_filaments_still_sends_type_and_colour` (unchanged shape).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/bambuddy tests/api/test_printing*.py tests/filament`; `cd agent && pnpm test print && pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(print): the Bambuddy path's picker reads SB spools (#6262)`.

### Task 8: Stored spool ids become SB numbers

**Files:**
- Create: `backend/scadbuddy/migrations/<ts>_filament_plan_spool_numbers.sql`
- Test: `backend/tests/filament/test_plan_numbers_migration.py`

**Interfaces:**
- Rewrites every positive spool id through `filament_bb_links (bb_spool_id → spool_id → filament_spools.number)`, in: `model_print_choices.choices->'filament_plan'[*].spool_id`; `order_item_quotes.filament_plan->'slots'[*].spool_id` (the column `20261108T1508Z_order_quote_print_setup.sql` added); the stored `storefront_slice_profile`'s `spools` values (where `library/settings_store.py` keeps it); `filaments.spool_ids`; `rack_nozzle_pick_spools.spool_id`. An id with no link: dropped from a plan or a slice profile, removed from `spool_ids`, set `NULL` in a rack pick (its label stays, as an untracked spool's row does, `rack/usage.py`). Negative ids are left alone.
- Must ship with Task 7 (same PR).

- [ ] **Step 1: Failing test:** before the file, BB 41 linked to SB #3, BB 99 unlinked, SB #99 exists; a remembered plan `[{1, 41}, {2, 99}, {3, -2}]` → after: `[{1, 3}, {3, -2}]` — slot 2 is not `99` (Review Focus 1); a quote plan, a slice profile, `spool_ids {41, 99}` → `{3}`, a rack pick 99 → `NULL` with its label.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Write the migration.
- [ ] **Step 4:** Run it and `tests/test_pg_migrations.py` — PASS.
- [ ] **Step 5:** Commit `feat(filament): remembered and quoted spools name SB spools (#6262)`.

### Task 9: Orders and the agent's inventory read SB spools; alpha-aware matching (#6316)

**Files:**
- Modify: `backend/scadbuddy/orders/integrations.py` (`ShelfSpool`, `SpoolGroup`), `orders/bambuddy.py` (drop `spool_inventory` and the spool read for groups), `orders/spools.py`, `orders/spool_import.py`, `orders/component.py` (inject `FilamentInventory`), `api/orders.py` (item print passes the registry printer), `api/farm.py` (remove `GET /farm/inventory`, `GET /farm/spools/{id}/summary`), `api/filament.py`, `agent/src/tools/farm.ts`, `agent/src/tools/orders.ts` (`price_book_import_spools` description), `agent/src/tools/coverage.ts`
- Test: `backend/tests/orders/test_spools.py`, `test_spool_import.py`, `backend/tests/api/test_filament.py`, `agent/test/farm.test.ts`, `agent/test/orders.test.ts`

**Interfaces:**
- `ShelfSpool`: `id: int` is the SB `number`; gains `rgba: str | None` (`#RRGGBBAA`); `loaded_printer_id: int | None` becomes `loaded_printer: str | None` (registry id). Built from `FilamentInventory.rows(include_archived=True)`.
- `item_plan(store, inventory: FilamentInventory, item_id, plan, printer: str | None)`; it no longer needs Bambuddy (`integrations.linked` check removed).
- `record_rgba(record: Filament) -> str` = `record.colour + f"{record.alpha:02X}"` (`orders/spools.py`); `_of` compares `spool.rgba` with the link's `spool_colour` + record alpha, else `record_rgba(record)` — never RGB alone (#6316 reader 3).
- `spool_import.py`: groups are SB spools by effective (material, subtype, brand, RGBA); `_by_colour` and the `colour_taken` check compare `#RRGGBBAA` (#6316 readers 1 and 2); `spool_ids` are SB numbers; the cost is the newest priced spool's `cost_per_kg` (highest `number`).
- Routes: `GET /filament/inventory` → `FilamentInventoryView(spools: list[InventorySpool], trays: list[PrinterTrays])` (each registry printer's reported trays with the held spool); `GET /filament/spools/{spool_id}/summary?grams=` → `SpoolSummary` (the same fields `farm.py`'s answered: remaining, place, cost per kg, value left, the same-filament stock). Tools `get_spool_inventory` and `get_spool_summary` keep their names and point at these; `bambuddyScope` is removed from both; `get_spool_summary`'s `spool_id` becomes an SB spool id (uuid), as `get_spool_inventory` lists them.

- [ ] **Step 1: Failing tests (one per #6316 reader, each with an opaque and a translucent row of one hue):** `test_import_by_colour_keeps_alpha_apart` (book rows `#FFFFFF`/`FF` and `#FFFFFF`/`80`; opaque group → links the opaque row only); `test_an_opaque_group_is_not_colour_taken_by_a_translucent_row`; `test_item_print_fills_the_spool_of_its_alpha` (`fill_plan` picks the translucent spool for the translucent record, the opaque for the opaque). Also `test_item_print_needs_no_bambuddy` (integrations not linked, SB spools loaded → filled); `test_inventory_route_lists_sb_spools`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/orders tests/api/test_filament.py tests/api/test_farm.py tests/test_orders_bambuddy_seam.py`; `cd agent && pnpm gen:api && pnpm test farm orders coverage && pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `fix(orders): orders read SB spools and match colour with alpha (#6262, #6316)`.

### Task 10: The pull maps BB's spool catalog to insert types

**Files:**
- Create: `backend/scadbuddy/migrations/<ts>_filament_insert_bb_catalog.sql`
- Modify: `backend/scadbuddy/bambuddy/client.py`, `bambuddy/models.py`, `filament/bambuddy_pull.py`, `filament/catalog.py` (`insert-types` exposes `bb_catalog_id` read-only)
- Test: `backend/tests/filament/test_bambuddy_pull.py`, `backend/tests/bambuddy/test_client.py`

**Interfaces:**
- Migration: `filament_insert_types.bb_catalog_id integer UNIQUE` (nullable).
- `BambuddyClient.spool_catalog() -> list[SpoolCatalogEntry]` (`GET /api/v1/inventory/catalog`, `CatalogEntry {id, name, weight}` per the 1.2.6b1 OpenAPI of spec §3; a `Scope` like `spools()`'s; a recording in `tests/bambuddy/recordings/`).
- `pull(..., catalog: Sequence[SpoolCatalogEntry])`: once per pull, each entry becomes the insert type with that `bb_catalog_id`, else the unlinked one whose `upper(name)` matches (linked), else a new one (`empty_weight_g = weight`, insert material none). A BB spool's `core_weight_catalog_id` sets its insert type: on the type when the spool is created with a new type, else as the spool's override only when it differs from the type's. A catalog read that fails leaves insert types alone and pulls the rest (logged, counted in `PullReport.catalog_failed: bool`).
- The module docstring's "the insert type is not pulled" sentence changes to say what it does now.

- [ ] **Step 1: Failing tests:** `test_a_bb_catalog_entry_becomes_an_insert_type` (entry 5 "Bambu reusable" 250 g → insert type with `bb_catalog_id=5`); `test_a_second_pull_reuses_it` (no new row); `test_a_spool_takes_its_core_weight_insert_type`; `test_a_failed_catalog_read_pulls_the_spools_anyway`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/filament tests/bambuddy/test_client.py tests/test_spool_refresh_replay.py` — PASS.
- [ ] **Step 5:** Commit `feat(filament): the Bambuddy pull maps its spool catalog to insert types (#6262)`.

## Part C — retire the old surface

### Task 11: Remove the native API, its tools and its store

**Files:**
- Delete: `backend/scadbuddy/api/native_spools.py`, `backend/scadbuddy/spools/native.py`, `agent/src/tools/nativeSpools.ts`, `agent/test/nativeSpools.test.ts`, `backend/tests/api/test_native_spools.py`, `backend/tests/spools/test_native*.py`, `backend/tests/filament/test_native_adapter.py`
- Modify: `main.py`, `worker.py`, `api/crud_print.py` and `crud/print.py` (drop `/native-spools*` and `RemoteNativeSpools`), `printers/print_activities.py`, `agent/src/tools/index.ts`, `agent/src/resources/catalog.ts`, `agent/src/sessions/touched.ts`, `docs/ai/mcp-resources.md`, `.claude/skills/filament-intake/SKILL.md` (tool names)
- Test: `backend/tests/api/test_routes.py`, `tests/api/test_openapi.py`, `agent/test/coverage.test.ts`, `agent/test/resources.test.ts`

**Interfaces:**
- After it, `grep -rn "native_spool\|native-spools\|NativeSpoolStore" backend/scadbuddy agent/src frontend/src` finds only migrations. `backend/tests/auth/test_revoke.py` keeps its table names only if Task 12's drop leaves them; else it names the remaining tables.

- [ ] **Step 1:** Change `test_routes.py`'s expected route list (no `/native-spools`); add `test_native_spool_tools_are_gone` in `agent/test/coverage.test.ts` (no `ALL_TOOLS` name starts `native_spool_`).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Delete and rewire.
- [ ] **Step 4:** Run backend `tests/api tests/crud tests/printers`, agent `pnpm gen:api && pnpm test && pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `refactor(filament): retire the native spool API and tools (#6262)`.

### Task 12: Remove the provider overlay; drop the old tables

**Files:**
- Create: `backend/scadbuddy/migrations/<ts>_filament_carry_overlay.sql`, `<ts+1>_drop_native_and_overlay.sql`
- Delete: `backend/scadbuddy/spools/overlay.py`, `providers.py`, `spool_providers.py`, `seen.py`, the overlay half of `store.py`, `backend/scadbuddy/bambuddy/spool_providers.py`, their tests
- Modify: `backend/scadbuddy/spools/activities.py`, `workflows/spool_refresh.py`, `spools/component.py`, `printers/store.py` (the `tray_spool_links` merge reference goes; `filament_locations` already merges), `api/crud_print.py` (drop `/spools/records`, `/spools/refreshes/*`, `/spools/overlay`), `crud/print.py` (`RemoteSpoolStore`), `core/settings.py` comment for `spool_overlay_refresh_seconds`
- Test: `backend/tests/filament/test_carry_overlay.py`, `backend/tests/test_spool_refresh_replay.py`, `backend/tests/test_pg_migrations.py`

**Interfaces:**
- Carry (first file): each `tray_spool_links` row whose `physical_spool_id` is a `filament_spools.id` → that spool's location becomes the AMS tray location (created like `ensure_ams`, kind `AMS`), `tray_fingerprint` = the link's fingerprint with `FF` appended to its colour part (the old one had no alpha), one `moved` event (actor `system:migration`); each `spool_record_links` row of provider `bambuddy` whose physical spool is an SB spool with no `filament_bb_links` row → a link row (`bb_spool_id = record_id::int`, `bb_updated_at` NULL so the next pull refreshes it).
- Drop (second file): `native_spool_uses`, `native_spools`, `tray_spool_links`, `spool_record_links`, `spool_provider_records`, `spool_provider_refreshes`, `physical_spools`.
- `SpoolRefresh.run`: behind `workflow.patched("spool-providers-gone")` it runs only the held presets and the BB pull; the old activity names (`LIST_ACTIVITY`, `PROVIDER_ACTIVITY`, `SEEN_ACTIVITY`) stay registered and return `[]` / an empty outcome, with a comment naming the patch; removing them is a later PR once no history names them.
- `spool_overlay_refresh_seconds` keeps its env name (no settings migration); its comment and help say it is the Bambuddy pull and held-presets interval.

- [ ] **Step 1: Failing tests:** `test_a_tray_link_becomes_a_tray_place` (before: SB spool S and a `tray_spool_links` row `PLA|FF0000` at tray 0/1 → after: S's location is that tray, fingerprint `PLA|#FF0000FF`, a `moved` event); `test_a_bambuddy_record_link_becomes_a_bb_link`; `test_the_old_tables_are_gone`; the replay test with a pre-patch history and a post-patch run.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Write both migrations; delete the code; patch the workflow.
- [ ] **Step 4:** Run `tests/filament tests/spools tests/test_spool_refresh_replay.py tests/test_pg_migrations.py tests/printers tests/auth/test_revoke.py tests/api` — PASS. Run `e2e-stack/run.sh --mode recorder` — zero Bambuddy calls.
- [ ] **Step 5:** Commit `refactor(spools): remove the provider overlay and drop its tables (#6262)`.

### Task 13: Settings is configuration only

**Files:**
- Delete: `frontend/src/pages/settings/sections/inventory.tsx`, `native-spools.tsx`, `frontend/src/pages/settings/SpoolInventoryPanel.tsx` (+ test), `frontend/src/components/settings/NativeSpools.tsx` (+ test), `frontend/src/mocks/features/nativeSpools.ts`, `spoolInventory.ts`
- Create: `frontend/src/pages/settings/sections/filament.tsx` (+ test)
- Modify: `backend/scadbuddy/core/settings.py`, `library/settings_store.py`, `api/settings.py`, `frontend/src/pages/settings/fields.ts`, `areas.ts` (`LEGACY_ANCHORS`), `sections/orders.tsx` (no `FilamentsEditor`), `frontend/src/mocks/fixtures.ts`
- Test: `backend/tests/api/test_settings.py`, `frontend/src/pages/settings/sections/filament.test.tsx`, `frontend/src/pages/settings/registry.test.ts`

**Interfaces:**
- Backend settings (runtime, env-seeded like their neighbours): `filament_bb_pull: Literal["off", "bb_to_sb"] = "bb_to_sb"` (the pull activity skips when `off`; the replay-safe check is inside the activity, not the workflow); `filament_low_stock_pct: int = Field(default=20, ge=0, le=100)`; `filament_default_cost_per_kg: Decimal | None = Field(default=None, ge=0)`. `SectionId` gains `'filament'`; `spool_overlay_refresh_seconds` moves from `administration` to `filament`, label "Pull from Bambuddy every".
- Section `filament`, area `printing`, order 30, title "Filament". It shows the four fields, the currency read-only with an `AppLink` to `#orders`, and one line with a link to `/filament` ("Spools, types and tags are in Filament.").
- `LEGACY_ANCHORS`: `inventory` and `native-spools` → `{ area: 'printing', section: 'filament' }`.

- [ ] **Step 1: Failing tests:** backend `test_filament_settings_round_trip` (PUT then GET; 422 for 101 %); frontend `filament.test.tsx` (renders the four fields; saving sends `filament_low_stock_pct`), `registry.test.ts` `resolves the old spool anchors to Filament` (`resolveLocation('/settings', '#native-spools')` → `{area: 'printing', hash: '#filament'}`), and no section titled "Spool inventory" or "ScadBuddy's spools".
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run backend tests; `cd frontend && pnpm gen:api && pnpm typecheck && pnpm exec vitest run src/pages/settings` — PASS.
- [ ] **Step 5:** Commit `feat(settings): a Filament configuration section; spools leave Settings (#6262)`.

## Part D — the Filament section

Design direction for every task below (the implementer still runs the
frontend-design process; this is the brief). The subject is a shop's physical
filament: spools of coloured plastic, many translucent. The one memorable element is the
**spool chip**: an RGBA disc on a checkerboard with a thin ring that shows grams left as an
arc. Everything else stays quiet and uses the app's existing tokens, shadcn components and
type (`index.css`); no new palette. Tables are dense and left-aligned; numbers are
right-aligned with tabular figures. Bambu Studio is the capability bar (vision memory):
every value its filament settings hold for a spool has a place on the edit page, with
fewer clicks; the builder cites the Bambu Studio source they compare against.

### Task 14: The section's frame, client, mocks and RGBA controls

**Files:**
- Create: `frontend/src/api/filament.ts`, `frontend/src/pages/filament/FilamentPage.tsx`, `frontend/src/pages/filament/tabs.ts`, `frontend/src/components/filament/RgbaSwatch.tsx`, `RgbaColourField.tsx`, `frontend/src/lib/rgba.ts`, `frontend/src/mocks/features/filament/index.ts`, `seed.ts`
- Modify: `frontend/src/App.tsx`, `frontend/src/components/AppShell.tsx` (nav item "Filament" between Library and Orders, `/filament`), `frontend/src/components/print/Swatch.tsx` (delegates to `RgbaSwatch`)
- Test: `frontend/src/lib/rgba.test.ts`, `components/filament/RgbaSwatch.test.tsx`, `RgbaColourField.test.tsx`, `pages/filament/FilamentPage.test.tsx`

**Interfaces:**
- `lib/rgba.ts`: `parseRgba(value: string): string | null` (as the backend's `normalise_rgba`: `#RRGGBB` → `…FF`, upper case); `alphaOf(rgba: string): number` (0-255); `withAlpha(rgba: string, alpha: number): string`; `isTranslucent(rgba: string): boolean`; `CLEAR_ALPHA = 0x10`, `TRANSLUCENT_ALPHA = 0x80` (spec §5.1 presets: clear `00`-`20`, translucent `80`).
- `RgbaSwatch({ rgba, size?: 'sm'|'md'|'lg', gramsLeft?: number | null, labelWeight?: number | null })`: the colour over a checkerboard (CSS `conic-gradient` checker under the colour layer), `data-colour` the `#RRGGBBAA`, the grams arc only when both weights are known.
- `RgbaColourField({ value, onChange, inherited?: string | null })`: hex input, native colour input for RGB, an opacity slider (0-100 %, shadcn `Slider`), preset buttons "Opaque", "Translucent", "Clear", and the swatch. `inherited` shows the type's value as a placeholder when `value` is `null`.
- `tabs.ts`: `FILAMENT_TABS: readonly { id: TabId; title: string; path: string; available: boolean }[]` with ids `spools, types, tags, suppliers, invoices, locations, catalog, shopping-list, ledger, metrics` in spec §10's order; `available` false for `suppliers, invoices, shopping-list, metrics`. `FilamentPage({ tab })` renders `NavLink` tabs (the `WorkflowsPage` pattern) for available tabs only; `/filament` redirects to `/filament/spools`.
- `api/filament.ts`: one typed function per route the tabs use (`listSpools`, `getSpool`, `patchSpool`, `createSpool`, `archiveSpool`, `deleteSpool`, `bindTag`, `unbindTag`, `setSpoolPresets`, `setSpoolKValues`, `moveSpool`, `listTypes`, `getType`, `upsertType`, `setTypePresets`, `setTypeKValues`, `listCatalog`, `upsertCatalog`, `listLocations`, `upsertLocation`, `listTags`, `getTag`, `listEvents`, `getSummary`), typed from `schema.d.ts`.
- Mocks: every `/api/v1/filament/*` route over an in-memory seed of 12 spools (opaque, translucent `80`, clear `10`, one needing a type, one with material `Unknown`, one archived with a last tag now on another spool), with `reset`.

- [ ] **Step 1: Failing tests:** `parseRgba('#ff8800') === '#FF8800FF'`; `withAlpha('#FF8800FF', 0x80) === '#FF880080'`; swatch renders `data-colour="#FFFFFF80"` and a checker layer; the field's "Translucent" sets alpha `80` and calls `onChange('#RRGGBB80')`; the slider at 50 % gives alpha `80`; `FilamentPage` shows six tabs and no "Invoices".
- [ ] **Step 2:** Run `pnpm exec vitest run src/lib/rgba.test.ts src/components/filament src/pages/filament` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them, `pnpm lint && pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(filament): the Filament section's frame and RGBA swatch (#6262)`.

### Task 15: Spools tab, with CSV export and import

**Files:**
- Create: `backend/scadbuddy/filament/csv_import.py`, `frontend/src/components/filament/SpoolImport.tsx`
- Modify: `backend/scadbuddy/api/filament.py`, `agent/src/tools/filament.ts`
- Test: `backend/tests/filament/test_csv_import.py`, `backend/tests/api/test_filament.py`, `agent/test/filament.test.ts`, `frontend/src/components/filament/SpoolImport.test.tsx`
- Create: `frontend/src/pages/filament/SpoolsTab.tsx`, `frontend/src/components/filament/spoolsQuery.ts`, `SpoolsTable.tsx`, `SpoolCards.tsx`, `SpoolTiles.tsx`, `BulkBar.tsx`, `spoolsCsv.ts`
- Test: `spoolsQuery.test.ts`, `spoolsCsv.test.ts`, `pages/filament/SpoolsTab.test.tsx`

**Interfaces:**
- `spoolsQuery.ts`: `SpoolsQuery = { view: 'table'|'cards', status: 'active'|'archived'|'all', needsType?: boolean, lowStock?: boolean, used?: boolean, fresh?: boolean, material?: string, brand?: string, insertType?: string, location?: string, group?: 'none'|'material'|'brand'|'type'|'location', columns: ColumnId[], sort: string }`; `readQuery(params: URLSearchParams): SpoolsQuery`, `writeQuery(q): URLSearchParams` (state in the URL, as `listingsQuery.ts` does); `filterSpools(spools, q)`, `groupSpools(spools, group)`. "used" = grams left below label weight; "new" = no print event (`in_use` false) and grams left at label weight.
- Columns picker: the chosen columns are remembered per viewer in `localStorage` (try/catch; a view convenience, not a print option).
- Tiles from `GET /filament/summary`: total spools, grams left, by material (top 5), loaded, low stock, needs type; each tile click sets its filter.
- Bulk: select rows → Archive, Restore, Delete (only for rows with `in_use` false; others are named and skipped), Move to location, Set type. One request per spool; the bar reports each failure by spool number.
- CSV export: `spoolsCsv(spools, columns): string` (RFC 4180 quoting), downloaded through `lib/embed.ts` `downloadBlob` (the Bambuddy iframe rule).
- A row links to `/filament/spools/<id>`; "needs type" and `Unknown` material show a badge with "Set type".
- CSV import (owner ruling): the same columns the export writes (`SPOOL_CSV_COLUMNS`, one list shared by `spoolsCsv` and the backend's `csv_import.COLUMNS`, pinned by a test that compares them). The browser parses the file and sends rows as JSON (no file bytes in text).
  - Backend: `import_rows(store: Filament, rows: Sequence[CsvRow], *, dry_run: bool, actor: str) -> ImportPreview` with `ImportPreview(rows: list[ImportRowResult])`, `ImportRowResult(line: int, action: Literal["create", "update", "error"], number: int | None, changes: dict[str, list[Any]], error: str | None)`. A row with `number` updates that spool (only the fields that differ); an unknown `number` is an error; a row with no `number` creates a spool. Catalog names (material, subtype, brand, category, effect, insert type, location) resolve by `upper(name)` and are inserted when missing, as the pull does (`bambuddy_pull.py`); in a dry run a missing name is reported in `changes` as `"new": true` and nothing is inserted. `dry_run=false` writes every row in one transaction and refuses (422, nothing written) when any row is an error.
  - Route `POST /filament/spools/import` (body `{rows: list[CsvRow], dry_run: bool}`) → `ImportPreview`; tool `filament_spool_import` (write; its handler always sends `dry_run: true` first and returns the preview when the caller asked for a preview only).
  - UI: `SpoolImport` — choose a file, the preview table (create/update/error per line with its changes), "Import N spools" enabled only with no errors, then the tab reloads.

- [ ] **Step 1: Failing tests:** backend `test_a_dry_run_writes_nothing` (two rows → one `create`, one `update`; spool count and catalog rows unchanged); `test_a_row_with_a_number_updates_only_what_differs` (one `edited` event naming only `note`); `test_an_unknown_number_is_an_error_and_blocks_the_import` (422, nothing written); `test_a_missing_catalog_name_is_inserted_once` (two rows naming brand "Sunlu" → one brand row, upper-case match with "SUNLU"); `test_import_reads_what_export_writes` (columns equal). Frontend: the preview lists an error line and disables Import; a clean preview's Import sends `dry_run: false`. Then `readQuery(writeQuery(q))` round-trips; `filterSpools` with `lowStock` keeps only the low ones by the summary's rule; the CSV quotes a name with a comma; the tab shows the 11 active seed spools, the translucent one's swatch `#…80`; bulk Delete skips an in-use spool and names it.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the backend tests, agent `pnpm gen:api && pnpm test filament coverage && pnpm typecheck`, frontend `pnpm gen:api && pnpm lint && pnpm typecheck` and the vitest files — PASS.
- [ ] **Step 5:** Commit `feat(filament): the Spools tab with CSV export and import (#6262)`.

### Task 16: Types tab with the price book

**Files:**
- Create: `frontend/src/pages/filament/TypesTab.tsx`, `frontend/src/pages/filament/TypePage.tsx`, `frontend/src/components/filament/PresetTable.tsx`, `KValueTable.tsx`
- Move: `frontend/src/components/orders/FilamentsEditor.tsx` (+ test) → used by `TypesTab` as the "Price book" panel; its imports from `orders/` stay
- Test: `pages/filament/TypesTab.test.tsx`, `TypePage.test.tsx`, `components/filament/PresetTable.test.tsx`

**Interfaces:**
- Route `/filament/types/<id>` (or `new`): the type's fields (catalog selects from `listCatalog`, `RgbaColourField`, weights, temperatures, cost per kg, low stock %, insert type), its presets per printer model and nozzle (`PresetTable` rows `{printer_model, nozzle_diameter, slicer_filament, slicer_filament_name}`, no `*`), its K values, and its spools. Save sends one PATCH and, when changed, the preset and K PUTs. Unsaved edits hold navigation (`lib/useLeaveGuard.ts`).
- `PresetTable({ rows, onChange, inherited?: EffectivePreset[] })` is shared with Task 17: with `inherited`, a row the spool does not override shows the type's value dimmed with "From type"; an overridden row shows "Reset to type".
- The Price book panel lists book rows; a row linked to a type links to it; a row with no type has "Make a type" (POST `/filament/types` from its identity and cost).

- [ ] **Step 1: Failing tests:** the list shows each type's code, colour and price; saving a type with a new 0.6 preset sends `PUT …/presets` with the row; the preset table refuses `*` as a nozzle; "Make a type" posts the book row's material, colour and alpha.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; also `pnpm exec vitest run src/components/orders/FilamentsEditor.test.tsx` — PASS.
- [ ] **Step 5:** Commit `feat(filament): the Types tab and the price book (#6262)`.

### Task 17: The spool edit page

**Files:**
- Create: `frontend/src/pages/filament/SpoolPage.tsx`, `frontend/src/components/filament/SpoolSections.tsx`, `OverrideField.tsx`, `TagPanel.tsx`, `GramsBasis.tsx`
- Test: `pages/filament/SpoolPage.test.tsx`, `components/filament/OverrideField.test.tsx`, `TagPanel.test.tsx`

**Interfaces:**
- Route `/filament/spools/<id>` (or `new`). One page, sections in spec §10's order, each a landmark with a heading and in-page anchors: **Identity** (number, type picker with "Create type from this spool", tags), **Weight** (label, empty from insert type, measured, grams left with `GramsBasis`, weight lock), **Colour and cost** (`RgbaColourField`, colour name, extra colours, effect, cost per kg; invoice link hidden until #6266), **Printers** (`PresetTable` and K values with `inherited`), **Storage** (location via `moveSpool`, last dried), **History** (the ledger list for this spool; the chart and metrics arrive with #6269). At ≥1024 px a sticky section index sits left; below it the sections stack and the index becomes a select (spec §13).
- `OverrideField({ name, value, effective, inherited, onChange, onReset })`: when the spool overrides the field (`overridden.includes(name)`) it shows a mark ("Set on this spool") and "Reset to type", which sends `null` for that field.
- Migrated values (phase 1 decision): material `Unknown` shows "Choose a material" with the material select open; a needs-type spool shows the type picker first.
- `TagPanel({ spool })`: the open tag with "Take off"; "Bind a tag" (tag uid or tray uuid, kind, override flag); for a spool with no tag and a `last_tag`, "Bind tag again" when `held_by` is null, else "Tag is on spool #N — Move it here" (Decision 7). Both call `bindTag` with the last tag's keys.
- Restore (archived spool header) calls `archiveSpool(id, false)` and nothing else; the TagPanel then shows the last tag.
- Delete is offered only when `in_use` is false; otherwise "Archive" with the reason ("It has prints, so job costs keep their source").

- [ ] **Step 1: Failing tests:** reset of an overridden colour sends `PATCH {rgba: null}` and the mark disappears after the answer (Review Focus 5); a restored spool shows "Tag is on spool #3 — Move it here" and its click posts the tag to this spool (Review Focus 4); `Unknown` material shows "Choose a material"; an in-use spool has no Delete; the Printers section shows a type preset as "From type".
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, `pnpm lint && pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(filament): the spool edit page (#6262)`.

### Task 18: Tags, Locations, Catalog and Ledger tabs

**Files:**
- Create: `frontend/src/pages/filament/TagsTab.tsx`, `LocationsTab.tsx`, `CatalogTab.tsx`, `LedgerTab.tsx`, `frontend/src/components/filament/CatalogList.tsx`, `LocationTree.tsx`
- Test: one `*.test.tsx` per tab

**Interfaces:**
- Tags: every tag, kind, current spool (link), bound since, override flag; a row opens its history (`getTag`). Filter by kind and bound/unbound.
- Locations: the tree (`listLocations`), each node's spool count and spools; add, rename, re-parent (a cycle's 409 is shown inline), archive. AMS tray locations are read-only (named by printer). Sensors and QR labels arrive with #6268/#6264 and are not shown.
- Catalog: one `CatalogList({ kind })` per catalog kind of `CATALOGS` (materials, subtypes, brands, categories, effects, insert types, insert materials, location kinds, colours); add, rename, re-order (`sort_order`), archive and restore; materials and subtypes edit their value columns; colours use `RgbaColourField`; insert types show `bb_catalog_id` read-only.
- Ledger: `listEvents` paged by `next_before`, filters spool number, kind, source and date range in the URL; each row links its spool.

- [ ] **Step 1: Failing tests:** Tags lists a rebound tag on its new spool; Locations shows the 409 text for a cycle; Catalog archives "Wood" and it leaves the default list but shows under "Archived"; Ledger's "Older" asks with `before`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, `pnpm lint && pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(filament): the Tags, Locations, Catalog and Ledger tabs (#6262)`.

### Task 19: The print dialog's picker on SB spools

**Files:**
- Modify: `frontend/src/components/FilamentPicker.tsx` (+ test), `frontend/src/lib/filaments.ts` (+ test), `frontend/src/components/print/TrayQuestion.tsx` (+ test), `frontend/src/components/orders/QuoteFilaments.tsx`, `frontend/src/mocks/features/hotPath.ts`, `printPreview.ts` and the print-dialog mocks that answer `FilamentOptions`
- Test: `FilamentPicker.test.tsx`, `TrayQuestion.test.tsx`, `lib/filaments.test.ts`

**Interfaces:**
- `providerLabel`, `records` and `overlay_notes` rendering are removed. A row shows `RgbaSwatch` with `rgba` and the grams arc, the SB number (`#7`), brand/material/subtype/colour name, and a "Needs type" badge linking to `/filament/spools/<sb_spool_id>` (opens in a new tab when embedded, `embed.ts` rule).
- `TrayQuestion` answers with `{ spool_id: <sb uuid> }` on the native path and `{ spool_id: <sb number> }` on the Bambuddy path (Tasks 4, 7).
- The chosen spool per slot and "Wait for the right colour" still go through the dialog's Remember toggle (`toRemember`), unchanged; a test pins it.

- [ ] **Step 1: Failing tests:** a translucent spool row has `data-colour` ending `80`; a needs-type spool shows the badge; the tray question posts the SB id; remembering a plan sends `filament_plan` with SB numbers.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm exec vitest run src/components/FilamentPicker.test.tsx src/components/print src/lib/filaments.test.ts`, `pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(print): the filament picker shows SB spools with RGBA (#6262)`.

### Task 20: End-to-end, docs and the PR

**Files:**
- Create: `frontend/e2e/filament.spec.ts`
- Modify: `frontend/e2e/hot-path.spec.ts`, `print.spec.ts`, `settings.spec.ts`, `phone-width.spec.ts`, `page-titles.spec.ts` (`PAGES` gains `/filament/spools`, `/filament/spools/<seed id>`, `/filament/types`, `/filament/tags`, `/filament/locations`, `/filament/catalog`, `/filament/ledger`; each page has an `<h1>`, `usePageTitle`); `backend/CLAUDE.md` (hot path paragraph: SB tray resolution replaces the overlay; `filament/` paragraph: `inventory.py`, `presets.py`, `print_uses.py`; orders paragraph: SB spools, RGBA matching), `frontend/CLAUDE.md` (a Filament section entry: routes, mocks, e2e), `agent/CLAUDE.md` if it names the native tools, `docs/superpowers/specs/2026-11-14-filament-management-design.md` (§5.1's "until #6262" sentence and §5.5's "dropped in #6262" become past tense)

**Interfaces:**
- `filament.spec.ts`: open `/filament` → Spools; filter low stock; open the translucent spool; set opacity to Clear and save; reset its colour to the type; restore the archived spool and move its tag back; at 390 px the edit page has no horizontal scroll and the section select works.
- `hot-path.spec.ts`: the trays show SB spool numbers, still with zero Bambuddy calls (`bambuddyCalls`).
- `settings.spec.ts`: `/settings#native-spools` lands on the Filament section.

- [ ] **Step 1:** Write the specs.
- [ ] **Step 2:** Run `pnpm build && pnpm exec playwright test e2e/filament.spec.ts e2e/hot-path.spec.ts e2e/print.spec.ts e2e/settings.spec.ts e2e/phone-width.spec.ts` — FAIL first, then PASS after fixes.
- [ ] **Step 3:** Update the docs; grep each changed fact (`native-spools`, `overlay`, `NativeSpools.tsx`, `spool_provider`) across `CLAUDE.md` files and fix every copy.
- [ ] **Step 4:** Whole-branch check: backend `uv run --frozen pytest -n auto`, ruff, mypy; frontend `pnpm lint && pnpm typecheck && pnpm test && pnpm build`; agent `pnpm test && pnpm typecheck`; `e2e-stack/run.sh --mode recorder`.
- [ ] **Step 5:** Commit `docs(filament): notes for the Filament section and SB spools (#6262)`; open the PR `feat(filament): Filament section, spool edit page, SB spools everywhere (#6262)`, body `Closes #6262`, `Closes #6316`, the four parts and what each leaves working, a section naming the removed tools `native_spool_list`, `native_spool_get`, `native_spool_upsert` and `native_spool_delete` with their `filament_*` replacements, so a saved flow's author knows what to change, the session marker and the footer.

## Decisions made while building (#6262)
