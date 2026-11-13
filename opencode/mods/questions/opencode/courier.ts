// The way into a session, through OpenCode's plugin context. `layer` delivers
// through a plain view of the host's `session.synthetic`, so the laws run it
// over a stand-in host; `fromContext` takes the view from the plugin context.
//
// Where each fact comes from, in the fork:
// - delivery: `ctx.session.synthetic` (packages/core/src/plugin/host.ts:628 →
//   packages/core/src/session/session.ts:287-327) admits a synthetic inbox item
//   under the given `id` (packages/client/src/effect/api/api.ts:240
//   `SessionSyntheticInput.id`) and wakes the session unless `resume: false`.
//   A steer is read at a running execution's next step. A notice goes with
//   `resume: false`: admitted, it waits for the session's next turn.
// - one message per id: admission reconciles by id, first admission wins
//   (packages/core/src/session/inbox.ts:177-222 `reconcile`/`admit`), so a
//   delivery sent again after it stopped short adds nothing.
// - the id: a message id is `msg_` and an ascending identifier
//   (packages/schema/src/session-message.ts:21 `ID`, `create` in
//   packages/schema/src/identifier.ts:16): twelve hex digits of
//   `timestamp * 0x1000 + counter`, then fourteen base62 characters.
// - no such session: `synthetic` first reads the session and fails with
//   `Session.NotFoundError` (packages/core/src/session/error.ts:10).
// - the notice: the TUI draws a synthetic message's description as a `◈`
//   notice row (packages/tui/src/routes/session/index.tsx:2160-2197).
import type { Plugin } from "@opencode/plugin/effect"
import { Clock, Effect, Layer, Random } from "effect"
import type { Letter } from "../reply.ts"
import { Courier, DeliveryRefused } from "../service.ts"

/** A synthetic message, as the host's `session.synthetic` takes it. */
export interface Synthetic {
  readonly sessionID: string
  readonly id: string
  readonly text: string
  readonly description: string
  readonly metadata: Record<string, unknown>
  readonly delivery: "steer"
  /** An answer wakes the session; a notice waits for its next turn. */
  readonly resume: boolean
}

/** The host's inbox. It fails with a `Session.NotFoundError` for a session it does not have. */
export interface Host {
  readonly synthetic: (input: Synthetic) => Effect.Effect<unknown, unknown>
}

export const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message
  if (typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string") return cause._tag
  return String(cause)
}

/** Whether the host's failure says it has no such session. */
export const notFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "Session.NotFoundError"

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** A message-id minter in the host's format; ids from one minter ascend. */
export const minter = (now: () => number = Date.now, random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)) => {
  let last = 0
  let counter = 0
  return (): string => {
    const timestamp = now()
    if (timestamp !== last) {
      last = timestamp
      counter = 0
    }
    counter += 1
    const value = BigInt(timestamp) * 0x1000n + BigInt(counter)
    const time = Array.from({ length: 6 }, (_, index) =>
      Number((value >> BigInt(40 - 8 * index)) & 0xffn)
        .toString(16)
        .padStart(2, "0"),
    ).join("")
    return `msg_${time}${Array.from(random(new Uint8Array(14)), (byte) => BASE62[byte % 62]).join("")}`
  }
}

/**
 * The minter on Effect's `Clock` and `Random`: the same ids, its time and its
 * letters read through the services, so a seeded clock and random replay them.
 */
export const minted = (): Effect.Effect<string> => {
  let now = 0
  let bytes: ReadonlyArray<number> = []
  const mint = minter(
    () => now,
    (target) => {
      target.set(bytes)
      return target
    },
  )
  return Effect.gen(function* () {
    now = yield* Clock.currentTimeMillis
    bytes = yield* Effect.forEach(Array.from({ length: 14 }), () => Random.nextIntBetween(0, 255))
    return mint()
  })
}

export const layer = (host: Host, mint: Effect.Effect<string> = minted()) => {
  const put = (resume: boolean) => (sessionID: string, delivery: string, letter: Letter) =>
    host
      .synthetic({
        sessionID,
        id: delivery,
        text: letter.text,
        description: letter.description,
        metadata: { ...letter.metadata },
        delivery: "steer",
        resume,
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError((cause) =>
          notFound(cause)
            ? new DeliveryRefused({ sessionID, message: "no such session", gone: true })
            : new DeliveryRefused({ sessionID, message: messageOf(cause), gone: false }),
        ),
      )
  return Layer.succeed(Courier, { newDelivery: mint, deliver: put(true), notify: put(false) })
}

type Input = Parameters<Plugin.Context["session"]["synthetic"]>[0]

/** The host's sessions through the plugin context. */
export const fromContext = (ctx: Plugin.Context) =>
  layer({
    synthetic: (input) => ctx.session.synthetic({ ...input, sessionID: input.sessionID as Input["sessionID"], id: input.id as Input["id"] }),
  })
