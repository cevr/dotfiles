// Rex over its command-line tool: `rex block ls --json`, `rex split --json`
// and `rex block close`, each with the session named (`-s`), so the
// caller's own REX_SESSION never picks it. A call that exits non-zero or
// prints what does not decode is RexFailed with Rex's own words.
import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import { Rex, RexFailed, type Split } from "../service.ts"

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

/** The arguments of a split beside `split.beside`, in its folder when it names one, its program after `--`. */
export const splitArgs = (split: Split): ReadonlyArray<string> => [
  "split",
  "-s",
  split.session,
  "-b",
  split.beside,
  "--split=right",
  `--ratio=${RATIO}`,
  `--label=${split.label}`,
  "--focus=false",
  ...Option.match(Option.fromUndefinedOr(split.cwd), { onNone: () => [], onSome: (cwd) => ["-c", cwd] }),
  "--json",
  "--",
  ...split.command,
]

/** Rex's tool where a terminal finds it: beside the Rex that opened it (`$REX_BIN_DIR`), else on `$PATH`, else in the Rex Beta or Rex app; none when it is in none of them. */
export const rexBin = (binDir: Option.Option<string>, path: string, exists: (file: string) => boolean): Option.Option<string> =>
  Arr.findFirst(
    [...Option.toArray(Option.map(binDir, (dir) => `${dir}/rex`)), ...path.split(":").filter((dir) => dir !== "").map((dir) => `${dir}/rex`), ...REX_APPS],
    exists,
  )

/** Where the Rex apps keep their tool on a Mac. */
export const REX_APPS: ReadonlyArray<string> = ["Rex Beta", "Rex"].map((app) => `/Applications/${app}.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex`)

/** Why Rex's tool was not found, for a refusal. */
export const NO_REX = `rex not found: not in $REX_BIN_DIR, on $PATH or in ${REX_APPS.join(" or ")}; set REX_BIN_DIR to the folder that holds it`

/** Rex when its tool is nowhere: each call fails saying so. */
export const missing = Layer.sync(Rex, () => {
  const fail = (command: string) => Effect.fail(new RexFailed({ command, message: NO_REX }))
  return Rex.of({ blocks: () => fail("block ls"), split: () => fail("split"), close: () => fail("block close"), running: () => fail("block call") })
})

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
          const out = yield* succeed(splitArgs(split))
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
