import type { Filament, Listing, ParamValue, PublicParam } from './api/client'
import { closestColour } from './closestColour'
import { customerFilaments, paramFilaments, startColour } from './params'

/**
 * #6258 — "choose a colour, the plastic follows". The visitor picks colours only; the
 * material is never shown. This is the page's copy of the backend's rule
 * (`backend/scadbuddy/orders/storefront/inputs.py` `resolve_choice`): change both
 * together.
 *
 * - The picked parts fix the material: the first of `listing.materials` (in order) that
 *   offers every picked colour, and also one of the choices of each part not picked.
 * - A part the visitor did not pick shows the listing default. It moves to the closest
 *   colour (`closestColour.ts`) only while that material lacks the default. It is derived
 *   from the picks and never kept as a pick.
 */

/** One colour a part offers: every filament of one hex, whatever its material. */
export interface ColourSwatch {
  /** The colour, lowercase: the key the backend compares by (casefolded). */
  key: string
  /** The colour as the listing spells it: the value the page sends. */
  colour: string
  /** What the customer reads: the colour's name, never its material. */
  name: string
  /** The first filament of the colour, which draws the swatch. */
  filament: Filament
}

const fold = (text: string) => text.toLowerCase()

/**
 * A filament's hex with its alpha, for `closestColour`: its `alpha` field (0 to 255) when
 * the shop sends one (#6211), else the hex's own AA byte, else opaque. A shop that sends
 * no `alpha` yet reads as opaque.
 */
export function filamentHex(filament: Filament): string {
  const alpha = (filament as Filament & { alpha?: number | null }).alpha
  if (typeof alpha !== 'number' || !Number.isInteger(alpha) || alpha < 0 || alpha > 255) return filament.colour
  const rgb = /^#?([0-9a-fA-F]{6})/.exec(filament.colour.trim())
  return rgb ? `#${rgb[1]}${alpha.toString(16).padStart(2, '0').toUpperCase()}` : filament.colour
}

function isColourParam(param: PublicParam): param is Extract<PublicParam, { kind: 'choice' }> {
  return param.kind === 'choice' && param.colour
}

/** The words of the listing's materials, which a name or a finish never shows. */
function materialWords(filaments: readonly Filament[]): RegExp | null {
  const words = [...new Set(filaments.map((filament) => filament.material.trim()).filter(Boolean))]
  if (words.length === 0) return null
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi')
}

/**
 * The swatches of colour part `param`: one per colour, in the listing's order. Two
 * colours of one name are told apart by their finish, then their brand, then their hex.
 */
export function colourSwatches(param: PublicParam, filaments: readonly Filament[]): ColourSwatch[] {
  const offered = paramFilaments(param, filaments)
  const strip = materialWords(filaments)
  const plain = (text: string | null | undefined) => (text ? (strip ? text.replace(strip, ' ') : text).split(/\s+/).filter(Boolean).join(' ') : '')
  const byKey = new Map<string, Filament>()
  for (const filament of offered) if (!byKey.has(fold(filament.colour))) byKey.set(fold(filament.colour), filament)
  const first = [...byKey.entries()].map(([key, filament]) => ({ key, filament, base: plain(filament.colour_name) || filament.colour.toUpperCase() }))
  const count = (keys: string[]) => keys.reduce((seen, k) => seen.set(k, (seen.get(k) ?? 0) + 1), new Map<string, number>())
  const names = count(first.map((each) => fold(each.base)))
  const withFinish = count(first.map((each) => fold(`${each.base}\u0000${plain(each.filament.subtype)}`)))
  const withBrand = count(first.map((each) => fold(`${each.base}\u0000${each.filament.brand?.trim() ?? ''}`)))
  return first.map(({ key, filament, base }) => {
    let name = base
    if ((names.get(fold(base)) ?? 0) > 1) {
      const finish = plain(filament.subtype)
      const brand = filament.brand?.trim()
      if (finish && (withFinish.get(fold(`${base}\u0000${finish}`)) ?? 0) < 2) name = `${base} (${finish})`
      else if (brand && (withBrand.get(fold(`${base}\u0000${brand}`)) ?? 0) < 2) name = `${base} (${brand})`
      else name = `${base} ${filament.colour.toUpperCase()}`
    }
    return { key, colour: filament.colour, name, filament }
  })
}

/** The name a colour goes by on `listing`: its filament's colour name, else its hex. */
export function colourName(listing: Listing, colour: string): string {
  const filament = customerFilaments(listing.colours).find((each) => fold(each.colour) === fold(colour))
  return filament?.colour_name?.trim() || colour.toUpperCase()
}

/** A part's label inside a sentence: "the rim colour" for "Rim colour". */
export function partName(label: string): string {
  return label.length > 1 && label[1] === label[1]!.toLowerCase() ? label[0]!.toLowerCase() + label.slice(1) : label
}

interface Materials {
  /** The materials the listing offers a colour in, casefolded, in the listing's order. */
  order: string[]
  /** Each material's customer filaments, in the listing's order. */
  of: Map<string, Filament[]>
}

function materials(listing: Listing): Materials {
  const allowed = listing.materials.map(fold)
  const offered = customerFilaments(listing.colours).filter((filament) => allowed.length === 0 || allowed.includes(fold(filament.material)))
  const of = new Map<string, Filament[]>()
  for (const filament of offered) of.set(fold(filament.material), [...(of.get(fold(filament.material)) ?? []), filament])
  const order = [...new Set(allowed.length > 0 ? allowed : offered.map((filament) => fold(filament.material)))].filter((m) => of.has(m))
  return { order, of }
}

const offers = (all: Materials, material: string, colour: string) => (all.of.get(material) ?? []).some((f) => fold(f.colour) === fold(colour))

/** Whether `material` offers one of the choices of part `param`. */
function offersChoice(all: Materials, material: string, param: Extract<PublicParam, { kind: 'choice' }>): boolean {
  return param.choices.some((choice) => typeof choice === 'string' && offers(all, material, choice))
}

/** The picked colour of each colour part in `values`. */
export function colourPicks(listing: Listing, values: Readonly<Record<string, ParamValue>>): Record<string, string> {
  const picks: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) {
    const param = listing.params[name]
    if (param && isColourParam(param) && typeof value === 'string') picks[name] = value
  }
  return picks
}

/** The first material that offers each of `picks` and a choice of every other colour part. */
function materialFor(listing: Listing, all: Materials, picks: Readonly<Record<string, string>>): string | null {
  return (
    all.order.find((material) =>
      Object.entries(listing.params).every(([name, param]) => {
        if (!isColourParam(param)) return true
        const pick = picks[name]
        return pick !== undefined ? offers(all, material, pick) : offersChoice(all, material, param)
      }),
    ) ?? null
  )
}

/** The colour of `material` closest to `colour`, among the choices of part `param`. */
function closestIn(listing: Listing, all: Materials, material: string, param: Extract<PublicParam, { kind: 'choice' }>, colour: string): string | null {
  const choices = new Set(param.choices.filter((c): c is string => typeof c === 'string').map(fold))
  const seen = new Set<string>()
  const candidates: Filament[] = []
  for (const filament of all.of.get(material) ?? []) {
    const key = fold(filament.colour)
    if (!seen.has(key) && choices.has(key)) {
      seen.add(key)
      candidates.push(filament)
    }
  }
  const own = customerFilaments(listing.colours).find((f) => fold(f.colour) === fold(colour))
  const index = closestColour(
    { hex: own ? filamentHex(own) : colour, name: own?.colour_name ?? null },
    candidates.map((f) => ({ hex: filamentHex(f), name: f.colour_name })),
  )
  return index === null ? null : candidates[index]!.colour
}

export interface ColourPlan {
  /** The material the picks fix, casefolded; null when no material fits them. */
  material: string | null
  /** The colour each colour part shows: its pick, else its default or the moved default. */
  shown: Record<string, string>
  /** The parts the visitor did not pick that moved off their default, to which colour. */
  moved: Record<string, string>
}

/** What `values` resolve to: the material, and the colour each part shows. */
export function colourPlan(listing: Listing, values: Readonly<Record<string, ParamValue>>): ColourPlan {
  const all = materials(listing)
  const picks = colourPicks(listing, values)
  const material = materialFor(listing, all, picks)
  const shown: Record<string, string> = {}
  const moved: Record<string, string> = {}
  for (const [name, param] of Object.entries(listing.params)) {
    if (!isColourParam(param)) continue
    const pick = picks[name]
    if (pick !== undefined) {
      shown[name] = pick
      continue
    }
    const start = startColour(param)
    if (start === undefined) continue
    shown[name] = start
    if (material === null || offers(all, material, start)) continue
    const closest = closestIn(listing, all, material, param, start)
    if (closest !== null) {
      shown[name] = closest
      moved[name] = closest
    }
  }
  return { material, shown, moved }
}

/**
 * The values the page sends: the visitor's own, and each default that moved, so the shop
 * resolves the same material (a default that fits is left out).
 */
export function sentValues(listing: Listing, values: Readonly<Record<string, ParamValue>>): Record<string, ParamValue> {
  return { ...values, ...colourPlan(listing, values).moved }
}

/** One picked part a new colour changes: from its colour to the closest in the new material. */
export interface PartChange {
  name: string
  from: string
  to: string
}

/** What picking `colour` for part `name` does. */
export type PickOutcome =
  /** It goes with the other picks: it is picked at once. */
  | { kind: 'fits' }
  /** It needs another material: these other picked parts change, if the visitor agrees. */
  | { kind: 'swap'; changes: PartChange[] }
  /** No material offers it with this design's other parts. */
  | { kind: 'none' }

export function pickOutcome(listing: Listing, values: Readonly<Record<string, ParamValue>>, name: string, colour: string): PickOutcome {
  const all = materials(listing)
  const picks = colourPicks(listing, values)
  if (materialFor(listing, all, { ...picks, [name]: colour }) !== null) return { kind: 'fits' }
  const others = Object.fromEntries(Object.entries(picks).filter(([part]) => part !== name))
  // The first material that offers the new colour and a choice of every other part.
  const material = materialFor(listing, all, { [name]: colour })
  if (material === null) return { kind: 'none' }
  const changes: PartChange[] = []
  for (const [part, from] of Object.entries(others)) {
    const param = listing.params[part]
    if (!param || !isColourParam(param) || offers(all, material, from)) continue
    const to = closestIn(listing, all, material, param, from)
    if (to === null) return { kind: 'none' }
    changes.push({ name: part, from, to })
  }
  return { kind: 'swap', changes }
}

/** Why a greyed colour of part `name` is greyed, in the customer's words; null when it fits. */
export function greyedReason(listing: Listing, outcome: PickOutcome): string | null {
  if (outcome.kind === 'fits') return null
  if (outcome.kind === 'none') return "This colour can't be used with this design right now."
  const parts = outcome.changes.map((change) => `the ${partName(listing.params[change.name]?.label ?? change.name)}`)
  return `Choosing it changes ${joinAnd(parts)} too.`
}

/** "a", "a and b", "a, b and c". */
export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** The swap offer's question (the issue's copy, #6258). */
export function swapText(listing: Listing, colour: string, changes: readonly PartChange[]): string {
  const x = colourName(listing, colour)
  const label = (part: string) => partName(listing.params[part]?.label ?? part)
  const clash = changes.map((change) => `${colourName(listing, change.from)} for the ${label(change.name)}`)
  const moves = changes.map((change) => `the ${label(change.name)} to ${colourName(listing, change.to)}`)
  // One change reads "change the rim colour to Teal"; two "change the rim colour to Teal
  // and the body colour to Rust".
  return `${x} doesn't go with ${clash.join(' or ')}. Use ${x} and change ${joinAnd(moves)}?`
}

/**
 * #6258: what a visitor reads when the shop refuses colours that share no material (422
 * `listing_colours_clash`): the parts it names, by their labels, never a raw error.
 */
export function clashText(listing: Listing | undefined, parts: readonly string[]): string {
  const named = parts.flatMap((part) => {
    const param = listing?.params[part]
    return param ? [`the ${partName(param.label)}`] : []
  })
  const list = joinAnd(named)
  const capital = list.charAt(0).toUpperCase() + list.slice(1)
  const start =
    named.length > 1 ? `${capital} can't go together.` : named.length === 1 ? `${capital} can't go with the other colours.` : "Some colours can't go together."
  return `${start} Each print is made from one kind of plastic, and a few colours only come in one kind. Change one of them.`
}
