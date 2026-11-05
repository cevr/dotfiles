// A pool's logins: its integration's OAuth logins, as OpenCode lists them,
// then each gent store's (gent/store.ts). The list is trusted for a short
// while, a gent store's logins join even when the integration cannot be read,
// and a login is marked as needing a sign-in only when that changes.
import { Clock, Effect, Layer } from "effect"
import type { PoolId } from "../account-pool.ts"
import type { RefreshRecord, StoreLostLogin } from "../alerts.ts"
import type { GentListing, GentSource } from "../gent/store.ts"
import { Logins, LoginsUnavailable } from "../service.ts"
import type { SourceStatus } from "../status.ts"

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
  /** The name the integration shows for it. */
  readonly label?: string
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
  /** The store's own name for one of its logins; none for a login it does not hold. */
  readonly label: (credentialID: string) => string | undefined
  /** Its logins the token endpoint refused and their files still hold. */
  readonly lost: Effect.Effect<ReadonlyArray<StoreLostLogin>>
  /** How its trades have gone since the endpoint last answered one. */
  readonly refreshes: Effect.Effect<RefreshRecord>
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
        label: (pool: PoolId, credentialID: string) =>
          Effect.sync(() => {
            const connection = stateOf(pool).connections.find((entry) => entry.id === credentialID)
            if (connection?.label !== undefined && connection.label.length > 0) return connection.label
            for (const store of stores(pool)) {
              const label = store.label(credentialID)
              if (label !== undefined) return label
            }
            return credentialID
          }),
        refreshes: (pool: PoolId) =>
          Effect.forEach(stores(pool), (store) =>
            Effect.all({ lost: store.lost, record: store.refreshes }).pipe(Effect.map(({ lost, record }) => ({ dir: store.dir, lost, record }))),
          ),
      })
    }),
  )

/** A gent store as the pool lists it. */
export const gentStore = (source: GentSource): Store => ({
  dir: source.dir,
  listing: source.listing,
  label: (credentialID) => source.label(credentialID),
  lost: source.lost,
  refreshes: source.refreshes,
})
