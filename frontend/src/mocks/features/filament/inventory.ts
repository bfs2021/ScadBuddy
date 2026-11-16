import { HttpResponse, http } from 'msw'
import type { FilamentInventorySpool, FilamentInventoryView, FilamentSpool } from '../../../api/types'

/**
 * #6262 Task 9 — ScadBuddy's spools as `GET /filament/inventory` lists them (backend
 * `api/filament.py`, `filament/inventory.py` `view`): a priced spool on the shelf, a clear
 * one loaded in the H2C's AMS, an unpriced one, and an archived spool listed only when
 * asked for. Their numbers are none of Bambuddy's ids, so a reader that still takes a
 * Bambuddy id shows up.
 */

const AT = '2026-11-15T07:00:00Z'

type Look = {
  id: string
  number: number
  material: string
  subtype?: string | null
  brand: string
  colour_name: string
  rgba: string
  grams_left: number
  cost_per_kg: string | null
  archived?: boolean
}

/** A full SB spool from its look; its own and effective values agree. */
export function sbSpool(look: Look): FilamentSpool {
  return {
    id: look.id,
    number: look.number,
    type_id: null,
    brand_id: null,
    material_id: null,
    subtype_id: null,
    category_id: null,
    effect_id: null,
    colour_name: look.colour_name,
    rgba: look.rgba,
    extra_colours: null,
    diameter_mm: '1.75',
    density_g_cm3: null,
    nozzle_temp_min: null,
    nozzle_temp_max: null,
    bed_temp_min: null,
    bed_temp_max: null,
    label_weight_g: 1000,
    insert_type_id: null,
    low_stock_pct: null,
    cost_per_kg: look.cost_per_kg,
    location_id: null,
    weight_locked: false,
    note: null,
    grams_left: look.grams_left,
    last_weighed_g: null,
    last_weighed_at: null,
    last_dried_at: null,
    last_dried_temp_c: null,
    last_dried_hours: null,
    last_used_at: null,
    archived_at: look.archived ? AT : null,
    created_at: AT,
    updated_at: AT,
    low_stock: false,
    overridden: [],
    names: { material: look.material, subtype: look.subtype ?? null, brand: look.brand },
    effective: { colour_name: look.colour_name, rgba: look.rgba, cost_per_kg: look.cost_per_kg, label_weight_g: 1000 },
  }
}

/** The registry printer the clear spool is loaded in. */
const H2C = { printer_id: '00000000-0000-4000-8000-00000000f262', printer_name: '3DP-31B-598', bambuddy_printer_id: null }

export const SB_INVENTORY: FilamentInventorySpool[] = [
  {
    spool: sbSpool({
      id: '62620000-0000-4000-8000-000000000003',
      number: 3,
      material: 'PLA',
      subtype: 'Basic',
      brand: 'Bambu Lab',
      colour_name: 'Hot Pink',
      rgba: '#F5547CFF',
      grams_left: 930,
      cost_per_kg: '15.91',
    }),
    loaded: null,
    bb_spool_id: null,
    presets: [],
  },
  {
    spool: sbSpool({
      id: '62620000-0000-4000-8000-000000000008',
      number: 8,
      material: 'PETG',
      brand: 'Insignia',
      colour_name: 'Clear',
      rgba: '#00000000',
      grams_left: 400,
      cost_per_kg: '15.96',
    }),
    loaded: { ...H2C, ams_id: 0, tray_id: 3 },
    bb_spool_id: null,
    presets: [],
  },
  {
    spool: sbSpool({
      id: '62620000-0000-4000-8000-000000000011',
      number: 11,
      material: 'PLA',
      subtype: 'Basic',
      brand: 'Bambu Lab',
      colour_name: 'Mistletoe Green',
      rgba: '#3F8E43FF',
      grams_left: 1000,
      cost_per_kg: null,
    }),
    loaded: null,
    bb_spool_id: null,
    presets: [],
  },
  {
    spool: sbSpool({
      id: '62620000-0000-4000-8000-000000000019',
      number: 19,
      material: 'PLA',
      brand: 'Inland',
      colour_name: 'Black',
      rgba: '#1A1A1AFF',
      grams_left: 0,
      cost_per_kg: '14',
      archived: true,
    }),
    loaded: null,
    bb_spool_id: null,
    presets: [],
  },
]

export const handlers = [
  http.get('/api/v1/filament/inventory', ({ request }) => {
    const archived = new URL(request.url).searchParams.get('include_archived') === 'true'
    return HttpResponse.json({
      spools: SB_INVENTORY.filter((row) => archived || !row.spool.archived_at),
      trays: [],
    } satisfies FilamentInventoryView)
  }),
]
