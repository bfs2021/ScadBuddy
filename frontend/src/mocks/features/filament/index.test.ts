import { describe, expect, it } from 'vitest'
import { archiveSpool, getInventory, getSpool, getSummary, getTag, listEvents, listLocations, listSpools, listTags, patchSpool } from '../../../api/filament'
import { resetMockState } from '../../handlers'
import { spoolId, TAG } from './seed'

// #6262 Task 14 — the Filament section's mock API over its seed, through the client.

describe('the filament mocks', () => {
  it('seeds 12 spools: opaque, translucent, clear, one needing a type, one Unknown, one archived', async () => {
    const all = await listSpools({ includeArchived: true })
    expect(all).toHaveLength(12)
    const live = await listSpools()
    expect(live.map((spool) => spool.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    const rgba = (number: number) => all.find((spool) => spool.number === number)?.effective?.rgba
    expect(rgba(1)).toBe('#FFFFFFFF')
    expect(rgba(2)).toBe('#FF6A1380')
    expect(rgba(5)).toBe('#FFFFFF10')
    expect((await listSpools({ needsType: true })).map((spool) => spool.number)).toEqual([6, 7])
    expect(all.find((spool) => spool.number === 7)?.names?.material).toBe('Unknown')
    expect(all.find((spool) => spool.number === 4)?.low_stock).toBe(true)
  })

  it("keeps the archived spool's last tag, now on spool #3", async () => {
    const archived = await getSpool(spoolId(19))
    expect(archived.archived_at).not.toBeNull()
    expect(archived.tag).toBeNull()
    expect(archived.last_tag).toMatchObject({ tag: { id: TAG.MOVED }, held_by: 3 })
    expect((await getSpool(spoolId(3))).tag?.id).toBe(TAG.MOVED)
    const history = (await getTag(TAG.MOVED)).history
    expect(history.map((binding) => binding.spool_id)).toEqual([spoolId(3), spoolId(19)])
    expect((await listTags()).map((tag) => tag.spool_number)).toEqual([3, 4])
    expect(await listTags({ includeUnbound: true })).toHaveLength(3)
  })

  it('serves the inventory, the summary, the places and the ledger from the same spools', async () => {
    const inventory = await getInventory()
    expect(inventory.spools.find((row) => row.spool.number === 8)?.loaded).toMatchObject({ ams_id: 0, tray_id: 3 })
    expect(inventory.spools.some((row) => row.spool.number === 19)).toBe(false)
    const summary = await getSummary()
    expect(summary).toMatchObject({ spools: 11, loaded: 2, needs_type: 2 })
    const [workshop] = await listLocations()
    expect(workshop?.children.map((place) => [place.name, place.spool_count])).toEqual([
      ['Shelf A', 2],
      ['Dry box 1', 2],
    ])
    const first = await listEvents({ limit: 5 })
    expect(first.events).toHaveLength(5)
    const next = await listEvents({ limit: 5, cursor: first.next_cursor })
    expect(next.events[0]!.at <= first.events[4]!.at).toBe(true)
  })

  it('changes a spool, and reset puts the seed back', async () => {
    await patchSpool(spoolId(1), { rgba: '#ff000080' } as Parameters<typeof patchSpool>[1])
    expect((await getSpool(spoolId(1))).effective?.rgba).toBe('#FF000080')
    await archiveSpool(spoolId(1))
    expect(await listSpools()).toHaveLength(10)
    resetMockState()
    expect((await getSpool(spoolId(1))).effective?.rgba).toBe('#FFFFFFFF')
    expect(await listSpools()).toHaveLength(11)
  })
})
