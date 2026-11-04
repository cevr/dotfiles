// A pool's logins held in memory: OpenCode's logins (opencode/logins.ts) over
// an integration kept in a map by pool, which records each sign-in mark the
// pool sets. The plugin's seam tests run on it and read its marks.
import { Effect } from "effect"
import type { PoolId } from "../account-pool.ts"
import * as OpenCodeLogins from "../opencode/logins.ts"

/** Each integration's OAuth logins and status marks. */
export interface Integration {
  /** The integration's connections by pool; a pool absent here cannot be read. */
  readonly connections: Map<PoolId, ReadonlyArray<OpenCodeLogins.Connection>>
  /** Each status the plugin set, in order. */
  readonly marks: Array<{ readonly pool: PoolId; readonly credentialID: string; readonly needed: boolean }>
}

export const layer = (
  integration: Integration,
  stores: (pool: PoolId) => ReadonlyArray<OpenCodeLogins.Store> = () => [],
) =>
  OpenCodeLogins.layer<OpenCodeLogins.Connection>(
    {
      connections: (pool) => {
        const connections = integration.connections.get(pool)
        return connections === undefined ? Effect.fail("unreadable") : Effect.succeed(connections)
      },
      status: (pool, connection, status) =>
        Effect.sync(() => {
          if (connection.id !== undefined) integration.marks.push({ pool, credentialID: connection.id, needed: status !== undefined })
        }),
    },
    stores,
  )
