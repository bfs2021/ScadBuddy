import type { Sql } from 'postgres'
import type { LedgerReader } from '../db/schema.js'
import type { CrudAreas } from './crudAreas.js'

// What health and the start read of the agent's data (#6501), apart from main.ts so a test can
// check the wiring: /healthz's `database` and the ledger `ready()` waits for.

/**
 * `database` with a ping that is the Postgres ping and, once the API lists every area, the
 * API's answer to them too: the agent still runs SQL (the LISTEN bus, a turn's edits, the MCP
 * relay) until #5299 step 12. `apiUnanswered` says whether the last ping failed on the API, not on Postgres,
 * which aiStatus names; each change in the API's answer is logged.
 */
export function dataHealthOf<D extends { ping(timeoutMs?: number): Promise<boolean> }>(
  database: D,
  areas: Pick<CrudAreas, 'complete' | 'answers'>,
  log: (message: string) => void = (message) => console.warn(message),
): D & { apiUnanswered(): boolean } {
  let answered = true
  return {
    ...database,
    ping: async (timeoutMs?: number) => {
      if (!(await database.ping(timeoutMs))) {
        // The database failed first: the API is not what the status names (it is not asked).
        answered = true
        return false
      }
      if (!areas.complete) {
        answered = true
        return true
      }
      const now = await areas.answers(timeoutMs)
      if (now !== answered) log(now ? "health: the API answers the agent's CRUD areas again" : "health: the API does not answer the agent's CRUD areas")
      answered = now
      return now
    },
    apiUnanswered: () => !answered,
  }
}

/** The ledger through the API once it lists area `migrations`, over SQL until then. */
export function ledgerOf(areas: Pick<CrudAreas, 'has'>, crud: LedgerReader, sqlLedger: (sql: Sql) => LedgerReader): (sql: Sql) => LedgerReader {
  return (sql) => (expected) => (areas.has('migrations') ? crud : sqlLedger(sql))(expected)
}
