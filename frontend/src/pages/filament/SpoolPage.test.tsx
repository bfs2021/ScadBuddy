import { screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { getSpool, getType, listSpoolEvents, listSpools, patchSpool } from '../../api/filament'
import { L, spoolId, T, TAG } from '../../mocks/features/filament/seed'
import { server } from '../../mocks/server'
import { choose } from '../../test/select'
import { renderPage } from '../../test/utils'
import { SpoolPage } from './SpoolPage'

function render(route: string) {
  return renderPage(
    <Routes>
      <Route path="/filament/spools/:id" element={<SpoolPage />} />
      <Route path="/filament/spools" element={<p>The spools tab</p>} />
      <Route path="*" element={<p>Elsewhere</p>} />
    </Routes>,
    { route },
  )
}

const open = (number: number) => render(`/filament/spools/${spoolId(number)}`)
const heading = (number: number) => screen.findByRole('heading', { level: 1, name: new RegExp(`Spool #${number}\\b`) })

/** The bodies of every request to `path` with `method`, read as they leave. */
function recorded(method: string, match: RegExp) {
  const bodies: unknown[] = []
  server.events.on('request:start', ({ request }) => {
    if (request.method === method && match.test(new URL(request.url).pathname)) void request.clone().json().then((body) => bodies.push(body), () => {})
  })
  return bodies
}

describe('the spool page', () => {
  it('has the six sections, each a landmark with a heading, and an index', async () => {
    open(1)
    await heading(1)
    for (const name of ['Identity', 'Weight', 'Colour and cost', 'Printers', 'Storage', 'History']) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument()
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument()
      expect(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', { name })).toHaveAttribute('href', `#${name.toLowerCase().replace(/ /g, '-')}`)
    }
    expect(screen.getByRole('combobox', { name: 'Go to section' })).toBeInTheDocument()
  })

  it('resets an overridden colour with one PATCH of null, and the mark goes after the answer', async () => {
    await patchSpool(spoolId(3), { rgba: '#112233FF' })
    const edited = (await listSpoolEvents(spoolId(3))).filter((event) => event.kind === 'edited').length
    const patches = recorded('PATCH', /\/spools\//)
    const { user } = open(3)
    await heading(3)
    const field = () => document.querySelector('[data-field="rgba"]') as HTMLElement
    expect(within(field()).getByText('Set on this spool')).toBeInTheDocument()
    await user.click(within(field()).getByRole('button', { name: 'Reset Colour to type' }))
    await waitFor(() => expect(within(field()).queryByText('Set on this spool')).toBeNull())
    expect(patches).toEqual([{ rgba: null }])
    expect((await getSpool(spoolId(3))).overridden).not.toContain('rgba')
    expect((await getSpool(spoolId(3))).effective.rgba).toBe('#F5547CFF')
    expect((await listSpoolEvents(spoolId(3))).filter((event) => event.kind === 'edited')).toHaveLength(edited + 1)
  })

  it('restores an archived spool and nothing else, then offers the last tag, held by spool #3', async () => {
    const { user } = open(19)
    await heading(19)
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    const move = await screen.findByRole('button', { name: 'Tag is on spool #3 — Move it here' })
    expect((await getSpool(spoolId(19))).archived_at).toBeNull()
    expect((await getSpool(spoolId(19))).tag).toBeNull()
    expect((await getSpool(spoolId(3))).tag?.id).toBe(TAG.MOVED)
    await user.click(move)
    await waitFor(async () => expect((await getSpool(spoolId(19))).tag?.id).toBe(TAG.MOVED))
    expect((await getSpool(spoolId(3))).tag).toBeNull()
    expect(await screen.findByRole('button', { name: 'Take off' })).toBeInTheDocument()
  })

  it('asks for a material when it is Unknown, with the material list open', async () => {
    open(7)
    // The open list hides the page from assistive tech, so the page is found by its text.
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
    expect(screen.getByText('Choose a material')).toBeInTheDocument()
    expect(screen.getByText('Spool #7')).toBeInTheDocument()
  })

  it('offers no Delete for a spool that printed, only Archive and why', async () => {
    open(4)
    await heading(4)
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument()
    expect(screen.getByText('It has prints, so job costs keep their source.')).toBeInTheDocument()
  })

  it('deletes a spool that never printed, after asking', async () => {
    const { user } = open(11)
    await heading(11)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete spool' }))
    expect(await screen.findByText('The spools tab')).toBeInTheDocument()
    expect((await listSpools({ includeArchived: true })).some((spool) => spool.number === 11)).toBe(false)
  })

  it('shows the type preset and K value as From type, and overrides a preset with one PUT', async () => {
    const { user } = open(1)
    await heading(1)
    const presets = screen.getByRole('table', { name: 'Slicer presets' })
    const row = within(presets).getByRole('row', { name: /H2C 0\.4 from type/i })
    expect(within(row).getByText('From type')).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: 'K values' })).getByText('From type')).toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: 'Override' }))
    const own = within(presets).getByLabelText('Slicer filament')
    await user.clear(own)
    await user.type(own, 'GFA01')
    await user.click(screen.getByRole('button', { name: 'Save spool' }))
    await waitFor(async () => expect((await getSpool(spoolId(1))).presets[0]).toMatchObject({ slicer_filament: 'GFA01', overridden: true }))
  })

  it('saves only the changed fields in one PATCH, and the effective value stays the type’s for the rest', async () => {
    const patches = recorded('PATCH', /\/spools\//)
    const { user } = open(1)
    const cost = await screen.findByLabelText('Cost per kg')
    expect(cost).toHaveAttribute('placeholder', '15.91')
    await user.type(cost, '17.5')
    await user.click(screen.getByRole('button', { name: 'Save spool' }))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    expect(patches).toEqual([{ cost_per_kg: '17.5' }])
    expect((await getSpool(spoolId(1))).overridden).toEqual(['cost_per_kg'])
  })

  it('moves the spool through the move route when its location changes', async () => {
    const patches = recorded('PATCH', /\/spools\//)
    const { user } = open(1)
    await heading(1)
    await choose(user, screen.getByRole('combobox', { name: 'Location' }), /Dry box 1/)
    await user.click(screen.getByRole('button', { name: 'Save spool' }))
    await waitFor(async () => expect((await getSpool(spoolId(1))).location_id).toBe(L.DRY_BOX))
    expect(patches).toEqual([])
  })

  it('records a weighing from the scale reading, less the empty spool', async () => {
    const { user } = open(1)
    await heading(1)
    expect(screen.getByText(/Empty spool/)).toHaveTextContent('250 g')
    await user.type(screen.getByLabelText('Scale reading, with the spool (g)'), '900')
    await user.click(screen.getByRole('button', { name: 'Record weighing' }))
    await waitFor(async () => expect((await getSpool(spoolId(1))).grams_left).toBe(650))
  })

  it('shows what the grams left are made of', async () => {
    open(4)
    await heading(4)
    const basis = screen.getByRole('list', { name: 'How the grams left add up' })
    expect(within(basis).getAllByRole('listitem').length).toBeGreaterThan(0)
    expect(basis).toHaveTextContent('148')
  })

  it('takes the first type of a spool that needs one, and shows the migrated presets as From type', async () => {
    const { user } = open(6)
    await heading(6)
    expect(within(screen.getByRole('table', { name: 'Slicer presets' })).getByLabelText('Slicer filament')).toHaveValue('GFA00')
    await choose(user, screen.getByRole('combobox', { name: 'Type' }), /BL-PLA-BASIC-JADE-WHITE/)
    await user.click(screen.getByRole('button', { name: 'Save spool' }))
    const presets = screen.getByRole('table', { name: 'Slicer presets' })
    expect(await within(presets).findByRole('row', { name: /H2C 0\.4 from type/i })).toBeInTheDocument()
    expect(within(presets).queryByLabelText('Slicer filament')).toBeNull()
    expect((await getSpool(spoolId(6))).type_id).toBe(T.JADE)
  })

  it('makes a type from a spool that needs one, and attaches it', async () => {
    const { user } = open(6)
    await heading(6)
    await user.click(screen.getByRole('button', { name: 'Create type from this spool' }))
    await waitFor(async () => expect((await getSpool(spoolId(6))).type_id).not.toBeNull())
    const spool = await getSpool(spoolId(6))
    const type = await getType(spool.type_id!)
    expect(type).toMatchObject({ colour_name: 'Teal', rgba: '#1B9AAAFF' })
    expect(type.presets).toHaveLength(1)
    expect(spool.overridden).toEqual([])
  })

  it('makes a new spool with one POST and opens it', async () => {
    const posts = recorded('POST', /\/filament\/spools$/)
    const { user } = render('/filament/spools/new')
    await choose(user, await screen.findByRole('combobox', { name: 'Type' }), /BL-PLA-BASIC-HOT-PINK/)
    await user.type(screen.getByLabelText('Grams left'), '900')
    await user.click(screen.getByRole('button', { name: 'Save spool' }))
    await waitFor(async () => expect((await listSpools()).length).toBe(12))
    expect(posts).toHaveLength(1)
    expect(await heading(20)).toBeInTheDocument()
  })

  it('shows a server refusal and keeps the edits', async () => {
    const { user } = open(1)
    const temp = await screen.findByLabelText('Nozzle temperature, min (°C)')
    await user.type(temp, '300')
    await user.type(screen.getByLabelText('Nozzle temperature, max (°C)'), '200')
    await user.click(screen.getByRole('button', { name: 'Save spool' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(temp).toHaveValue('300')
  })
})
