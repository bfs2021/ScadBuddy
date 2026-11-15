import { render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CHARM, KEYCHAIN, TAG } from '../../mocks/features/storefrontPublic'
import type { ParamValue } from '../api/client'
import { ListingView } from './ListingView'

describe('ListingView', () => {
  it('shows each offered parameter, with the shop’s choice until the visitor sets one', async () => {
    const onChange = vi.fn()
    render(<ListingView listing={KEYCHAIN} values={{}} onChange={onChange} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Name keychain' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('')
    await userEvent.type(screen.getByLabelText('Length (mm)'), '5')
    expect(onChange).toHaveBeenLastCalledWith('size', 5)
    // #6152: a colour is a picker of filaments; #6258: a pick is the colour in the values.
    await userEvent.click(screen.getByRole('button', { name: /Base colour/ }))
    await userEvent.click(screen.getByRole('radio', { name: 'Signal orange' }))
    expect(onChange).toHaveBeenLastCalledWith('base_colour', '#E8532F')
  })

  it('shows no Material control: one material is always on, and the shop resolves it (#6258)', () => {
    render(<ListingView listing={CHARM} values={{}} onChange={() => undefined} />)
    expect(screen.queryByRole('radiogroup', { name: 'Material' })).toBeNull()
    // The shop's colour shows on a row with no colour set, never "Choose a colour".
    expect(screen.getByRole('button', { name: /Body colour/ })).toHaveAccessibleName('Body colour Ocean blue')
  })

  it('offers a switch as Yes and No, never the words true and false (#6141)', async () => {
    const onChange = vi.fn()
    const listing = {
      ...KEYCHAIN,
      params: { ring: { kind: 'choice' as const, label: 'Keyring hole', group: '', colour: false, choices: [true, false] } },
    }
    render(<ListingView listing={listing} values={{}} onChange={onChange} />)
    expect(screen.queryByText('true')).toBeNull()
    expect(screen.queryByText('false')).toBeNull()
    await userEvent.click(screen.getByRole('radio', { name: 'No' }))
    expect(onChange).toHaveBeenLastCalledWith('ring', false)
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeInTheDocument()
  })

  it('shows the design’s default text as the placeholder, or none (#6137)', () => {
    const listing = {
      ...KEYCHAIN,
      params: {
        name: { kind: 'text' as const, label: 'Name', group: '', colour: false, max_length: 20, placeholder: 'Stella' },
        motto: { kind: 'text' as const, label: 'Motto', group: '', colour: false, max_length: 20, placeholder: null },
      },
    }
    render(<ListingView listing={listing} values={{}} onChange={() => undefined} />)
    expect(screen.getByLabelText('Name')).toHaveAttribute('placeholder', 'Stella')
    expect(screen.getByLabelText('Motto')).not.toHaveAttribute('placeholder')
    expect(screen.queryByPlaceholderText("The shop's text")).toBeNull()
  })

  it('says a design with no colour left cannot be ordered', () => {
    render(<ListingView listing={TAG} values={{}} onChange={() => undefined} headingLevel={2} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Luggage tag' })).toBeInTheDocument()
    expect(screen.getByText('This design cannot be ordered right now.')).toBeInTheDocument()
    expect(screen.getByText('No colour is available for this right now.')).toBeInTheDocument()
  })

  it('renders the shop’s text as text', () => {
    const hostile = { ...KEYCHAIN, title: '<b>x</b>', description: '<img src=x onerror=alert(1)>' }
    render(<ListingView listing={hostile} values={{}} onChange={() => undefined} />)
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img[src="x"], b')).toBeNull()
  })

  it('shows the shop’s default as picked until the visitor picks (#6144)', async () => {
    render(<ListingView listing={KEYCHAIN} values={{}} onChange={vi.fn()} />)
    // #6152: the colour row names the shop's colour; its grid shows it picked.
    expect(screen.getByRole('button', { name: /Base colour/ })).toHaveAccessibleName('Base colour Ocean blue')
    await userEvent.click(screen.getByRole('button', { name: /Base colour/ }))
    expect(screen.getByRole('radio', { name: 'Ocean blue' })).toHaveAttribute('data-state', 'on')
    expect(screen.getByRole('radio', { name: 'Signal orange' })).toHaveAttribute('data-state', 'off')
    expect(screen.getByLabelText('Length (mm)')).toHaveAttribute('placeholder', '60')
  })

  it('sends no change when the visitor taps the shop’s default, so it never says “Tap it again” (#6144)', async () => {
    const onChange = vi.fn()
    function Stateful() {
      const [values, setValues] = useState<Record<string, ParamValue>>({})
      return (
        <ListingView
          listing={KEYCHAIN}
          values={values}
          onChange={(name, value) => {
            onChange(name, value)
            setValues(({ [name]: _old, ...rest }) => (value === undefined ? rest : { ...rest, [name]: value }))
          }}
        />
      )
    }
    render(<Stateful />)
    const row = () => screen.getByRole('button', { name: /Base colour/ })
    const hint = () => document.getElementById(row().closest('[aria-describedby]')!.getAttribute('aria-describedby')!)
    expect(hint()).toHaveTextContent('Our pick, change it if you like.')
    await userEvent.click(row())
    await userEvent.click(screen.getByRole('radio', { name: 'Ocean blue' }))
    expect(onChange.mock.calls.every(([, value]) => value === undefined)).toBe(true)
    expect(row()).toHaveAccessibleName('Base colour Ocean blue')
    await userEvent.click(row())
    expect(screen.getByRole('radio', { name: 'Ocean blue' })).toHaveAttribute('data-state', 'on')
    expect(hint()).toHaveTextContent('Our pick, change it if you like.')
    expect(screen.queryByText(/Tap it again/)).toBeNull()
  })
})

describe('ListingView colours (#6258)', () => {
  function Charm({ start = {}, onValues }: { start?: Record<string, ParamValue>; onValues?: (values: Record<string, ParamValue>) => void }) {
    const [values, setValues] = useState<Record<string, ParamValue>>(start)
    onValues?.(values)
    return (
      <ListingView
        listing={CHARM}
        values={values}
        onChange={(name, value) => setValues(({ [name]: _old, ...rest }) => (value === undefined ? rest : { ...rest, [name]: value }))}
      />
    )
  }
  const row = (label: RegExp) => screen.getByRole('button', { name: label })
  const hintOf = (label: RegExp) => document.getElementById(row(label).closest('[aria-describedby]')!.getAttribute('aria-describedby')!)

  it('renders no material text anywhere', async () => {
    render(<Charm />)
    await userEvent.click(row(/Body colour/))
    expect(document.body).not.toHaveTextContent(/PLA|PETG/)
    // Black comes in both materials: one swatch.
    expect(screen.getAllByRole('radio', { name: 'Black' })).toHaveLength(1)
  })

  it('greys the colours that do not go with a pick, and explains', async () => {
    render(<Charm start={{ body_colour: '#E8532F' }} />)
    await userEvent.click(row(/Rim colour/))
    expect(screen.getByText(/Some colours can't go together\. Each print is made from one kind of plastic/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Teal' })).toHaveAccessibleDescription('Choosing it changes the body colour too.')
    expect(screen.getByRole('radio', { name: 'Black' })).not.toHaveAttribute('data-greyed')
  })

  it('offers a swap for a greyed colour; "Use Teal" moves the other picked part to its closest colour', async () => {
    let latest: Record<string, ParamValue> = {}
    render(<Charm start={{ body_colour: '#E8532F' }} onValues={(values) => (latest = values)} />)
    await userEvent.click(row(/Rim colour/))
    await userEvent.click(screen.getByRole('radio', { name: 'Teal' }))
    const offer = await screen.findByRole('alertdialog')
    expect(offer).toHaveTextContent("Teal doesn't go with Signal orange for the body colour. Use Teal and change the body colour to Rust?")
    expect(latest).toEqual({ body_colour: '#E8532F' })
    await userEvent.click(screen.getByRole('button', { name: 'Use Teal' }))
    expect(latest).toEqual({ body_colour: '#C0502A', rim_colour: '#1C8C8C' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('"Keep my colours" changes nothing, and Escape does the same', async () => {
    let latest: Record<string, ParamValue> = {}
    render(<Charm start={{ body_colour: '#E8532F' }} onValues={(values) => (latest = values)} />)
    await userEvent.click(row(/Rim colour/))
    await userEvent.click(screen.getByRole('radio', { name: 'Teal' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Keep my colours' }))
    expect(latest).toEqual({ body_colour: '#E8532F' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await userEvent.click(row(/Rim colour/))
    await userEvent.click(screen.getByRole('radio', { name: 'Rust' }))
    const offer = await screen.findByRole('alertdialog')
    // Focus moves into the offer, so the keyboard reaches it.
    await waitFor(() => expect(offer).toContainElement(document.activeElement as HTMLElement))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(latest).toEqual({ body_colour: '#E8532F' })
  })

  it('shows an unpicked part as "our pick", moves it while its default does not fit, and puts it back', async () => {
    render(<Charm />)
    expect(row(/Rim colour/)).toHaveAccessibleName('Rim colour Ocean blue')
    expect(hintOf(/Rim colour/)).toHaveTextContent('Our pick, change it if you like.')
    await userEvent.click(row(/Body colour/))
    await userEvent.click(screen.getByRole('radio', { name: 'Rust' }))
    // Rust comes only in the other material, which has no Ocean blue: the rim follows.
    expect(row(/Rim colour/)).toHaveAccessibleName('Rim colour Teal')
    expect(hintOf(/Rim colour/)).toHaveTextContent('Our pick, change it if you like.')
    await userEvent.click(row(/Body colour/))
    await userEvent.click(screen.getByRole('radio', { name: 'Signal orange' }))
    expect(row(/Rim colour/)).toHaveAccessibleName('Rim colour Ocean blue')
  })
})
