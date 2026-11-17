import { listCatalog, upsertCatalog, upsertType, type CatalogKind, type CatalogRows, type SpoolType } from '../../api/filament'
import type { Filament } from '../../api/types'

const same = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase()

/** What `makeTypeFromBook` added to the catalog, then the refusal of the type itself. */
export class MakeTypeError extends Error {
  override cause: unknown
  added: string[]
  constructor(cause: unknown, added: string[]) {
    super('the type was refused')
    this.cause = cause
    this.added = added
  }
}

/**
 * The row of `kind` named `name` (and, for a subtype, of `materialId`: a subtype's name is
 * unique per material), added when it is missing, as the Bambuddy pull and the CSV import
 * add one. `added` collects what this call made.
 */
async function named<K extends CatalogKind>(kind: K, name: string, added: string[], materialId?: string): Promise<CatalogRows[K]> {
  const rows = await listCatalog(kind)
  const found = rows.find((row) => same(row.name, name) && (materialId === undefined || (row as { material_id?: string | null }).material_id === materialId))
  if (found) return found
  const made = await upsertCatalog(kind, { name, ...(materialId ? { material_id: materialId } : {}) } as Parameters<typeof upsertCatalog<K>>[1])
  added.push(name)
  return made
}

/** A type's code from a book row's identity: `BAMBU-PLA-BASIC-JADE-WHITE`. */
export function typeCodeOf(row: Pick<Filament, 'brand' | 'material' | 'subtype' | 'colour_name' | 'colour'>): string {
  return [row.brand, row.material, row.subtype, row.colour_name ?? row.colour]
    .filter(Boolean)
    .join('-')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * #6262 — "Make a type": a price book row's material, subtype, brand, colour (with its
 * alpha, as `#RRGGBBAA`), effect and cost become a spool type, the identity the row
 * already has. The server links the new type to that row (`filament_id`), since the type
 * has the row's identity. A name the catalog lacks is added first (the type needs its id),
 * and stays if the type is then refused: the refusal is a `MakeTypeError` that lists them.
 */
export async function makeTypeFromBook(row: Filament): Promise<SpoolType> {
  const added: string[] = []
  const material = await named('materials', row.material, added)
  const brand = row.brand ? await named('brands', row.brand, added) : null
  const subtype = row.subtype ? await named('subtypes', row.subtype, added, material.id) : null
  const effect = row.effect ? ((await listCatalog('effects')).find((one) => same(one.name, row.effect!.replace(/-/g, ' '))) ?? null) : null
  const alpha = row.alpha.toString(16).padStart(2, '0')
  return upsertType({
    code: typeCodeOf(row),
    material_id: material.id,
    subtype_id: subtype?.id ?? null,
    brand_id: brand?.id ?? null,
    effect_id: effect?.id ?? null,
    colour_name: row.colour_name,
    rgba: `${row.colour}${alpha}`.toUpperCase(),
    extra_colours: row.extra_colours.length > 0 ? row.extra_colours : null,
    density_g_cm3: row.density_g_cm3,
    cost_per_kg: row.cost_per_kg,
    diameter_mm: '1.75',
    label_weight_g: 1000,
  }).catch((cause: unknown) => {
    throw new MakeTypeError(cause, added)
  })
}
