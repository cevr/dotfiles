// Antigravity in the pool plugin: the one boundary between the pool and the
// Antigravity code. The rows a pool_push status appends, the pool's
// `antigravity` RPC method and the `antigravity` tool all come from here, and
// every one of them is contained: whatever the Antigravity code does (a typed
// failure, a defect, a rejected promise in a double or the real thing), the
// pool's answer still comes, with a typed "unknown: <reason>" row in place of
// the rows. Nothing here runs at plugin start.
import { Array as Arr, Data, Effect, Match, Option, Schema } from "effect"
import { type AntigravityReport, OpenStatus } from "./fleet.ts"
import { GateDecision, gateText } from "./gate.ts"
import { type GroupAnswer, reasonOf, type Source } from "./source.ts"
import { openDecisionText } from "./text.ts"
import { ANTIGRAVITY_DESCRIPTION, AntigravityToolInput, answer } from "./tool.ts"

/** The tool's name: the plugin registers `{ ...tool, name: TOOL_NAME }`, a name read without running it. */
export const TOOL_NAME = "antigravity"

/** The row in place of Antigravity's when its code failed. */
export const containedLine = (reason: string) => `antigravity · unknown: the Antigravity reader failed here (${reason})`

/**
 * What the pool has of Antigravity, each with its own true words: a source;
 * none because the pool's option is `false` (off); or none because building
 * the source failed here, with its reason (the option on).
 */
export type Availability = Data.TaggedEnum<{
  Present: { readonly source: Source }
  Off: {}
  Failed: { readonly reason: string }
}>
export const Availability = Data.taggedEnum<Availability>()

/** The row, and the tool's answer, when the source did not build: never "the option is off". */
export const failedLine = (reason: string) => `antigravity · unavailable: its source did not build on this host (${reason}); the antigravity option is on`

/**
 * The availability `root` gives: Present with a source, Off with none (the
 * root gives none only for the option `false`), Failed with the reason of any
 * failure or defect.
 */
export const availability = <R,>(root: Effect.Effect<Option.Option<Source>, never, R>): Effect.Effect<Availability, never, R> =>
  root.pipe(
    Effect.map(Option.match({ onNone: () => Availability.Off(), onSome: (source) => Availability.Present({ source }) })),
    Effect.catchCause((cause) => Effect.succeed(Availability.Failed({ reason: reasonOf(cause) }))),
  )

export const RpcInput = Schema.Struct({
  action: Schema.optionalKey(Schema.Literals(["status", "open", "gate", "heartbeat", "release", "record", "limit"])),
  group: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(Schema.String),
  at: Schema.optionalKey(Schema.Finite),
  agent: Schema.optionalKey(Schema.String),
  paneId: Schema.optionalKey(Schema.String),
  resume: Schema.optionalKey(Schema.Boolean),
  recordStart: Schema.optionalKey(Schema.Boolean),
})
export type RpcRequest = typeof RpcInput.Type

/** One group's structured RPC answer for "open now, else when": `until` is always finite when `open` is false. */
export interface RpcGroupOpen {
  readonly group: string
  readonly label: string
  readonly open: boolean
  readonly measured: boolean
  readonly until?: number
  readonly text: string
}

/** Structured RPC answer for the start gate: `retryAt` is always finite when `allowed` is false. */
export interface RpcGateAnswer {
  readonly allowed: boolean
  readonly group: string
  readonly measured?: boolean
  readonly why?: "limited" | "gemini-cap-fleet" | "gemini-cap-agent"
  readonly retryAt?: number
  readonly reason?: string
  readonly geminiFleetCount: number
  readonly geminiAgentCount: number
  readonly text: string
}

const rpcGroupOf = (entry: GroupAnswer): RpcGroupOpen =>
  OpenStatus.match(entry.open, {
    Now: ({ measured }) => ({ group: entry.group, label: entry.label, open: true, measured, text: openDecisionText(entry.open) }),
    NotNow: ({ until }) => ({ group: entry.group, label: entry.label, open: false, measured: true, until, text: openDecisionText(entry.open) }),
  })

const rpcGateOf = (decision: GateDecision): RpcGateAnswer =>
  GateDecision.match(decision, {
    Admitted: ({ group, measured, geminiFleetCount, geminiAgentCount }) => ({
      allowed: true,
      group,
      measured,
      geminiFleetCount,
      geminiAgentCount,
      text: gateText(decision),
    }),
    Held: ({ group, why, retryAt, reason, geminiFleetCount, geminiAgentCount }) => ({
      allowed: false,
      group,
      why,
      retryAt,
      reason,
      geminiFleetCount,
      geminiAgentCount,
      text: gateText(decision),
    }),
  })

export interface Wiring {
  /** Antigravity's rows as stored/merged; none with no source. Never fails. */
  readonly lines: Effect.Effect<ReadonlyArray<string>>
  /** This host's own Antigravity report for the fleet Report; none when off or failed. Never fails. */
  readonly report: Effect.Effect<Option.Option<AntigravityReport>>
  /** A pool_push answer's text, with Antigravity's rows after it for a `status`. Never fails. */
  readonly pushText: (action: string, text: string) => Effect.Effect<string>
  /**
   * The pool's `antigravity` RPC method:
   * - `{}` or `{ action: "status" }`: `{ lines }` (backward-compatible with /pool pane).
   * - `{ action: "open", group?, model? }`: `{ groups, lines }` from the merged record with finite `until` whenever `open` is false.
   * - `{ action: "gate", group?, model?, agent?, resume?, recordStart? }`: `{ gate, lines }`.
   * - `{ action: "record" | "limit", text, group?, model?, host?, at? }`: `{ recorded, resetAt?, lines }`.
   * Never fails.
   */
  readonly rpc: (input?: RpcRequest) => Effect.Effect<{
    readonly lines: ReadonlyArray<string>
    readonly groups?: ReadonlyArray<RpcGroupOpen>
    readonly gate?: RpcGateAnswer
    readonly recorded?: boolean
    readonly resetAt?: number
  }>
  /** The `antigravity` tool as the plugin adds it, under the name TOOL_NAME. Its execute never fails. */
  readonly tool: {
    readonly description: string
    readonly input: typeof AntigravityToolInput
    readonly options: { readonly codemode: false }
    readonly execute: (input: AntigravityToolInput) => Effect.Effect<{ readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }> }>
  }
}

export const wire = (agy: Availability): Wiring => {
  const lines = Availability.$match(agy, {
    Present: ({ source }) => source.lines,
    Off: () => Effect.succeed<ReadonlyArray<string>>([]),
    Failed: ({ reason }) => Effect.succeed([failedLine(reason)]),
  }).pipe(
    Effect.catchCause((cause) => Effect.succeed([containedLine(reasonOf(cause))])),
  )
  const report = Availability.$match(agy, {
    Present: ({ source }) => Effect.map(source.report, Option.some),
    Off: () => Effect.succeed(Option.none<AntigravityReport>()),
    Failed: () => Effect.succeed(Option.none<AntigravityReport>()),
  }).pipe(Effect.catchCause(() => Effect.succeed(Option.none<AntigravityReport>())))
  const openRpc = (target: Option.Option<string>) =>
    Availability.$match(agy, {
      Present: ({ source }) =>
        Effect.all({ groups: Effect.map(source.open(target), (items) => items.map(rpcGroupOf)), lines: source.lines }),
      Off: () => Effect.succeed({ groups: Arr.empty<RpcGroupOpen>(), lines: Arr.empty<string>() }),
      Failed: ({ reason }) => Effect.succeed({ groups: Arr.empty<RpcGroupOpen>(), lines: [failedLine(reason)] }),
    }).pipe(Effect.catchCause((cause) => Effect.succeed({ groups: Arr.empty<RpcGroupOpen>(), lines: [containedLine(reasonOf(cause))] })))
  const gateRpc = (parsed: typeof RpcInput.Type) =>
    Availability.$match(agy, {
      Present: ({ source }) =>
        Effect.gen(function* () {
          const decision = yield* source.gate({
            ...Option.match(Option.fromUndefinedOr(parsed.group), { onNone: () => ({}), onSome: (group) => ({ group }) }),
            ...Option.match(Option.fromUndefinedOr(parsed.model), { onNone: () => ({}), onSome: (model) => ({ model }) }),
            ...Option.match(Option.fromUndefinedOr(parsed.agent), { onNone: () => ({}), onSome: (agent) => ({ agent }) }),
            ...Option.match(Option.fromUndefinedOr(parsed.paneId), { onNone: () => ({}), onSome: (paneId) => ({ paneId }) }),
            ...Option.match(Option.fromUndefinedOr(parsed.resume), { onNone: () => ({}), onSome: (resume) => ({ resume }) }),
            ...Option.match(Option.fromUndefinedOr(parsed.recordStart), { onNone: () => ({}), onSome: (recordStart) => ({ recordStart }) }),
          })
          return { gate: rpcGateOf(decision), lines: yield* source.lines }
        }),
      Off: () =>
        Effect.succeed({
          gate: { allowed: true, group: Option.getOrElse(Option.orElse(Option.fromUndefinedOr(parsed.group), () => Option.fromUndefinedOr(parsed.model)), () => "gemini"), measured: false, geminiFleetCount: 0, geminiAgentCount: 0, text: "admitted: antigravity option is off" },
          lines: Arr.empty<string>(),
        }),
      Failed: ({ reason }) =>
        Effect.succeed({
          gate: { allowed: true, group: Option.getOrElse(Option.orElse(Option.fromUndefinedOr(parsed.group), () => Option.fromUndefinedOr(parsed.model)), () => "gemini"), measured: false, geminiFleetCount: 0, geminiAgentCount: 0, text: failedLine(reason) },
          lines: [failedLine(reason)],
        }),
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed({
          gate: { allowed: true, group: "gemini", measured: false, geminiFleetCount: 0, geminiAgentCount: 0, text: containedLine(reasonOf(cause)) },
          lines: [containedLine(reasonOf(cause))],
        }),
      ),
    )
  const recordRpc = (parsed: typeof RpcInput.Type) =>
    Availability.$match(agy, {
      Present: ({ source }) =>
        Effect.gen(function* () {
          const target = Option.orElse(Option.fromUndefinedOr(parsed.group), () => Option.fromUndefinedOr(parsed.model))
          const recorded = yield* source.record(Option.getOrElse(Option.fromUndefinedOr(parsed.text), () => ""), target, {
            ...Option.match(Option.fromUndefinedOr(parsed.host), { onNone: () => ({}), onSome: (host) => ({ host }) }),
            ...Option.match(Option.fromUndefinedOr(parsed.at), { onNone: () => ({}), onSome: (at) => ({ at }) }),
          })
          const rows = yield* source.lines
          return Option.match(recorded, {
            onNone: () => ({ recorded: false, lines: rows }),
            onSome: (seen) =>
              Option.match(seen.resetAt, {
                onNone: () => ({ recorded: true, lines: rows }),
                onSome: (resetAt) => ({ recorded: true, resetAt, lines: rows }),
              }),
          })
        }),
      Off: () => Effect.succeed({ recorded: false, lines: Arr.empty<string>() }),
      Failed: ({ reason }) => Effect.succeed({ recorded: false, lines: [failedLine(reason)] }),
    }).pipe(Effect.catchCause((cause) => Effect.succeed({ recorded: false, lines: [containedLine(reasonOf(cause))] })))
  return {
    lines,
    report,
    pushText: (action, text) =>
      Match.value(action).pipe(
        Match.when("status", () => Effect.map(lines, (rows) => [text, ...rows].join("\n"))),
        Match.orElse(() => Effect.succeed(text)),
      ),
    rpc: (input) =>
      Option.match(Option.fromUndefinedOr(input), {
        onNone: () => Effect.map(lines, (rows) => ({ lines: rows })),
        onSome: (parsed) =>
          Match.value(parsed.action).pipe(
            Match.when("open", () => openRpc(Option.orElse(Option.fromUndefinedOr(parsed.group), () => Option.fromUndefinedOr(parsed.model)))),
            Match.when("gate", () => gateRpc(parsed)),
            Match.when("heartbeat", () =>
              Availability.$match(agy, {
                Present: ({ source }) =>
                  Option.match(Option.fromUndefinedOr(parsed.paneId), {
                    onNone: () => Effect.map(lines, (rows) => ({ lines: rows })),
                    onSome: (paneId) => Effect.andThen(source.heartbeat(paneId, parsed.agent), Effect.map(lines, (rows) => ({ lines: rows }))),
                  }),
                Off: () => Effect.succeed({ lines: Arr.empty<string>() }),
                Failed: ({ reason }) => Effect.succeed({ lines: [failedLine(reason)] }),
              }).pipe(Effect.catchCause((cause) => Effect.succeed({ lines: [containedLine(reasonOf(cause))] }))),
            ),
            Match.when("release", () =>
              Availability.$match(agy, {
                Present: ({ source }) =>
                  Option.match(Option.fromUndefinedOr(parsed.paneId), {
                    onNone: () => Effect.map(lines, (rows) => ({ lines: rows })),
                    onSome: (paneId) => Effect.andThen(source.release(paneId), Effect.map(lines, (rows) => ({ lines: rows }))),
                  }),
                Off: () => Effect.succeed({ lines: Arr.empty<string>() }),
                Failed: ({ reason }) => Effect.succeed({ lines: [failedLine(reason)] }),
              }).pipe(Effect.catchCause((cause) => Effect.succeed({ lines: [containedLine(reasonOf(cause))] }))),
            ),
            Match.whenOr("record", "limit", () => recordRpc(parsed)),
            Match.orElse(() => Effect.map(lines, (rows) => ({ lines: rows }))),
          ),
      }),
    tool: {
      description: ANTIGRAVITY_DESCRIPTION,
      input: AntigravityToolInput,
      options: { codemode: false },
      execute: (input) =>
        Availability.$match(agy, {
          Present: ({ source }) => answer(Option.some(source), input),
          Off: () => answer(Option.none(), input),
          Failed: ({ reason }) => Effect.succeed(failedLine(reason)),
        }).pipe(
          Effect.catchCause((cause) => Effect.succeed(containedLine(reasonOf(cause)))),
          Effect.map((text) => ({ content: [{ type: "text" as const, text }] })),
        ),
    },
  }
}
