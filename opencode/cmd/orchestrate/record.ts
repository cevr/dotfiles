/**
 * The commitment record's CLI, for a host with no plugin (Claude Code, Codex) and for reads over ssh: the same
 * handlers the `commitments` and `follow_up` tools run (mods/orchestrate/commitments-tool.ts), the same refusals.
 *
 *   bun cmd/orchestrate/record.ts <action> [--json '<fields>'] [--file <db>] [--checkout <dir>] [--actor <id>]
 *
 * `<action>` is a `commitments` action (add, assign, order, release, decide, defer, reopen, word, route, landed, invariant, list, history,
 * import), `follow_up` (a worker's: one unowned commitment), or `export` (every event, one JSON line each). `--json`
 * holds the action's fields as the tool takes them. `--file` is the record (default: this checkout's, under
 * `$XDG_STATE_HOME/opencode-orchestrate/`); list, history and export open it read-only. `--checkout` is the
 * repository whose default branch the standings read (default: the working directory). The answer goes to stdout and
 * exits 0; a refusal goes to stderr and exits 1.
 *
 * With no lanes list here, no owner reads as gone: `orphaned` is the plugin's word (status, land, the queue check).
 */
import { parseArgs } from "node:util"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Clock, Console, Effect, Exit, Layer, Match, Option, Schema } from "effect"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import * as Commitments from "@dotfiles/opencode-orchestrate/commitments-tool"
import * as GitMainLine from "@dotfiles/opencode-orchestrate/git/main-line"
import type { Actor } from "@dotfiles/opencode-orchestrate/record"
import { CommitmentRecord, MainLine } from "@dotfiles/opencode-orchestrate/service"
import * as ErgoRegister from "@dotfiles/opencode-orchestrate/sqlite/ergo-register"
import { platform } from "@dotfiles/opencode-orchestrate/node/platform"
import { failureText, type Printable, printable } from "@dotfiles/opencode-orchestrate/printable"
import * as Reasons from "@dotfiles/opencode-orchestrate/reasons"
import * as SqliteRecord from "@dotfiles/opencode-orchestrate/sqlite/record"

const USAGE = "usage: bun cmd/orchestrate/record.ts <action> [--json '<fields>'] [--file <db>] [--checkout <dir>] [--actor <id>]"

/** What the arguments ask for. */
export interface Call {
  readonly action: string
  readonly json: string
  readonly file: Option.Option<string>
  readonly checkout: string
  readonly actor: string
}

/** The call the arguments name; none without an action. */
export const callOf = (args: ReadonlyArray<string>, cwd: string): Option.Option<Call> => {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { json: { type: "string" }, file: { type: "string" }, checkout: { type: "string" }, actor: { type: "string" } },
    allowPositionals: true,
    strict: true,
  })
  return Option.map(Option.fromUndefinedOr(positionals[0]), (action) => ({
    action,
    json: values.json ?? "{}",
    file: Option.fromUndefinedOr(values.file),
    checkout: values.checkout ?? cwd,
    actor: values.actor ?? "cli",
  }))
}

const READS: ReadonlyArray<string> = ["list", "history", "export"]
const decodeFields = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))
const decodeCommitments = Schema.decodeUnknownEffect(Commitments.CommitmentsInput)
const decodeFollowUp = Schema.decodeUnknownEffect(Commitments.FollowUpInput)

/** The fields of `--json`, as an object. */
const fieldsOf = (call: Call) => Effect.mapError(decodeFields(call.json), () => printable("record: --json is not a JSON object of fields; its text is not repeated"))

/** The reads a call makes outside the record: the checkout's default branch through git; no lanes list, so nobody is gone. */
const readsOf = (checkout: string): Commitments.Reads => ({
  facts: (snapshot) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      return yield* Commitments.factsOf(yield* MainLine, checkout, () => Effect.succeed(new Set<string>()), snapshot, now)
    }).pipe(Effect.provide(GitMainLine.layer)),
  register: ErgoRegister.registerReads,
  checkout,
})

/** A `commitments` action by the root. */
const commitmentsCall = (call: Call) =>
  Effect.gen(function* () {
    const fields = yield* fieldsOf(call)
    const input = yield* Effect.mapError(decodeCommitments({ ...fields, action: call.action }), (error) => printable(`record: ${error.message}`))
    const actor: Actor = { id: call.actor, role: "root" }
    return yield* Commitments.answerOf(input, actor, yield* Clock.currentTimeMillis, readsOf(call.checkout))
  })

/** A worker's `follow_up`, its call id the CLI's. */
const followUpCall = (call: Call) =>
  Effect.gen(function* () {
    const input = yield* Effect.mapError(decodeFollowUp(yield* fieldsOf(call)), (error) => printable(`record: ${error.message}`))
    const now = yield* Clock.currentTimeMillis
    return yield* Commitments.followUpOf(input, { id: call.actor, role: "worker" }, `cli-${now}`, now, call.checkout)
  })

/** Every event, oldest first, one JSON line each. */
const exportCall = Effect.gen(function* () {
  const events = yield* Effect.mapError((yield* CommitmentRecord).events, (failed) => failed.message)
  return printable(events.map(SqliteRecord.exportLine).join("\n"))
})

/** The answer to `call` on its record. */
const answer = (call: Call) =>
  Match.value(call.action).pipe(
    Match.when("export", () => exportCall),
    Match.when(Commitments.FOLLOW_UP, () => followUpCall(call)),
    Match.orElse(() => commitmentsCall(call)),
  )

/** The record file `call` names, or this checkout's. */
const fileOf = (call: Call) =>
  Option.match(call.file, {
    onSome: Effect.succeed,
    onNone: () => Effect.flatMap(SqliteRecord.keyOfCheckout(call.checkout), (key) => SqliteRecord.pathOf(Option.some(TuiDirs.dirs().state), key)),
  })

/**
 * The host this CLI runs on: its files, paths and processes (a process outside the plugin host composes them itself),
 * and the plugin's digest. The CLI's platform alone: the server's graph never reaches it (server.test.ts).
 */
const HOST = Layer.mergeAll(BunServices.layer, platform)

/** The record `call` runs on: read-only for a read. */
const recordOf = (call: Call) =>
  Layer.effect(
    CommitmentRecord,
    Effect.gen(function* () {
      const file = yield* Effect.mapError(fileOf(call), (failed) => printable(failed.message))
      const now = yield* Clock.currentTimeMillis
      const opened = yield* Effect.mapError(SqliteRecord.open(file, { readonly: READS.includes(call.action), now }), (failed) => failed.message)
      return SqliteRecord.make(opened.db, opened.refusal)
    }),
  ).pipe(Layer.merge(Reasons.evidenceLayer), Layer.provide(HOST))

/** The output of one run, and its exit code: printable, as everything the CLI prints. */
export interface Ran {
  readonly out: Printable
  readonly err: Printable
  readonly code: number
}

const NOTHING = printable("")

/**
 * A run's output from how it ended: its answer, its refusal, or a defect. The one place a defect's text (a thrown
 * SQLite error, which repeats values) becomes output, and it passes `printable` whole, as every output does.
 */
export const ranOf = (exit: Exit.Exit<Printable, Printable>): Ran =>
  Exit.match(exit, {
    onSuccess: (out): Ran => ({ out, err: NOTHING, code: 0 }),
    onFailure: (cause): Ran => ({ out: NOTHING, err: failureText(cause), code: 1 }),
  })

/** The CLI on `args` in `cwd`: its answer, or why not. */
export const main = (args: ReadonlyArray<string>, cwd: string): Effect.Effect<Ran> =>
  Effect.try({ try: () => callOf(args, cwd), catch: () => printable(USAGE) }).pipe(
    // No action, or an argument parseArgs refuses (its text, an unknown flag's name, is not repeated): the usage.
    Effect.flatMap((call) => Effect.mapError(Effect.fromOption(call), () => printable(USAGE))),
    Effect.flatMap((call) => Effect.scoped(Effect.provide(answer(call), recordOf(call)))),
    Effect.exit,
    Effect.map(ranOf),
  )

if (import.meta.main)
  Effect.runFork(
    Effect.gen(function* () {
      const ran = yield* main(Bun.argv.slice(2), process.cwd())
      if (ran.out !== "") yield* Console.log(ran.out)
      if (ran.err !== "") yield* Console.error(ran.err)
      yield* Effect.sync(() => void (process.exitCode = ran.code))
    }),
  )
