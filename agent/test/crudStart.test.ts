import { describe, expect, it } from 'vitest'
import { CrudAreas } from '../src/api/crudAreas.js'
import { BrowserSessions, CrudSessionLookup, sessionIdHash } from '../src/auth/browserSession.js'
import { awaitMigrations, crudLedger, EXPECTED_MIGRATIONS, MigrationChecksumError, MigrationsPendingError } from '../src/db/schema.js'

// What the agent read at its start and per request over its own SQL, through the API's CRUD
// routes (#6501), against a fake API that answers as the backend's api/crud_agent_start.py does
// (the backend's tests/crud/test_crud_agent_start.py covers the routes): the ledger of its
// migrations, a signed-in person's session by its cookie's hash, and health's probe.

const BASE = 'http://api:8080'
const PREFIX = '/api/v1/internal/crud/agent'

type Seen = { method: string; path: string; body: unknown }

class FakeApi {
  seen: Seen[] = []
  answers = new Map<string, { status: number; body: unknown }>()

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const path = `${url.pathname.slice(PREFIX.length)}${url.search}`
    const text = request.method === 'POST' ? await request.text() : ''
    this.seen.push({ method: request.method, path, body: text ? JSON.parse(text) : undefined })
    const key = `${request.method} ${path}`
    const answer = this.answers.get(key) ?? { status: 404, body: { detail: `no answer for ${key}` } }
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'x-scadbuddy-crud': '1' } })
  }

  answer(key: string, body: unknown, status = 200): this {
    this.answers.set(key, { status, body })
    return this
  }
}

const target = (api: FakeApi) => ({ baseUrl: BASE, fetch: api.fetch })

describe("the agent's migrations through the API", () => {
  const all = EXPECTED_MIGRATIONS.map((m) => ({ id: m.id, checksum: m.sha256 }))

  it('asks for the expected ids and is done once each is in the ledger', async () => {
    const api = new FakeApi().answer('POST /migrations/ledger', { found: true, keyed: true, rows: all })
    await awaitMigrations(crudLedger(target(api)), EXPECTED_MIGRATIONS, { attempts: 1, log: () => undefined })
    expect(api.seen[0]?.body).toEqual({ ids: EXPECTED_MIGRATIONS.map((m) => m.id) })
  })

  it('waits while the API has not made the ledger or a file is missing', async () => {
    for (const ledger of [
      { found: false, keyed: false, rows: [] },
      { found: true, keyed: false, rows: [] },
      { found: true, keyed: true, rows: all.slice(1) },
    ]) {
      const api = new FakeApi().answer('POST /migrations/ledger', ledger)
      await expect(awaitMigrations(crudLedger(target(api)), EXPECTED_MIGRATIONS, { attempts: 1, log: () => undefined })).rejects.toThrow(
        MigrationsPendingError,
      )
    }
  })

  it('stops on an edited migration, as over SQL', async () => {
    const edited = [{ ...all[0]!, checksum: 'f'.repeat(64) }, ...all.slice(1)]
    const api = new FakeApi().answer('POST /migrations/ledger', { found: true, keyed: true, rows: edited })
    await expect(awaitMigrations(crudLedger(target(api)), EXPECTED_MIGRATIONS, { attempts: 1, log: () => undefined })).rejects.toThrow(
      MigrationChecksumError,
    )
  })
})

describe("a signed-in person's session through the API", () => {
  const TOKEN = 'cookie-value'

  it('sends only the hash, and answers the live session or none', async () => {
    const hash = sessionIdHash(TOKEN)
    const api = new FakeApi().answer('POST /auth-sessions/lookup', { session: { principal: 'user:ada', name: 'Ada', kind: 'login' } })
    const sessions = new BrowserSessions(new CrudSessionLookup(target(api)))
    expect(await sessions.resolve(TOKEN)).toEqual({ principal: 'user:ada', name: 'Ada', kind: 'login' })
    expect(api.seen).toEqual([{ method: 'POST', path: '/auth-sessions/lookup', body: { id_hash: hash } }])
    expect(JSON.stringify(api.seen)).not.toContain(TOKEN)
    const none = new FakeApi().answer('POST /auth-sessions/lookup', { session: null })
    expect(await new BrowserSessions(new CrudSessionLookup(target(none))).resolve(TOKEN)).toBeUndefined()
  })

  it('never fails open: a refusal or an unreachable API is no session', async () => {
    const refused = new FakeApi().answer('POST /auth-sessions/lookup', { detail: 'no' }, 503)
    expect(await new BrowserSessions(new CrudSessionLookup(target(refused))).resolve(TOKEN)).toBeUndefined()
    expect(await new BrowserSessions(new CrudSessionLookup(target(refused))).live(sessionIdHash(TOKEN), 'user:ada')).toBeUndefined()
  })

  it('sends nothing for a hash the API would refuse', async () => {
    const api = new FakeApi()
    expect(await new CrudSessionLookup(target(api)).byHash('../areas')).toBeUndefined()
    expect(api.seen).toEqual([])
  })
})

describe("health's probe of the agent's data", () => {
  it('is whether the API answers its areas, never Postgres', async () => {
    const api = new FakeApi().answer('GET /areas', { areas: ['migrations'] })
    const areas = new CrudAreas(BASE, { fetch: api.fetch, wanted: ['migrations'], log: () => undefined })
    expect(await areas.answers()).toBe(true)
    expect(await new CrudAreas(BASE, { fetch: new FakeApi().answer('GET /areas', {}, 503).fetch, wanted: [], log: () => undefined }).answers()).toBe(false)
  })
})
