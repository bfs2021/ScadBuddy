import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderPage } from '../../test/utils'
import { SpoolsTab } from './SpoolsTab'

function render(route = '/filament/spools') {
  return renderPage(<SpoolsTab />, { route })
}

const table = () => screen.findByRole('table', { name: 'Spools' })
const spoolRows = (body: HTMLElement) => within(body).getAllByRole('row').filter((row) => row.dataset.spool)

describe('the Spools tab', () => {
  it('shows the 11 active seed spools, the translucent one over a checker as #…80', async () => {
    render()
    const rows = spoolRows(await table())
    expect(rows.map((row) => row.dataset.spool)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'])
    const translucent = rows[1]!.querySelector('[data-colour]')
    expect(translucent).toHaveAttribute('data-colour', '#FF6A1380')
    expect(within(rows[0]!).getByRole('link', { name: '#1' })).toHaveAttribute('href', '/filament/spools/62620000-0000-4000-8000-000000000001')
  })

  it('marks a spool that needs a type, and one whose material is Unknown, with Set type', async () => {
    render()
    const rows = spoolRows(await table())
    const badge = (number: string) => rows.find((one) => one.dataset.spool === number)!
    for (const number of ['6', '7']) {
      expect(within(badge(number)).getByRole('link', { name: `Set type for spool #${number}` })).toBeInTheDocument()
      expect(within(badge(number)).getByText('Needs type')).toBeInTheDocument()
    }
    expect(within(rows[0]!).queryByRole('link', { name: /Set type/ })).toBeNull()
  })

  it('filters to low stock from its tile', async () => {
    const { user } = render()
    await table()
    await user.click(await screen.findByRole('button', { name: /Low stock/ }))
    await waitFor(async () => expect(spoolRows(await table()).map((row) => row.dataset.spool)).toEqual(['4']))
  })

  it('bulk Delete skips an in-use spool and names it', async () => {
    const { user } = render()
    const rows = spoolRows(await table())
    await user.click(within(rows[3]!).getByRole('checkbox', { name: 'Select spool #4' }))
    await user.click(within(rows[8]!).getByRole('checkbox', { name: 'Select spool #9' }))
    const bar = screen.getByRole('toolbar', { name: 'Selected spools' })
    await user.click(within(bar).getByRole('button', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText(/Skipped #4: it has printed; archive it instead\./)).toBeInTheDocument()
    await waitFor(async () => expect(spoolRows(await table()).map((row) => row.dataset.spool)).not.toContain('9'))
    expect(spoolRows(await table()).map((row) => row.dataset.spool)).toContain('4')
  })

  it('keeps Needs type to spools with no type: the two seed spools, 6 and 7', async () => {
    render('/filament/spools?needs_type=true')
    await waitFor(async () => expect(spoolRows(await table()).map((row) => row.dataset.spool)).toEqual(['6', '7']))
  })

  it('filters by material, and by use, from the Filter menu; the URL keeps the state', async () => {
    const { user } = render()
    await table()
    await user.click(screen.getByRole('button', { name: /Filter/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'Material' }))
    const petg = await screen.findByRole('menuitemradio', { name: 'PETG' })
    // A sub-menu's item takes the keyboard here: jsdom's pointer grace area closes it on a click.
    petg.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('button', { name: 'Clear filter Material: PETG' })).toBeInTheDocument()
    const rows = spoolRows(await table())
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(11)
    await user.click(screen.getByRole('button', { name: 'Clear filter Material: PETG' }))
    await user.click(screen.getByRole('button', { name: /Filter/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: /^Used/ }))
    expect(await screen.findByRole('button', { name: 'Clear filter Used' })).toBeInTheDocument()
  })
})
