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
// - a latch's child: `Session.create` with `parentID`, `title`, `agent` and
//   `model` makes the child the subagent tool would, and no turn starts until
//   a prompt. A child takes its parent's metadata unless the creator gives its
//   own, so the mark is written over the parent's. `session.update` replaces
//   the metadata whole, so a mark is merged into what the session has; the TUI
//   reads the change from `session.metadata.updated`.
import { Model, type Plugin } from "@opencode/plugin/effect"
import { Clock, Effect, Layer, Random } from "effect"
import { MARK_KEY, type Mark } from "../latch.ts"
import type { Letter } from "../message.ts"
import { type Child, Courier, DeliveryRefused, type Start } from "../service.ts"

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
  readonly create: (input: Created) => Effect.Effect<unknown, unknown>
  readonly prompt: (input: { readonly sessionID: string; readonly id: string; readonly text: string }) => Effect.Effect<unknown, unknown>
  readonly get: (sessionID: string) => Effect.Effect<{ readonly parentID?: string | undefined; readonly metadata?: Readonly<Record<string, unknown>> | undefined }, unknown>
  readonly update: (input: { readonly sessionID: string; readonly metadata: Record<string, unknown> }) => Effect.Effect<unknown, unknown>
}

/** A session as the host's `session.create` takes it: a fire's fresh session, or a latch's child. */
export interface Created {
  readonly id: string
  readonly directory: string
  readonly parentID?: string
  readonly title?: string
  readonly agent?: string
  /** `provider/id#variant`. */
  readonly model?: string
  readonly metadata?: Record<string, unknown>
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

/**
 * The minter on Effect's `Clock` and `Random`: the same ids, its time and its
 * letters read through the services, so a seeded clock and random replay them.
 */
export const minted = (prefix: string, descending = false): Effect.Effect<string> => {
  let now = 0
  let bytes: ReadonlyArray<number> = []
  const mint = minter(prefix, descending, () => now, (target) => {
    target.set(bytes)
    return target
  })
  return Effect.gen(function* () {
    now = yield* Clock.currentTimeMillis
    bytes = yield* Effect.forEach(Array.from({ length: 14 }), () => Random.nextIntBetween(0, 255))
    return mint()
  })
}

const refusal = (sessionID: string) => (cause: unknown) =>
  notFound(cause) ? new DeliveryRefused({ sessionID, message: "no such session", gone: true }) : new DeliveryRefused({ sessionID, message: messageOf(cause), gone: false })

export const layer = (host: Host, mintMessage: Effect.Effect<string> = minted("msg_"), mintSession: Effect.Effect<string> = minted("ses_", true)) =>
  Layer.succeed(Courier, {
    newDelivery: mintMessage,
    newSession: mintSession,
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
    child: (child: Child) =>
      host.get(child.parentID).pipe(
        Effect.mapError(refusal(child.parentID)),
        Effect.flatMap((parent) =>
          host
            .create({
              id: child.sessionID,
              directory: child.directory,
              parentID: child.parentID,
              title: child.title,
              agent: child.agent,
              ...(child.model === undefined ? {} : { model: child.model }),
              metadata: { ...parent.metadata, [MARK_KEY]: { ...child.mark } },
            })
            .pipe(Effect.mapError((cause) => new DeliveryRefused({ sessionID: child.sessionID, message: messageOf(cause), gone: false }))),
        ),
        Effect.asVoid,
      ),
    mark: (sessionID: string, mark: Mark | undefined) =>
      host.get(sessionID).pipe(
        Effect.flatMap((session) => {
          const { [MARK_KEY]: _, ...rest } = session.metadata ?? {}
          return host.update({ sessionID, metadata: mark === undefined ? rest : { ...rest, [MARK_KEY]: { ...mark } } })
        }),
        Effect.ignore,
      ),
  })

type Ids = Parameters<Plugin.Context["session"]["synthetic"]>[0]
type Create = NonNullable<Parameters<Plugin.Context["session"]["create"]>[0]>
type Directory = NonNullable<Create["location"]>["directory"]
type Agent = NonNullable<Create["agent"]>
type Metadata = NonNullable<Create["metadata"]>

/** The host's sessions through the plugin context. */
export const fromContext = (ctx: Plugin.Context) =>
  layer({
    synthetic: (input) => ctx.session.synthetic({ ...input, sessionID: input.sessionID as Ids["sessionID"], id: input.id as Ids["id"] }),
    create: (input) =>
      Effect.try(() => (input.model === undefined ? undefined : Model.Ref.parse(input.model))).pipe(Effect.flatMap((model) =>
        ctx.session.create({
          id: input.id as Ids["sessionID"],
          location: { directory: input.directory as Directory },
          ...(input.parentID === undefined ? {} : { parentID: input.parentID as Ids["sessionID"] }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.agent === undefined ? {} : { agent: input.agent as Agent }),
          ...(model === undefined ? {} : { model }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata as Metadata }),
        }),
      )),
    prompt: (input) => ctx.session.prompt({ sessionID: input.sessionID as Ids["sessionID"], id: input.id as Ids["id"], text: input.text }),
    get: (sessionID) => ctx.session.get({ sessionID: sessionID as Ids["sessionID"] }),
    update: (input) => ctx.session.update({ sessionID: input.sessionID as Ids["sessionID"], metadata: input.metadata as Metadata }),
  })
