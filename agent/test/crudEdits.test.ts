import { describe, expect, it, vi } from 'vitest'
import { CrudEditRows } from '../src/sessions/edits.js'
import { SessionError } from '../src/sessions/manager.js'

// An edit of a session through the API's CRUD route (#6449), against a fake API that answers as
// the backend's api/crud_agent_edits.py does (tests/crud/test_crud_agent_edits.py covers the
// route; test/editRowsParity.pg.test.ts the port against the SQL). The workflow is told it is done
// before the route only when the row was read neither done nor running a turn, a failed telling
// writes nothing, and each refusal is the SessionError the SQL path throws.

const BASE = 'http://api:8080'
const PREFIX = '/api/v1/internal/crud/agent'
const SESSION = '0b0e7c55-6a3e-4a37-9d3c-4b1a1f0e2a10'
const BROWSER = { kind: 'browser' as const, id: 'browser' }

type Seen = { path: string; body: Record<string, unknown> }

function fakeApi(status: number, body: unknown) {
  const seen: Seen[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    seen.push({ path: new URL(request.url).pathname.slice(PREFIX.length), body: JSON.parse(await request.text()) as Record<string, unknown> })
    return new Response(JSON.stringify(body), { status, headers: { 'x-scadbuddy-crud': '1' } })
  }
  return { seen, rows: new CrudEditRows(BASE, { fetch }) }
}

const ok = { logged: [], dismissed: [] }

describe('an edit over the CRUD route', () => {
  it('tells the workflow first, then writes the done as told', async () => {
    const { seen, rows } = fakeApi(200, {
      logged: [{ session_id: SESSION, events: [{ v: 1, type: 'session.status', sessionId: SESSION, status: 'done' }], seqs: [3] }],
      dismissed: [],
    })
    const order: string[] = []
    const end = vi.fn(async () => {
      order.push('told')
    })
    const edited = await rows.edit(SESSION.toUpperCase(), { principal: BROWSER, done: true }, { status: 'idle' }, end)
    expect(end).toHaveBeenCalledWith(SESSION.toUpperCase())
    expect(seen).toEqual([{ path: `/sessions/${SESSION}/edit`, body: { principal: BROWSER, title: null, done: true, archived: null, told: true } }])
    expect(edited.logged).toEqual({ events: [{ v: 1, type: 'session.status', sessionId: SESSION, status: 'done' }], seqs: [3] })
  })

  it('tells no workflow of a session done already or running a turn', async () => {
    for (const status of ['done', 'running', 'waiting_input'] as const) {
      const { seen, rows } = fakeApi(200, ok)
      const end = vi.fn(async () => {})
      await rows.edit(SESSION, { principal: BROWSER, done: true }, { status }, end)
      expect(end).not.toHaveBeenCalled()
      expect(seen[0]?.body.told).toBe(false)
    }
  })

  it('writes nothing when the workflow cannot be told', async () => {
    const { seen, rows } = fakeApi(200, ok)
    const end = async () => {
      throw new SessionError('unavailable', 'no Temporal')
    }
    await expect(rows.edit(SESSION, { principal: BROWSER, done: true }, { status: 'idle' }, end)).rejects.toThrow(/no Temporal/)
    expect(seen).toEqual([])
  })

  it('hears each refusal as the SQL path throws it', async () => {
    const cases: [number, string, string, RegExp][] = [
      [404, 'gone', 'not_found', /no session/],
      [409, 'changed_owner', 'busy', /changed owner meanwhile/],
      [409, 'busy_done', 'busy', /Stop it first, then mark it done/],
      [409, 'busy_archive', 'busy', /Stop it first, then archive it/],
      [409, 'parked', 'busy', /waiting for you/],
      [409, 'untold', 'busy', /changed meanwhile/],
    ]
    for (const [status, reason, code, message] of cases) {
      const { rows } = fakeApi(status, { detail: 'refused', reason })
      const refused = await rows.edit(SESSION, { principal: BROWSER, title: 'x', done: false }, { status: 'idle' }, async () => {}).catch((e: unknown) => e)
      expect(refused, reason).toBeInstanceOf(SessionError)
      expect((refused as SessionError).code, reason).toBe(code)
      expect((refused as SessionError).message, reason).toMatch(message)
    }
    // Anything else is no refusal the edit knows: it throws as it came.
    const { rows } = fakeApi(503, { detail: 'down' })
    await expect(rows.edit(SESSION, { principal: BROWSER, title: 'x', done: false }, { status: 'idle' }, async () => {})).rejects.not.toBeInstanceOf(SessionError)
  })

  it('sends no call for an id that is no session', async () => {
    const { seen, rows } = fakeApi(200, ok)
    for (const bad of ['../x', `${SESSION}/../../stores`, '..', 'not-a-uuid']) {
      const refused = await rows.edit(bad, { principal: BROWSER, title: 'x', done: false }, { status: 'idle' }, async () => {}).catch((e: unknown) => e)
      expect((refused as SessionError).code).toBe('not_found')
    }
    expect(seen).toEqual([])
  })
})
