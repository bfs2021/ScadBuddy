import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { listCatalog, upsertCatalog } from '../../api/filament'
import { M } from '../../mocks/features/filament/seed'
import { renderPage } from '../../test/utils'
import { CatalogTab } from './CatalogTab'

const list = (name: string) => screen.findByRole('table', { name })
const rowOf = (table: HTMLElement, name: string) => {
  const found = within(table).getAllByRole('row').find((row) => row.dataset.name === name)
  if (!found) throw new Error(`no row ${name}`)
  return found
}

describe('the Catalog tab', () => {
  it('archives Wood: it leaves the default list and shows under Archived', async () => {
    await upsertCatalog('materials', { name: 'Wood' })
    const { user } = renderPage(<CatalogTab />)
    const materials = await list('Materials')
    await user.click(within(rowOf(materials, 'Wood')).getByRole('button', { name: 'Archive Wood' }))
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Materials' })).queryByText('Wood')).toBeNull())
    await user.click(screen.getByRole('checkbox', { name: 'Show archived' }))
    const shown = await list('Materials')
    await waitFor(() => expect(within(shown).getByText('Wood')).toBeInTheDocument())
    expect(within(rowOf(shown, 'Wood')).getByRole('button', { name: 'Restore Wood' })).toBeInTheDocument()
    expect((await listCatalog('materials')).some((row) => row.name === 'Wood')).toBe(false)
  })

  it('restores an archived row', async () => {
    const wood = await upsertCatalog('materials', { name: 'Wood' })
    await upsertCatalog('materials', { archived: true }, wood.id)
    const { user } = renderPage(<CatalogTab />, { route: '/filament/catalog?archived=true' })
    await user.click(within(rowOf(await list('Materials'), 'Wood')).getByRole('button', { name: 'Restore Wood' }))
    await waitFor(async () => expect((await listCatalog('materials')).some((row) => row.name === 'Wood')).toBe(true))
  })

  it('picks the catalog from the URL', async () => {
    renderPage(<CatalogTab />, { route: '/filament/catalog?kind=brands' })
    expect(within(await list('Brands')).getByText('Polymaker')).toBeInTheDocument()
  })

  it('adds a row and refuses a name that is taken, with the server text', async () => {
    const { user } = renderPage(<CatalogTab />, { route: '/filament/catalog?kind=brands' })
    await list('Brands')
    await user.type(screen.getByLabelText('New name'), 'Prusament')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Brands' })).getByText('Prusament')).toBeInTheDocument())
    await user.type(screen.getByLabelText('New name'), 'Prusament')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('a row of this catalog already has that name')
  })

  it('renames a row', async () => {
    const { user } = renderPage(<CatalogTab />, { route: '/filament/catalog?kind=brands' })
    await user.click(within(rowOf(await list('Brands'), 'Sunlu')).getByRole('button', { name: 'Edit Sunlu' }))
    const name = screen.getByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'SUNLU')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Brands' })).getByText('SUNLU')).toBeInTheDocument())
  })

  it('moves a row up, which renumbers sort_order', async () => {
    const { user } = renderPage(<CatalogTab />, { route: '/filament/catalog?kind=brands' })
    await user.click(within(rowOf(await list('Brands'), 'Inland')).getByRole('button', { name: 'Move Inland up' }))
    await waitFor(async () => {
      const brands = await listCatalog('brands')
      expect(brands.findIndex((row) => row.name === 'Inland')).toBeLessThan(brands.findIndex((row) => row.name === 'Insignia'))
    })
  })

  it('edits a material value columns', async () => {
    const { user } = renderPage(<CatalogTab />)
    await user.click(within(rowOf(await list('Materials'), 'PLA')).getByRole('button', { name: 'Edit PLA' }))
    const max = screen.getByLabelText('Nozzle max (°C)')
    await user.clear(max)
    await user.type(max, '235')
    await user.click(screen.getByRole('checkbox', { name: 'Abrasive' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(async () => {
      const pla = (await listCatalog('materials')).find((row) => row.id === M.PLA)!
      expect(pla).toMatchObject({ nozzle_temp_max: 235, abrasive: true })
    })
  })

  it('shows an insert type bb_catalog_id read only', async () => {
    const { user } = renderPage(<CatalogTab />, { route: '/filament/catalog?kind=insert-types' })
    await user.click(within(rowOf(await list('Insert types'), 'Cardboard spool')).getByRole('button', { name: 'Edit Cardboard spool' }))
    expect(screen.getByText('Bambuddy catalog id')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Bambuddy catalog id' })).toBeNull()
  })

  it('edits a colour with the colour field', async () => {
    const { user } = renderPage(<CatalogTab />, { route: '/filament/catalog?kind=colours' })
    const table = await list('Colours')
    expect(within(rowOf(table, 'Hot Pink')).getByTestId('rgba-swatch')).toHaveAttribute('data-colour', '#F5547CFF')
    await user.click(within(rowOf(table, 'Hot Pink')).getByRole('button', { name: 'Edit Hot Pink' }))
    const hex = screen.getByLabelText('Colour (hex)')
    await user.clear(hex)
    await user.type(hex, '#112233')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(async () => expect((await listCatalog('colours')).find((row) => row.name === 'Hot Pink')?.rgba).toBe('#112233FF'))
  })
})
