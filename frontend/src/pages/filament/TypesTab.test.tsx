import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { listTypes } from '../../api/filament'
import { T } from '../../mocks/features/filament/seed'
import { FILAMENT_PETG } from '../../mocks/features/orders/state'
import { renderPage } from '../../test/utils'
import { TypesTab } from './TypesTab'

const types = () => screen.findByRole('table', { name: 'Types' })
const typeRows = (table: HTMLElement) => within(table).getAllByRole('row').filter((row) => row.dataset.type)

describe('the Types tab', () => {
  it('lists each type with its code, colour and price', async () => {
    renderPage(<TypesTab />)
    const rows = typeRows(await types())
    const jade = rows.find((row) => row.dataset.type === T.JADE)!
    expect(within(jade).getByRole('link', { name: 'BL-PLA-BASIC-JADE-WHITE' })).toHaveAttribute('href', `/filament/types/${T.JADE}`)
    expect(jade.querySelector('[data-colour]')).toHaveAttribute('data-colour', '#FFFFFFFF')
    expect(within(jade).getByText('15.91')).toBeInTheDocument()
    const orange = rows.find((row) => row.dataset.type === T.ORANGE)!
    expect(orange.querySelector('[data-colour]')).toHaveAttribute('data-colour', '#FF6A1380')
  })

  it('shows a type with no price as unpriced', async () => {
    renderPage(<TypesTab />)
    const mistletoe = typeRows(await types()).find((row) => row.dataset.type === T.MISTLETOE)!
    expect(within(mistletoe).getByText('No price')).toBeInTheDocument()
  })

  it('has a New type link', async () => {
    renderPage(<TypesTab />)
    await types()
    expect(screen.getByRole('link', { name: 'New type' })).toHaveAttribute('href', '/filament/types/new')
  })

  describe('the price book panel', () => {
    it('lists the book rows; a row with no type has Make a type', async () => {
      renderPage(<TypesTab />)
      const book = await screen.findByRole('region', { name: 'Price book' })
      const black = await within(book).findByTestId(`filament-${FILAMENT_PETG}`)
      expect(within(black).getByRole('button', { name: /Make a type/ })).toBeInTheDocument()
    })

    it('Make a type posts the row material, colour and alpha, and then links to the type', async () => {
      const { user } = renderPage(<TypesTab />)
      const book = await screen.findByRole('region', { name: 'Price book' })
      const black = await within(book).findByTestId(`filament-${FILAMENT_PETG}`)
      await user.click(within(black).getByRole('button', { name: /Make a type/ }))
      await waitFor(async () => expect((await listTypes()).some((type) => type.rgba === '#1E1E1EFF')).toBe(true))
      const made = (await listTypes()).find((type) => type.rgba === '#1E1E1EFF')!
      expect(made).toMatchObject({ cost_per_kg: '30', colour_name: 'Black' })
      expect(made.filament_id).toBe(FILAMENT_PETG)
      const link = await within(await screen.findByTestId(`filament-${FILAMENT_PETG}`)).findByRole('link', { name: made.code })
      expect(link).toHaveAttribute('href', `/filament/types/${made.id}`)
      expect(await types()).toHaveTextContent(made.code)
    })
  })
})
