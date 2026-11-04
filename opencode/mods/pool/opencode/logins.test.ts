// OpenCode's logins over a stand-in integration that lists each pool's logins
// as OAuth credentials beside an API key, which the pool leaves out; a pool the
// world does not list fails as the host's `integration.get` does.
import { Effect } from "effect"
import { loginsLaws } from "../laws.ts"
import * as OpenCodeLogins from "./logins.ts"

loginsLaws("OpenCode's Logins", (world) =>
  OpenCodeLogins.layer<OpenCodeLogins.Connection>(
    {
      connections: (pool) => {
        const ids = world.logins.get(pool)
        return ids === undefined
          ? Effect.fail(new Error(`Integration not found: ${pool}`))
          : Effect.succeed([
              ...ids.map((id) => ({ type: "credential", id, method: "oauth" })),
              { type: "credential", id: "key", method: "key" },
            ])
      },
      status: () => Effect.void,
    },
    () => [],
  ),
)
