import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { TypeKValueInput } from '../../api/filament'
import { KValueTable } from './KValueTable'
import { kValueRowsError } from './kValueRows'

const PRINTERS = [{ id: 'p1', name: 'Garage H2C' }]
const ROW: TypeKValueInput = { printer_id: 'p1', extruder: 0, nozzle_diameter: '0.4', nozzle_type: null, k_value: '0.020', name: null, cali_idx: 3 }

function Harness({ start, spy }: { start: TypeKValueInput[]; spy?: (rows: TypeKValueInput[]) => void }) {
  const [rows, setRows] = useState(start)
  return (
    <KValueTable
      rows={rows}
      printers={PRINTERS}
      onChange={(next) => {
        setRows(next)
        spy?.(next)
      }}
    />
  )
}

describe('KValueTable', () => {
  it('adds a row for the first printer', async () => {
    const user = userEvent.setup()
    const spy = vi.fn()
    render(<Harness start={[]} spy={spy} />)
    await user.click(screen.getByRole('button', { name: 'Add K value' }))
    expect(spy).toHaveBeenLastCalledWith([{ printer_id: 'p1', extruder: 0, nozzle_diameter: '0.4', nozzle_type: null, k_value: '', name: null }])
  })

  it('removes a row and edits the K value, keeping the calibration index', async () => {
    const user = userEvent.setup()
    const spy = vi.fn()
    render(<Harness start={[ROW, { ...ROW, extruder: 1 }]} spy={spy} />)
    const first = screen.getByRole('row', { name: 'K value 1' })
    await user.type(within(first).getByLabelText('K value'), '5')
    expect(spy).toHaveBeenLastCalledWith([{ ...ROW, k_value: '0.0205' }, { ...ROW, extruder: 1 }])
    await user.click(screen.getByRole('button', { name: 'Remove K value 2' }))
    expect(spy).toHaveBeenLastCalledWith([{ ...ROW, k_value: '0.0205' }])
  })

  it('refuses a duplicate key and a non-number', () => {
    expect(kValueRowsError([ROW, ROW])).toMatch(/same printer/)
    expect(kValueRowsError([{ ...ROW, k_value: 'abc' }])).toMatch(/number/)
    expect(kValueRowsError([ROW])).toBeNull()
  })
})
