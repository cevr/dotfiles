// The way into a session, through OpenCode's plugin context. `layer` works
// through a plain view of the host's sessions, so the laws run it over a
// stand-in host; `fromContext` takes the view from the plugin context.
//
// Where each fact comes from, in the fork:
// - delivery: `ctx.session.synthetic` (packages/core/src/session/session.ts:287-327)
//   admits a synthetic inbox item under the given `id` and wakes the session
//   unless `resume: false`; then it waits for the session's next turn. A steer
//   is read at a running execution's next step.
// - one message per id: admission reconciles by id, first admission wins
//   (packages/core/src/session/inbox.ts:177-222), for a synthetic message and a
//   prompt alike (session.ts:161 `admission.reconcile`).
// - ids: a message id is `msg_` and an ascending identifier, a session id
//   `ses_` and a descending one (packages/schema/src/identifier.ts `create`,
//   packages/schema/src/session-id.ts:9): twelve hex digits of
//   `timestamp * 0x1000 + counter` (bitwise not for descending), then fourteen
//   base62 characters.
// - a fresh session: `Session.create` with an id returns the session already
//   recorded under it (packages/core/src/session.ts:290-292), so a resent start
//   makes one session; its location is `{ directory }` (Location.PublicRef).
// - no such session: the host fails with `Session.NotFoundError`
//   (packages/core/src/session/error.ts:10).
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Layer } from "effect"
import type { Letter } from "../message.ts"
import { Courier, DeliveryRefused, type Start } from "../service.ts"

/** A synthetic message, as the host's `session.synthetic` takes it. */
export interface Synthetic {
  readonly sessionID: string
  readonly id: string
  readonly text: string
  readonly description: string
  readonly metadata: Record<string, unknown>
  readonly delivery: "steer"
  readonly resume: boolean
}

/** The host's sessions. Each fails with a `Session.NotFoundError` for a session it does not have. */
export interface Host {
  readonly synthetic: (input: Synthetic) => Effect.Effect<unknown, unknown>
  readonly create: (input: { readonly id: string; readonly directory: string }) => Effect.Effect<unknown, unknown>
  readonly prompt: (input: { readonly sessionID: string; readonly id: string; readonly text: string }) => Effect.Effect<unknown, unknown>
  readonly get: (sessionID: string) => Effect.Effect<{ readonly parentID?: string | undefined }, unknown>
}

export const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message
  if (typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string") return cause._tag
  return String(cause)
}

/** Whether the host's failure says it has no such session. */
export const notFound = (cause: unknown): boolean => typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "Session.NotFoundError"

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** An id minter in the host's format: ids from one minter ascend, or descend with `descending`. */
export const minter = (
  prefix: string,
  descending = false,
  now: () => number = Date.now,
  random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
) => {
  let last = 0
  let counter = 0
  return (): string => {
    const timestamp = now()
    if (timestamp !== last) {
      last = timestamp
      counter = 0
    }
    counter += 1
    const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
    const value = descending ? ~current : current
    const time = Array.from({ length: 6 }, (_, index) =>
      Number((value >> BigInt(40 - 8 * index)) & 0xffn)
        .toString(16)
        .padStart(2, "0"),
    ).join("")
    return `${prefix}${time}${Array.from(random(new Uint8Array(14)), (byte) => BASE62[byte % 62]).join("")}`
  }
}

const refusal = (sessionID: string) => (cause: unknown) =>
  notFound(cause) ? new DeliveryRefused({ sessionID, message: "no such session", gone: true }) : new DeliveryRefused({ sessionID, message: messageOf(cause), gone: false })

export const layer = (host: Host, mintMessage: () => string = minter("msg_"), mintSession: () => string = minter("ses_", true)) =>
  Layer.succeed(Courier, {
    newDelivery: Effect.sync(mintMessage),
    newSession: Effect.sync(mintSession),
    deliver: (sessionID: string, delivery: string, letter: Letter, resume: boolean) =>
      host
        .synthetic({ sessionID, id: delivery, text: letter.text, description: letter.description, metadata: { ...letter.metadata }, delivery: "steer", resume })
        .pipe(Effect.asVoid, Effect.mapError(refusal(sessionID))),
    start: (start: Start) =>
      host.create({ id: start.sessionID, directory: start.directory }).pipe(
        Effect.andThen(host.prompt({ sessionID: start.sessionID, id: start.delivery, text: start.text })),
        Effect.asVoid,
        // A session the fire just made is not gone: a failure here goes again.
        Effect.mapError((cause) => new DeliveryRefused({ sessionID: start.sessionID, message: messageOf(cause), gone: false })),
      ),
    parentOf: (sessionID: string) =>
      host.get(sessionID).pipe(
        Effect.map((session) => session.parentID),
        Effect.orElseSucceed(() => undefined),
      ),
  })

type Ids = Parameters<Plugin.Context["session"]["synthetic"]>[0]
type Directory = NonNullable<NonNullable<Parameters<Plugin.Context["session"]["create"]>[0]>["location"]>["directory"]

/** The host's sessions through the plugin context. */
export const fromContext = (ctx: Plugin.Context) =>
  layer({
    synthetic: (input) => ctx.session.synthetic({ ...input, sessionID: input.sessionID as Ids["sessionID"], id: input.id as Ids["id"] }),
    create: (input) => ctx.session.create({ id: input.id as Ids["sessionID"], location: { directory: input.directory as Directory } }),
    prompt: (input) => ctx.session.prompt({ sessionID: input.sessionID as Ids["sessionID"], id: input.id as Ids["id"], text: input.text }),
    get: (sessionID) => ctx.session.get({ sessionID: sessionID as Ids["sessionID"] }),
  })
