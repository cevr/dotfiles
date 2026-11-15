// Rex over its command-line tool: `rex block ls --json`, `rex split --json`
// and `rex block close`, each with the session named (`-s`), so the
// caller's own REX_SESSION never picks it. A call that exits non-zero or
// prints what does not decode is RexFailed with Rex's own words.
import { Effect, Layer, Option, Schema } from "effect"
import { Rex, RexFailed } from "../service.ts"

const Listing = Schema.Struct({
  blocks: Schema.Array(Schema.Struct({ block_id: Schema.String, label: Schema.optional(Schema.String) })),
})
const decodeListing = Schema.decodeUnknownEffect(Schema.fromJsonString(Listing))

/** A terminal's `process` method: `child` while its program runs, left out (or null) once it exited. */
const Process = Schema.Struct({ child: Schema.optional(Schema.NullOr(Schema.Struct({ pid: Schema.Number }))) })
const decodeProcess = Schema.decodeUnknownEffect(Schema.fromJsonString(Process))

const Made = Schema.Struct({ block_ids: Schema.NonEmptyArray(Schema.String) })
const decodeMade = Schema.decodeUnknownEffect(Schema.fromJsonString(Made))

/** How much of the pane beside the showcase takes, in percent. */
export const RATIO = 40

/** What one run of the tool printed, and how it exited. */
export interface Ran {
  readonly code: number
  readonly out: string
  readonly err: string
}

/** The arguments of a split beside `beside`, its program after `--`. */
export const splitArgs = (session: string, beside: string, label: string, command: ReadonlyArray<string>): ReadonlyArray<string> => [
  "split",
  "-s",
  session,
  "-b",
  beside,
  "--split=right",
  `--ratio=${RATIO}`,
  `--label=${label}`,
  "--focus=false",
  "--json",
  "--",
  ...command,
]

const named = (args: ReadonlyArray<string>) => args.slice(0, 2).join(" ")

const said = (ran: Ran) => `exit ${ran.code}: ${(ran.err || ran.out).trim()}`

/** How long one call of the tool may take before it is killed. */
const TIMEOUT_MS = 20_000

/** Rex through the tool at `bin` (by default `rex` on PATH). */
export const layer = (bin = "rex") =>
  Layer.sync(Rex, () => {
      const run = Effect.fn("ProcessRex.run")(function* (args: ReadonlyArray<string>) {
        const failed = (cause: unknown) => new RexFailed({ command: named(args), message: String(cause) })
        const child = yield* Effect.try({
          try: () => Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS, killSignal: "SIGKILL" }),
          catch: failed,
        })
        const [out, err, code] = yield* Effect.all(
          [
            Effect.tryPromise({ try: () => new Response(child.stdout).text(), catch: failed }),
            Effect.tryPromise({ try: () => new Response(child.stderr).text(), catch: failed }),
            Effect.tryPromise({ try: () => child.exited, catch: failed }),
          ],
          { concurrency: 3 },
        )
        return { out, err, code } satisfies Ran
      })
      const succeed = Effect.fn("ProcessRex.succeed")(function* (args: ReadonlyArray<string>) {
        const ran = yield* run(args)
        if (ran.code !== 0) return yield* new RexFailed({ command: named(args), message: said(ran) })
        return ran.out
      })
      const undecodable = (command: string) => (error: Schema.SchemaError) => new RexFailed({ command, message: `unexpected output: ${error.message}` })
      const blocks = Effect.fn("ProcessRex.blocks")(function* (session: string) {
        const listing = yield* decodeListing(yield* succeed(["block", "ls", "-s", session, "--json"])).pipe(Effect.mapError(undecodable("block ls")))
        return listing.blocks.map((block) => ({ id: block.block_id, label: block.label ?? "" }))
      })
      return Rex.of({
        blocks,
        split: Effect.fn("ProcessRex.split")(function* (split) {
          const out = yield* succeed(splitArgs(split.session, split.beside, split.label, split.command))
          const made = yield* decodeMade(out).pipe(Effect.mapError(undecodable("split")))
          return made.block_ids[0]
        }),
        close: Effect.fn("ProcessRex.close")(function* (session: string, block: string) {
          const closed = yield* run(["block", "close", "-s", session, block])
          if (closed.code === 0) return
          // A block already gone (closed by another call, or when its program ended) is what was asked.
          const left = yield* blocks(session)
          if (left.some((held) => held.id === block)) return yield* new RexFailed({ command: "block close", message: said(closed) })
        }),
        running: Effect.fn("ProcessRex.running")(function* (session: string, block: string) {
          const asked = yield* run(["block", "call", "-s", session, "-b", block, "process"])
          if (asked.code !== 0) {
            // A block already gone (closed by another call) runs nothing.
            const left = yield* blocks(session)
            if (left.some((held) => held.id === block)) return yield* new RexFailed({ command: "block call", message: said(asked) })
            return false
          }
          const answer = yield* decodeProcess(asked.out).pipe(Effect.mapError(undecodable("block call process")))
          return Option.isSome(Option.fromNullishOr(answer.child))
        }),
      })
  })
