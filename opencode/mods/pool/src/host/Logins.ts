// A pool's logins: its integration's OAuth logins, as OpenCode lists them,
// then each gent store's (host/GentStore.ts). The list is trusted for a short
// while, a gent store's logins join even when the integration cannot be read,
// and a login is marked as needing a sign-in only when that changes.
import { Clock, Effect, Layer } from "effect"
import type { PoolId } from "../domain/AccountPool/AccountPool.id.ts"
import { Logins, LoginsUnavailable } from "../domain/AccountPool/Logins.external.ts"
import type { SourceStatus } from "../domain/PoolStatus.ts"
import type { GentListing, GentSource } from "./GentStore.ts"

/** How long the list of a provider's logins is trusted before it is read again. */
export const CREDENTIALS_LIFE_MS = 30_000

/** What the plugin tells OpenCode about a login that cannot refresh its token. */
export const NEEDS_SIGN_IN = {
  status: "needs_auth",
  message: "This login could not refresh its token: sign in again.",
} as const

/** A connection as the integration lists it: only an OAuth credential is a pool login. */
export interface Connection {
  readonly type: string
  readonly id?: string
  readonly method?: string
}

/** The integration's logins and their sign-in status, as the plugin reaches them. */
export interface Integration<C extends Connection> {
  readonly connections: (pool: PoolId) => Effect.Effect<ReadonlyArray<C>, unknown>
  readonly status: (pool: PoolId, connection: C, status: typeof NEEDS_SIGN_IN | undefined) => Effect.Effect<void, unknown>
}

/** An outside store whose logins join a pool. */
export interface Store {
  readonly dir: string
  readonly listing: Effect.Effect<GentListing, { readonly message: string }>
}

const isLogin = <C extends Connection>(connection: C): connection is C & { readonly id: string } =>
  connection.type === "credential" && connection.method === "oauth" && typeof connection.id === "string"

export const layer = <C extends Connection>(integration: Integration<C>, stores: (pool: PoolId) => ReadonlyArray<Store>) =>
  Layer.effect(
    Logins,
    Effect.sync(() => {
      const pools = new Map<
        PoolId,
        { connections: ReadonlyArray<C & { readonly id: string }>; readAt: number; list: ReadonlyArray<string>; readonly flagged: Set<string> }
      >()
      const stateOf = (pool: PoolId) => {
        let state = pools.get(pool)
        if (state === undefined) {
          state = { connections: [], readAt: Number.NEGATIVE_INFINITY, list: [], flagged: new Set() }
          pools.set(pool, state)
        }
        return state
      }

      const listed = (pool: PoolId) =>
        Effect.forEach(stores(pool), (store) =>
          store.listing.pipe(
            Effect.map((listing): SourceStatus => ({ kind: "gent", dir: store.dir, accounts: listing.accounts, skipped: listing.skipped })),
            Effect.mapError((error) => new LoginsUnavailable({ pool, message: error.message })),
          ),
        )

      return Logins.of({
        list: Effect.fn("Logins.list")(function* (pool: PoolId, force: boolean) {
          const state = stateOf(pool)
          if (!force && (yield* Clock.currentTimeMillis) - state.readAt < CREDENTIALS_LIFE_MS) return state.list
          // A store's logins join even when the integration cannot be read.
          const connections = yield* integration.connections(pool).pipe(
            Effect.map((all) => all.filter(isLogin)),
            Effect.catchCause(() =>
              stores(pool).length === 0
                ? Effect.fail(new LoginsUnavailable({ pool, message: "the integration's logins could not be read" }))
                : Effect.succeed(state.connections),
            ),
          )
          state.connections = connections
          state.readAt = yield* Clock.currentTimeMillis
          const sources = yield* listed(pool)
          state.list = [...connections.map((connection) => connection.id), ...sources.flatMap((source) => source.accounts)]
          return state.list
        }),
        markSignIn: Effect.fn("Logins.markSignIn")(function* (pool: PoolId, credentialID: string, needed: boolean) {
          const state = stateOf(pool)
          if (needed === state.flagged.has(credentialID)) return
          const connection = state.connections.find((entry) => entry.id === credentialID)
          if (connection === undefined) return
          if (needed) state.flagged.add(credentialID)
          else state.flagged.delete(credentialID)
          yield* integration.status(pool, connection, needed ? NEEDS_SIGN_IN : undefined).pipe(Effect.ignoreCause)
        }),
        sources: listed,
      })
    }),
  )

/** A pool's logins in the test: each integration's OAuth logins and status marks, and its outside stores. */
export interface TestIntegration {
  /** The integration's connections by pool; a pool absent here cannot be read. */
  readonly connections: Map<PoolId, ReadonlyArray<Connection>>
  /** Each status the plugin set, in order. */
  readonly marks: Array<{ readonly pool: PoolId; readonly credentialID: string; readonly needed: boolean }>
}

export const layerTest = (integration: TestIntegration, stores: (pool: PoolId) => ReadonlyArray<Store> = () => []) =>
  layer<Connection>(
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

/** A gent store as the pool lists it. */
export const gentStore = (source: GentSource): Store => ({ dir: source.dir, listing: source.listing })
