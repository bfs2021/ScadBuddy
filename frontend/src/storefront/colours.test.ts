import { describe, expect, it } from 'vitest'
import { CHARM } from '../mocks/features/storefrontPublic'
import { clashText, colourPlan, colourSwatches, filamentHex, greyedReason, pickOutcome, sentValues, swapText } from './colours'

const BLUE = '#1B6CA8'
const ORANGE = '#E8532F'
const TEAL = '#1C8C8C'
const RUST = '#C0502A'
const BLACK = '#101010'

describe('colour swatches (#6258)', () => {
  it('makes one swatch per colour across materials, named by the colour', () => {
    const swatches = colourSwatches(CHARM.params.body_colour!, CHARM.colours)
    expect(swatches.map((swatch) => swatch.name)).toEqual(['Ocean blue', 'Signal orange', 'Teal', 'Rust', 'Black'])
  })

  it('never names a material, even inside a finish', () => {
    const filaments = [
      { id: 'a', colour: '#000000', colour_name: 'Black', material: 'PLA', subtype: 'PLA Matte' },
      { id: 'b', colour: '#111111', colour_name: 'Black', material: 'PETG', subtype: 'PETG HF' },
    ]
    const param = { kind: 'choice' as const, label: 'Body', group: '', colour: true, choices: ['#000000', '#111111'] }
    expect(colourSwatches(param, filaments).map((swatch) => swatch.name)).toEqual(['Black (Matte)', 'Black (HF)'])
  })
})

describe('colour plan (#6258)', () => {
  it('shows the defaults while they fit, and sends nothing for them', () => {
    const plan = colourPlan(CHARM, {})
    expect(plan.material).toBe('pla')
    expect(plan.shown).toEqual({ body_colour: BLUE, rim_colour: BLUE })
    expect(sentValues(CHARM, {})).toEqual({})
  })

  it('moves an unpicked part to the closest colour while its default does not fit, and sends it', () => {
    const plan = colourPlan(CHARM, { body_colour: RUST })
    expect(plan.material).toBe('petg')
    expect(plan.shown.rim_colour).toBe(TEAL)
    expect(sentValues(CHARM, { body_colour: RUST })).toEqual({ body_colour: RUST, rim_colour: TEAL })
  })

  it('puts the default back once it fits again', () => {
    expect(colourPlan(CHARM, { body_colour: ORANGE }).shown.rim_colour).toBe(BLUE)
    expect(sentValues(CHARM, { body_colour: BLACK })).toEqual({ body_colour: BLACK })
  })

  it('picks a colour that goes with the others at once', () => {
    expect(pickOutcome(CHARM, { body_colour: ORANGE }, 'rim_colour', BLACK)).toEqual({ kind: 'fits' })
    // Unpicked parts never grey a colour: they follow.
    expect(pickOutcome(CHARM, {}, 'rim_colour', TEAL)).toEqual({ kind: 'fits' })
  })

  it('offers to move the other picked parts to their closest colour in the new material', () => {
    const outcome = pickOutcome(CHARM, { body_colour: ORANGE }, 'rim_colour', TEAL)
    expect(outcome).toEqual({ kind: 'swap', changes: [{ name: 'body_colour', from: ORANGE, to: RUST }] })
    expect(greyedReason(CHARM, outcome)).toBe('Choosing it changes the body colour too.')
    if (outcome.kind !== 'swap') throw new Error('no swap')
    expect(swapText(CHARM, TEAL, outcome.changes)).toBe(
      "Teal doesn't go with Signal orange for the body colour. Use Teal and change the body colour to Rust?",
    )
  })

  it('reads a filament’s alpha field when the shop sends one, else the hex (#6211)', () => {
    expect(filamentHex({ id: 'a', colour: '#FFFFFF', colour_name: 'Clear', material: 'PETG' })).toBe('#FFFFFF')
    expect(filamentHex({ id: 'a', colour: '#FFFFFF', colour_name: 'Clear', material: 'PETG', alpha: 64 } as never)).toBe('#FFFFFF40')
  })

  it('names the clashing parts by their labels', () => {
    expect(clashText(CHARM, ['body_colour', 'rim_colour'])).toBe(
      "The body colour and the rim colour can't go together. Each print is made from one kind of plastic, and a few colours only come in one kind. Change one of them.",
    )
    expect(clashText(CHARM, ['colours.0'])).toMatch(/^Some colours can't go together\./)
  })
})
