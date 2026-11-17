import { screen, waitFor, within } from '@testing-library/react'
import { Link, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { getType, listTypes } from '../../api/filament'
import { T } from '../../mocks/features/filament/seed'
import { choose } from '../../test/select'
import { renderPage } from '../../test/utils'
import { TypePage } from './TypePage'

function render(route: string) {
  return renderPage(
    <Routes>
      <Route path="/filament/types/:id" element={<TypePage />} />
      <Route path="*" element={<p>Elsewhere</p>} />
    </Routes>,
    { route },
  )
}

const code = () => screen.findByLabelText('Code')

describe('the type page', () => {
  it('shows the type: its fields, presets, K values and spools', async () => {
    render(`/filament/types/${T.JADE}`)
    expect(await code()).toHaveValue('BL-PLA-BASIC-JADE-WHITE')
    expect(screen.getByLabelText('Cost per kg')).toHaveValue('15.91')
    expect(screen.getByLabelText('Colour name')).toHaveValue('Jade White')
    expect(screen.getByRole('combobox', { name: 'Material' })).toHaveTextContent('PLA')
    expect(within(screen.getByRole('table', { name: 'Slicer presets' })).getByDisplayValue('GFA00')).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: 'K values' })).getByDisplayValue('0.020')).toBeInTheDocument()
    const spools = screen.getByRole('table', { name: 'Spools of this type' })
    expect(await within(spools).findByRole('link', { name: '#1' })).toBeInTheDocument()
  })

  it('saves a new 0.6 preset with one PUT of the presets, and the old row stays', async () => {
    const { user } = render(`/filament/types/${T.JADE}`)
    await code()
    await user.click(screen.getByRole('button', { name: 'Add preset' }))
    const row = screen.getByRole('row', { name: 'New preset' })
    await user.type(within(row).getByLabelText('Printer model'), 'H2C')
    await user.clear(within(row).getByLabelText('Nozzle'))
    await user.type(within(row).getByLabelText('Nozzle'), '0.6')
    await user.type(within(row).getByLabelText('Slicer filament'), 'GFA00')
    await user.type(within(row).getByLabelText('Preset name'), 'Bambu PLA Basic @BBL H2C 0.6 nozzle')
    await user.click(screen.getByRole('button', { name: 'Save type' }))
    await waitFor(async () => expect((await getType(T.JADE)).presets).toHaveLength(2))
    const presets = (await getType(T.JADE)).presets
    expect(presets).toContainEqual(expect.objectContaining({ printer_model: 'H2C', nozzle_diameter: '0.6', slicer_filament: 'GFA00', slicer_filament_name: 'Bambu PLA Basic @BBL H2C 0.6 nozzle' }))
    expect(presets).toContainEqual(expect.objectContaining({ nozzle_diameter: '0.4' }))
  })

  it('does not save a preset whose nozzle is *', async () => {
    const { user } = render(`/filament/types/${T.JADE}`)
    await code()
    const nozzle = within(screen.getByRole('table', { name: 'Slicer presets' })).getByLabelText('Nozzle')
    await user.clear(nozzle)
    await user.type(nozzle, '*')
    await user.click(screen.getByRole('button', { name: 'Save type' }))
    expect(await screen.findAllByText(/is not a nozzle/)).not.toHaveLength(0)
    expect((await getType(T.JADE)).presets[0]!.nozzle_diameter).toBe('0.4')
  })

  it('saves a changed field with a PATCH and a changed K value with a PUT', async () => {
    const { user } = render(`/filament/types/${T.JADE}`)
    const cost = await screen.findByLabelText('Cost per kg')
    await user.clear(cost)
    await user.type(cost, '17.5')
    const k = within(screen.getByRole('table', { name: 'K values' })).getByLabelText('K value')
    await user.clear(k)
    await user.type(k, '0.025')
    await user.click(screen.getByRole('button', { name: 'Save type' }))
    await waitFor(async () => expect((await getType(T.JADE)).k_values[0]!.k_value).toBe('0.025'))
    expect((await getType(T.JADE)).cost_per_kg).toMatch(/^17\.5/)
    expect((await getType(T.JADE)).k_values[0]).toMatchObject({ cali_idx: 3, name: 'Jade White 0.4' })
  })

  it('shows the server refusal and keeps the edits', async () => {
    const { user } = render(`/filament/types/${T.JADE}`)
    await user.type(await screen.findByLabelText('Bed temperature, min (°C)'), '90')
    await user.type(screen.getByLabelText('Bed temperature, max (°C)'), '60')
    await user.click(screen.getByRole('button', { name: 'Save type' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('bed_temp_min is above bed_temp_max')
    expect(screen.getByLabelText('Bed temperature, max (°C)')).toHaveValue('60')
  })

  it('holds navigation while edits are unsaved', async () => {
    const { user } = renderPage(
      <>
        <Link to="/other">Away</Link>
        <Routes>
          <Route path="/filament/types/:id" element={<TypePage />} />
          <Route path="*" element={<p>Elsewhere</p>} />
        </Routes>
      </>,
      { route: `/filament/types/${T.JADE}` },
    )
    await user.type(await screen.findByLabelText('Colour name'), 'x')
    await user.click(screen.getByRole('link', { name: 'Away' }))
    expect(await screen.findByText('Leave without saving?')).toBeInTheDocument()
    expect(screen.queryByText('Elsewhere')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Leave without saving' }))
    expect(await screen.findByText('Elsewhere')).toBeInTheDocument()
  })

  it('adds a new type from the new page', async () => {
    const { user } = render('/filament/types/new')
    await user.type(await code(), 'TEST-PLA-RED')
    await choose(user, screen.getByRole('combobox', { name: 'Material' }), 'PLA')
    await user.click(screen.getByRole('button', { name: 'Translucent' }))
    await user.click(screen.getByRole('button', { name: 'Save type' }))
    await waitFor(async () => expect((await listTypes()).some((type) => type.code === 'TEST-PLA-RED')).toBe(true))
    const made = (await listTypes()).find((type) => type.code === 'TEST-PLA-RED')!
    expect(made.rgba).toMatch(/80$/)
    expect(made.label_weight_g).toBe(1000)
  })

  it('says a type is gone for a 404', async () => {
    render('/filament/types/62620000-0000-4000-8000-0000000000ff')
    expect(await screen.findByText(/That type is gone/)).toBeInTheDocument()
  })
})
