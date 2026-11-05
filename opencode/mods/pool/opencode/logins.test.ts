// OpenCode's logins over a stand-in integration that lists each pool's logins
// as OAuth credentials beside an API key, which the pool leaves out; a pool the
// world does not list fails as the host's `integration.get` does. The host
// always gives a credential a label; one with no name of its own is empty here.
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { PoolId } from "../account-pool.ts"
import { loginsLaws } from "../laws.ts"
import { Logins } from "../service.ts"
import * as OpenCodeLogins from "./logins.ts"

loginsLaws("OpenCode's Logins", (world) =>
  OpenCodeLogins.layer<OpenCodeLogins.Connection>(
    {
      connections: (pool) => {
        const ids = world.logins.get(pool)
        return ids === undefined
          ? Effect.fail(new Error(`Integration not found: ${pool}`))
          : Effect.succeed([
              ...ids.map((id) => ({ type: "credential", id, method: "oauth", label: world.labels.get(id) ?? "" })),
              { type: "credential", id: "key", method: "key", label: "API key" },
            ])
      },
      status: () => Effect.void,
    },
    () => [],
  ),
)

test("an outside store's login is named by the store's own label", () => {
  const pool = PoolId.make("anthropic")
  const store: OpenCodeLogins.Store = {
    dir: "/gent",
    listing: Effect.succeed({ accounts: ["gent:claude-max-2"], skipped: [] }),
    label: (credentialID) => (credentialID.startsWith("gent:") ? credentialID.slice("gent:".length) : undefined),
    lost: Effect.succeed([]),
    refreshes: Effect.succeed({ failures: 0, pausedUntil: 0 }),
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      const logins = yield* Logins
      expect(yield* logins.list(pool, true)).toEqual(["cred-a", "gent:claude-max-2"])
      expect(yield* logins.label(pool, "gent:claude-max-2")).toBe("claude-max-2")
      expect(yield* logins.label(pool, "cred-a")).toBe("Claude OAuth • 0123ABCD")
    }).pipe(
      Effect.provide(
        OpenCodeLogins.layer<OpenCodeLogins.Connection>(
          {
            connections: () => Effect.succeed([{ type: "credential", id: "cred-a", method: "oauth", label: "Claude OAuth • 0123ABCD" }]),
            status: () => Effect.void,
          },
          () => [store],
        ),
      ),
    ),
  )
})

test("each outside store reports its lost logins and its run of failed refreshes, under its directory", () => {
  const pool = PoolId.make("anthropic")
  const lost = { credentialID: "gent:work", label: "work", since: 5, command: "gent auth login anthropic --slot work" }
  const record = { failingSince: 1, lastFailureAt: 4, failures: 3, cause: { status: 429 }, pausedUntil: 9 }
  const store: OpenCodeLogins.Store = {
    dir: "/gent",
    listing: Effect.succeed({ accounts: ["gent:work"], skipped: [] }),
    label: () => undefined,
    lost: Effect.succeed([lost]),
    refreshes: Effect.succeed(record),
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* (yield* Logins).refreshes(pool)).toEqual([{ dir: "/gent", lost: [lost], record }])
    }).pipe(
      Effect.provide(OpenCodeLogins.layer<OpenCodeLogins.Connection>({ connections: () => Effect.succeed([]), status: () => Effect.void }, () => [store])),
    ),
  )
})
