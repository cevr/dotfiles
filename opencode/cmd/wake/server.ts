/**
 * Wakes as an OpenCode server plugin. The composition root: it builds the
 * wakes model (`@dotfiles/opencode-wake/model`) on the plugin's storage, the
 * session inbox, owned `/bin/sh` checks and the Bun.cron backstop, registers
 * the `wake`, `monitor`, `wake_cancel`, `wake_list` and `job` tools, takes
 * OpenCode's schedule tools (`SCHEDULE_TOOLS`) out of the registry, and
 * answers the wakes RPC (`WAKES`) the tray, the OS jobs and the schedule
 * migration (`scripts/migrate-schedules.ts`, over `set`) call.
 *
 * - `wake` sets an alarm and `monitor` a polled command for the calling
 *   session, and return at once; a fire arrives as a synthetic steer that
 *   wakes the session (`notify`: waits for its next turn), or starts a fresh
 *   session (`newSession`). A subagent is refused. Direct tools, so a kernel
 *   cell reaches them as `tools.wake(...)`.
 * - Each entry also gets an OS job (`opencode-wake-<id>`) that fires it when
 *   no server runs: the job starts the OpenCode service and calls `due`.
 * - `job` runs a command as its own process outside the server (a
 *   `systemd-run --user` unit on Linux, a detached process group on the
 *   Mac; runner `job.ts`), so it outlives a restart; its end steers a letter
 *   into the session, through `due` from the runner, the server's poll, or
 *   the next start. `check`, `wait`, `kill` and `list` over the same tool.
 * - `pending({ sessionIDs })` for the tray, `cancel({ sessionID, id })` for its
 *   cancel key, `due({ id })` for the OS jobs;
 *   every change publishes `changed({ sessionID })`.
 * - `latch(LatchAsk)` for orchestrate: a held subagent start kept as a latch
 *   of its parent, its child made unprompted; at its time the wakes ask
 *   orchestrate's opener (`OPENER`) to decide it again.
 * - On start it arms this directory's entries (one past due fires now, and
 *   says how late) and drops OS jobs whose entry went; a deleted session's
 *   entries go; a notice goes once the session's turn takes it.
 *
 * Options: `backstop: "off"` keeps the OS jobs in memory (scenarios, tests);
 * `bun` and `opencode` name those programs by path.
 */
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Clock, Context, Effect, Layer, Ref, Schema, Stream } from "effect"
import * as CronBackstop from "@dotfiles/opencode-wake/cron/backstop"
import * as MemoryBackstop from "@dotfiles/opencode-wake/memory/backstop"
import { DEFAULT_WAIT_MS, MAX_WAIT_MS } from "@dotfiles/opencode-wake/job"
import { alarmReceipt, cancelReceipt, durationOf, jobListing, jobReceipt, jobReport, listing, monitorReceipt } from "@dotfiles/opencode-wake/message"
import * as Model from "@dotfiles/opencode-wake/model"
import * as OpenCodeCourier from "@dotfiles/opencode-wake/opencode/courier"
import * as OpenCodeOpener from "@dotfiles/opencode-wake/opencode/opener"
import * as OpenCodeStore from "@dotfiles/opencode-wake/opencode/store"
import * as ProcessChecks from "@dotfiles/opencode-wake/process/checks"
import * as ProcessRunner from "@dotfiles/opencode-wake/process/runner"
import { type Latched, LatchAsk } from "@dotfiles/opencode-wake/latch"
import { type Backstop, Changes, type Checks, type Courier, type Opener, type Runner, type WakeStore } from "@dotfiles/opencode-wake/service"
import {
  CANCEL_DESCRIPTION,
  CancelInput,
  JOB_DESCRIPTION,
  JobInput,
  LIST_DESCRIPTION,
  ListInput,
  MONITOR_DESCRIPTION,
  MonitorInput,
  NAMES,
  WAKE_DESCRIPTION,
  WakeInput,
} from "@dotfiles/opencode-wake/tools"
import { type Armed, type Cancelled, type Due, type Pending, SetAsk, WAKES, type WakeRejected } from "@dotfiles/opencode-wake/wake"

/**
 * OpenCode's schedule tools, by their registry ids; the wake tools replace
 * them. A schedule fires by prompting its session with its whole action, a
 * real user message each time; a wake or a monitor fires as a short
 * synthetic notice. They are offered only under `experimental.schedules`,
 * and removed here for every agent either way.
 */
export const SCHEDULE_TOOLS = [
  "opencode_schedule_create",
  "opencode_schedule_list",
  "opencode_schedule_pause",
  "opencode_schedule_resume",
  "opencode_schedule_delete",
] as const

export const Options = Schema.Struct({
  /** `cron` (default): an OS job per entry through Bun.cron. `off`: jobs held in memory, for a server whose wakes must not outlive it. */
  backstop: Schema.optional(Schema.Literals(["cron", "off"])),
  /** A real bun, by path; default the one on PATH, else ~/.bun/bin/bun. */
  bun: Schema.optional(Schema.String),
  /** The launcher an OS job starts OpenCode with; default ~/.local/bin/opencode. */
  opencode: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

/** What the wakes run on. */
export type Externals = WakeStore | Courier | Checks | Backstop | Opener | Runner

/** The OS job's script, beside this file. */
export const SCRIPT = fileURLToPath(new URL("./backstop.ts", import.meta.url))
/** A job's runner, beside this file. */
export const JOB_SCRIPT = fileURLToPath(new URL("./job.ts", import.meta.url))

const bunOf = (options: Options, home: string) => options.bun ?? Bun.which("bun") ?? path.join(home, ".bun", "bin", "bun")

/** Where jobs run: their own processes, whose end calls the service through the backstop's script unless the backstop is off. */
export const runnerOf = (options: Options, env: Readonly<Record<string, string | undefined>> = process.env): Layer.Layer<Runner> => {
  const home = env.HOME ?? TuiDirs.dirs().home
  return ProcessRunner.layer({
    root: path.join(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "opencode-job"),
    bun: bunOf(options, home),
    script: JOB_SCRIPT,
    platform: process.platform,
    env,
    opencode: options.backstop === "off" ? undefined : (options.opencode ?? path.join(home, ".local", "bin", "opencode")),
    exec: CronBackstop.exec,
  })
}

/** The OS backstop the options pick. */
export const backstopOf = (options: Options, env: Readonly<Record<string, string | undefined>> = process.env): Layer.Layer<Backstop> => {
  if (options.backstop === "off") return MemoryBackstop.layer(MemoryBackstop.empty())
  const home = env.HOME ?? TuiDirs.dirs().home
  return CronBackstop.layer({
    bun: bunOf(options, home),
    script: SCRIPT,
    jobs: path.join(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "opencode-wake", "jobs"),
    opencode: options.opencode ?? path.join(home, ".local", "bin", "opencode"),
    env,
    platform: process.platform,
    launchAgents: path.join(home, "Library", "LaunchAgents"),
    exec: CronBackstop.exec,
  })
}

/** The live externals: the plugin's storage, the session inbox, owned checks, orchestrate's opener, the backstop the options pick, and job processes. */
export const live = (ctx: Plugin.Context, options: Options): Layer.Layer<Externals> =>
  Layer.mergeAll(
    OpenCodeStore.fromContext(ctx),
    OpenCodeCourier.fromContext(ctx),
    ProcessChecks.layer,
    OpenCodeOpener.fromContext(ctx),
    backstopOf(options),
    runnerOf(options),
  )

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] })
const refused = (failure: WakeRejected) => new Tool.Error({ message: failure.reason, error: failure })

const asked = (what: string) => new Tool.Error({ message: what })

/** The `job` tool: run, check, wait, kill and list over the wakes' jobs. */
const jobTool = (wakes: Context.Service.Shape<typeof Model.WakesModel>, input: JobInput, sessionID: string) => {
  const action = input.action ?? "run"
  if (action === "list") return wakes.jobs(sessionID).pipe(Effect.map(({ jobs, now }) => text(jobListing(jobs, now))))
  if (action === "run") {
    if (input.command === undefined || input.note === undefined) return Effect.fail(asked('job({ action: "run" }) needs a command and a note'))
    return wakes
      .job(sessionID, { command: input.command, cwd: input.cwd, note: input.note, heavy: input.heavy, timeoutSeconds: input.timeoutSeconds })
      .pipe(Effect.map(({ job, launched }) => text(jobReceipt(job, launched))), Effect.mapError(refused))
  }
  const id = input.id
  if (id === undefined) return Effect.fail(asked(`job({ action: "${action}" }) needs the job's id`))
  if (action === "check") return wakes.check(id).pipe(Effect.map(({ view, now }) => text(jobReport(view, now))), Effect.mapError(refused))
  if (action === "wait") {
    const ms = Math.min(MAX_WAIT_MS, Math.max(0, input.ms ?? DEFAULT_WAIT_MS))
    return wakes.wait(id, ms).pipe(
      Effect.map(({ view, now, ended }) => text(jobReport(view, now, ended ? [] : [`It still runs after a wait of ${durationOf(ms)}; its end letter still comes.`]))),
      Effect.mapError(refused),
    )
  }
  return wakes.kill(id).pipe(
    Effect.map(({ view, now, asked: stopped }) => text(jobReport(view, now, stopped ? [] : ["It was not running, so nothing was stopped."]))),
    Effect.mapError(refused),
  )
}

const PendingInput = Schema.Struct({ sessionIDs: Schema.Array(Schema.String) })
const DueInput = Schema.Struct({ id: Schema.String })
const CancelAsk = Schema.Struct({ sessionID: Schema.String, id: Schema.String })

/** The plugin on `externals`: OpenCode's in a server, the memory doubles in the seam test. */
export const make = (externals: (ctx: Plugin.Context, options: Options) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: WAKES.id,
    effect: Effect.fn("Wake.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options ?? {}).pipe(
        Effect.mapError((error) => new Error(`${WAKES.id}: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      // Changes are announced once the RPC is registered; one before then has no reader to tell.
      const announce = yield* Ref.make<(sessionID: string) => Effect.Effect<void>>(() => Effect.void)
      const changes = Layer.succeed(Changes, { changed: (sessionID) => Effect.flatMap(Ref.get(announce), (emit) => emit(sessionID)) })
      const services = yield* Layer.build(Model.layer({ directory: ctx.location.directory }).pipe(Layer.provide(Layer.merge(externals(ctx, options), changes))))
      const wakes = Context.get(services, Model.WakesModel)

      yield* ctx.tool.transform((editor) => {
        for (const id of SCHEDULE_TOOLS) editor.remove(id)
        // Direct tools beside the others, so they are offered without code mode and reached from a kernel cell.
        editor.add({
          name: NAMES.wake,
          description: WAKE_DESCRIPTION,
          input: WakeInput,
          options: { codemode: false },
          execute: (input, context) =>
            wakes.wake(context.sessionID, input).pipe(
              Effect.map((placed) => text(alarmReceipt(placed.entry, placed.now, placed.warning))),
              Effect.mapError(refused),
            ),
        })
        editor.add({
          name: NAMES.monitor,
          description: MONITOR_DESCRIPTION,
          input: MonitorInput,
          options: { codemode: false },
          execute: (input, context) =>
            wakes.monitor(context.sessionID, input).pipe(
              Effect.map((placed) => text(monitorReceipt(placed.entry, placed.now, placed.warning))),
              Effect.mapError(refused),
            ),
        })
        editor.add({
          name: NAMES.cancel,
          description: CANCEL_DESCRIPTION,
          input: CancelInput,
          options: { codemode: false },
          execute: (input, context) => wakes.cancel(context.sessionID, input.id).pipe(Effect.map((gone) => text(cancelReceipt(gone))), Effect.mapError(refused)),
        })
        editor.add({
          name: NAMES.list,
          description: LIST_DESCRIPTION,
          input: ListInput,
          options: { codemode: false },
          execute: (_input, context) => wakes.list(context.sessionID).pipe(Effect.map((listed) => text(listing(listed.entries, listed.notices, listed.now)))),
        })
        editor.add({
          name: NAMES.job,
          description: JOB_DESCRIPTION,
          input: JobInput,
          options: { codemode: false },
          execute: (input, context) => jobTool(wakes, input, context.sessionID),
        })
      })

      // A deleted session's wakes go; a notice goes once the session's turn took its message.
      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: ["session.deleted", "session.inbox.delivered"] }).pipe(
          Stream.runForEach((event) =>
            (event.type === "session.deleted" ? wakes.forget(event.data.sessionID) : wakes.read(event.data.inboxID)).pipe(Effect.ignoreCause),
          ),
          Effect.ignoreCause,
        ),
      )

      const registration = yield* ctx.rpc
        .register(WAKES, {
          pending: (input) =>
            Schema.decodeUnknownEffect(PendingInput)(input).pipe(
              Effect.flatMap(({ sessionIDs }) => wakes.pending(sessionIDs)),
              Effect.catch(() => Clock.currentTimeMillis.pipe(Effect.map((now): Pending => ({ now, entries: [], notices: [] })))),
            ),
          due: (input) =>
            Schema.decodeUnknownEffect(DueInput)(input).pipe(
              Effect.flatMap(({ id }) => wakes.due(id)),
              Effect.orElseSucceed((): Due => ({ outcome: "pending" })),
            ),
          latch: (input) =>
            Schema.decodeUnknownEffect(LatchAsk)(input).pipe(
              Effect.mapError((error) => ({ reason: `not a latch: ${error.message}` })),
              Effect.flatMap((ask) => wakes.latch(ask)),
              Effect.map((latched): Latched => ({ outcome: "latched", id: latched.id, child: latched.child })),
              Effect.catch((failure) => Effect.succeed<Latched>({ outcome: "refused", reason: failure.reason })),
            ),
          cancel: (input) =>
            Schema.decodeUnknownEffect(CancelAsk)(input).pipe(
              Effect.mapError((error) => ({ reason: `not a cancel: ${error.message}` })),
              Effect.flatMap(({ sessionID, id }) => wakes.cancel(sessionID, id)),
              Effect.map((ids): Cancelled => ({ outcome: "cancelled", ids })),
              Effect.catch((failure) => Effect.succeed<Cancelled>({ outcome: "refused", reason: failure.reason })),
            ),
          set: (input) =>
            Schema.decodeUnknownEffect(SetAsk)(input).pipe(
              Effect.mapError((error) => ({ reason: `not a wake or a monitor: ${error.message}` })),
              Effect.flatMap((ask) =>
                "wake" in ask
                  ? wakes.wake(ask.sessionID, ask.wake).pipe(Effect.map((placed) => placed.entry.id))
                  : wakes.monitor(ask.sessionID, ask.monitor).pipe(Effect.map((placed) => placed.entry.id)),
              ),
              Effect.map((id): Armed => ({ outcome: "set", id })),
              Effect.catch((failure) => Effect.succeed<Armed>({ outcome: "refused", reason: failure.reason })),
            ),
        })
        .pipe(Effect.orDie)
      yield* Ref.set(announce, (sessionID) => registration.events.emit("changed", { sessionID }).pipe(Effect.ignore))

      // Arm what was set before this start, and fire what came due meanwhile, without holding up the start.
      yield* Effect.forkScoped(wakes.start.pipe(Effect.ignoreCause))
    }),
  })

export default make(live)
