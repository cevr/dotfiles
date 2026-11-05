// OpenCode's logins of the `anthropic` integration: its active connection, a
// connection chosen by id, and the credential OpenCode holds for each.
import { Effect, Layer } from "effect"
import { isRecord } from "../json.ts"
import type { ConnectionInfo } from "../rate-limit.ts"
import { type Login, LoginFailed, Logins, type StoredCredential } from "../service.ts"

/** The integration as the plugin's context reaches it; `C` is the host's connection. */
export interface Integration<C extends ConnectionInfo> {
  /** The integration's connections. */
  readonly connections: Effect.Effect<ReadonlyArray<C>, unknown>
  readonly active: Effect.Effect<C | undefined>
  /** The credential OpenCode holds for `connection`, refreshed first when it expires. */
  readonly resolve: (connection: C) => Effect.Effect<unknown, unknown>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A stored credential as this plugin reads it: an OAuth credential, or something else. */
function stored(value: unknown): StoredCredential | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value) || value.type !== "oauth") return { type: "other" }
  const { methodID, refresh, access, expires } = value
  if (typeof methodID !== "string" || typeof refresh !== "string" || typeof access !== "string" || typeof expires !== "number") {
    return { type: "other" }
  }
  return { type: "oauth", methodID, refresh, access, expires }
}

const loginOf = <C extends ConnectionInfo>(integration: Integration<C>, connection: C): Login => ({
  connection,
  credential: integration.resolve(connection).pipe(
    Effect.mapError((error) => new LoginFailed({ message: messageOf(error) })),
    Effect.map(stored),
  ),
})

export const NOT_A_CONNECTION = "The chosen Anthropic credential is not a connection of this integration"

export const layer = <C extends ConnectionInfo>(integration: Integration<C>) =>
  Layer.succeed(Logins, {
    active: integration.active.pipe(
      Effect.map((connection) => (connection === undefined ? undefined : loginOf(integration, connection))),
    ),
    chosen: (credentialID) =>
      integration.connections.pipe(
        Effect.mapError((error) => new LoginFailed({ message: messageOf(error) })),
        Effect.flatMap((connections) => {
          const connection = connections.find((entry) => entry.type === "credential" && entry.id === credentialID)
          return connection === undefined
            ? Effect.fail(new LoginFailed({ message: NOT_A_CONNECTION }))
            : Effect.succeed(loginOf(integration, connection))
        }),
      ),
  })
