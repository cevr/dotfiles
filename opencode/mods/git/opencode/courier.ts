// The way a notice gets into a session, through OpenCode's plugin context.
// `layer` works through a plain view of the host's sessions, so the tests run
// it over a stand-in host; `fromContext` takes the view from the plugin
// context.
//
// Where each fact comes from, in the fork (as mods/questions and mods/wake
// rely on them):
// - delivery: `ctx.session.synthetic` admits a synthetic inbox item under the
//   given `id` and wakes the session (`resume: true`); a steer is read at a
//   running execution's next step, so a busy session reads it mid-turn.
// - the notice row: the TUI draws a synthetic message's description as a `◈`
//   row.
// - the id: `msg_` and an ascending identifier: twelve hex digits of
//   `timestamp * 0x1000 + counter`, then fourteen base62 characters.
// - the family: `ctx.session.get` names a child's `parentID`.
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Layer } from "effect"
import { Courier, type Notice, NoticeRefused, SessionUnreadable } from "../service.ts"

/** A synthetic message, as the host's `session.synthetic` takes it. */
export interface Synthetic {
  readonly sessionID: string
  readonly id: string
  readonly text: string
  readonly description: string
  readonly metadata: Record<string, unknown>
  readonly delivery: "steer"
  readonly resume: true
}

/** The host's sessions. */
export interface Host {
  readonly synthetic: (input: Synthetic) => Effect.Effect<unknown, unknown>
  readonly get: (sessionID: string) => Effect.Effect<{ readonly parentID?: string | undefined }, unknown>
}

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message
  if (typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string") return cause._tag
  return String(cause)
}

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

/** The metadata a notice carries, so a reader can tell a pr notice from others. */
export const NOTICE_KEY = "git.pr"

/** How many parents `rootOf` walks at most. */
const MOST_DEPTH = 16

export const layer = (host: Host, mint: () => string = minter()) =>
  Layer.succeed(
    Courier,
    Courier.of({
      rootOf: (sessionID: string) =>
        Effect.gen(function* () {
          let current = sessionID
          for (let depth = 0; depth < MOST_DEPTH; depth += 1) {
            const session = yield* host.get(current).pipe(Effect.mapError((cause) => new SessionUnreadable({ sessionID: current, message: messageOf(cause) })))
            if (session.parentID === undefined) return current
            current = session.parentID
          }
          return current
        }),
      deliver: (sessionID: string, notice: Notice) =>
        host
          .synthetic({ sessionID, id: mint(), text: notice.text, description: notice.title, metadata: { [NOTICE_KEY]: true }, delivery: "steer", resume: true })
          .pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new NoticeRefused({ sessionID, message: messageOf(cause) })),
          ),
    }),
  )

type Input = Parameters<Plugin.Context["session"]["synthetic"]>[0]

/** The host's sessions through the plugin context. */
export const fromContext = (ctx: Plugin.Context) =>
  layer({
    synthetic: (input) => ctx.session.synthetic({ ...input, sessionID: input.sessionID as Input["sessionID"], id: input.id as Input["id"] }),
    get: (sessionID) => ctx.session.get({ sessionID: sessionID as Input["sessionID"] }),
  })
