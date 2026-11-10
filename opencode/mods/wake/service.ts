// The contracts the wakes need from outside: somewhere to keep the entries and
// notices, a way into a session, a way to run a monitor's command, the OS
// backstop that fires an entry when no server runs, the opener that decides a
// latch again, the runner that runs a job outside the server, and word of a
// change. What every implementation owes is in
// laws.ts.
import { Context, type Effect, Schema } from "effect"
import type { Job, Schedule } from "./backstop.ts"
import type { JobRecord, JobSpec, Launched } from "./job.ts"
import type { Latch, Mark, Opened } from "./latch.ts"
import type { Letter } from "./message.ts"
import type { Check, Entry, Notice } from "./wake.ts"

/** The host would not take the fire into the session; `gone` when the session no longer exists. */
export class DeliveryRefused extends Schema.TaggedError<DeliveryRefused>()("DeliveryRefused", {
  sessionID: Schema.String,
  message: Schema.String,
  gone: Schema.Boolean,
}) {}

/** The OS scheduler would not take, drop or list a job; `message` says why. */
export class BackstopRefused extends Schema.TaggedError<BackstopRefused>()("BackstopRefused", { message: Schema.String }) {}

/**
 * The entries and notices, across every directory's server.
 * - `entries` lists every entry that reads; `ids` every entry's id, readable or not.
 * - `read` gives one entry, or undefined when none (or none that reads).
 * - `write` replaces an entry whole; `remove` forgets it, and removing none is no failure.
 * - Notices go by their delivery id the same way.
 */
export class WakeStore extends Context.Service<
  WakeStore,
  {
    readonly entries: Effect.Effect<ReadonlyArray<Entry>>
    readonly ids: Effect.Effect<ReadonlyArray<string>>
    readonly read: (id: string) => Effect.Effect<Entry | undefined>
    readonly write: (entry: Entry) => Effect.Effect<void>
    readonly remove: (id: string) => Effect.Effect<void>
    readonly notices: Effect.Effect<ReadonlyArray<Notice>>
    readonly writeNotice: (notice: Notice) => Effect.Effect<void>
    readonly removeNotice: (delivery: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/wake/WakeStore") {}

/** A session a `newSession` alarm starts: its minted id, where, and its first prompt under the fire's message id. */
export interface Start {
  readonly sessionID: string
  readonly directory: string
  readonly delivery: string
  readonly text: string
}

/** A latch's child session: its minted id, its parent, where, its title (the subagent's description), agent and model, and its mark. */
export interface Child {
  readonly sessionID: string
  readonly parentID: string
  readonly directory: string
  readonly title: string
  readonly agent: string
  /** `provider/id#variant`. */
  readonly model?: string | undefined
  readonly mark: Mark
}

/**
 * The way into a session.
 * - `newDelivery`: an id for one fire's message, minted before it is sent.
 *   Ids are distinct and later ones sort after earlier ones.
 * - `newSession`: an id for a session a fire starts, minted before it starts.
 * - `deliver`: the letter into the session under that id as a steer; with
 *   `resume` an idle session wakes to read it, without it the message waits
 *   for the session's next turn. Delivering an id twice puts one message in the
 *   session. A session that does not exist refuses with `gone`.
 * - `start`: the session under its minted id with the text as its first
 *   prompt, which starts a turn. Starting the same id and delivery twice makes
 *   one session with one prompt.
 * - `parentOf`: the session's parent, undefined for a root session or one
 *   that does not exist.
 * - `child`: a latch's child session under its minted id, a child of its
 *   parent, carrying its mark, and not prompted: no turn starts. Making the
 *   same id twice makes one session. A parent that does not exist refuses
 *   with `gone`.
 * - `mark`: the session's latch mark replaced, or with none cleared; the
 *   session keeps the rest of its metadata. A session that does not exist is
 *   no failure.
 */
export class Courier extends Context.Service<
  Courier,
  {
    readonly newDelivery: Effect.Effect<string>
    readonly newSession: Effect.Effect<string>
    readonly deliver: (sessionID: string, delivery: string, letter: Letter, resume: boolean) => Effect.Effect<void, DeliveryRefused>
    readonly start: (start: Start) => Effect.Effect<void, DeliveryRefused>
    readonly parentOf: (sessionID: string) => Effect.Effect<string | undefined>
    readonly child: (child: Child) => Effect.Effect<void, DeliveryRefused>
    readonly mark: (sessionID: string, mark: Mark | undefined) => Effect.Effect<void>
  }
>()("dotfiles-opencode/wake/Courier") {}

/** The opener could not be asked: none serves it yet (its plugin is still loading), or the call failed. The latch is asked again. */
export class OpenerUnavailable extends Schema.TaggedError<OpenerUnavailable>()("OpenerUnavailable", { message: Schema.String }) {}

/**
 * Whoever decides a latch again (orchestrate, over `OPENER`). `open` answers
 * what it decided: `opened` (started, or started before), `held` with the new
 * hold and times, or `failed`. An answer that does not read as `Opened` is
 * `OpenerUnavailable`, as is no answer.
 */
export class Opener extends Context.Service<Opener, { readonly open: (latch: Latch) => Effect.Effect<Opened, OpenerUnavailable> }>()(
  "dotfiles-opencode/wake/Opener",
) {}

/**
 * A monitor's check: `command` run once in `cwd`, owned by the caller, and
 * stopped past `timeoutMs` or when the caller is interrupted. It never fails;
 * a command that could not start reads as a failed check that says why. The
 * command runs in a plain `/bin/sh`, reading no shell startup files, with no
 * stdin, and its output is kept to a bounded tail.
 */
export class Checks extends Context.Service<Checks, { readonly run: (command: string, cwd: string, timeoutMs: number) => Effect.Effect<Check> }>()(
  "dotfiles-opencode/wake/Checks",
) {}

/**
 * The OS jobs that fire entries when no server runs.
 * - `register`: the job titled `job.title` on `schedule`, which reaches the
 *   entry's server, starting OpenCode when none runs; registering a title
 *   again replaces its job.
 * - `remove`: drops the job; removing none is no failure.
 * - `titles`: every wake job's title (those starting `opencode-wake-`), and none of anything else's.
 */
export class Backstop extends Context.Service<
  Backstop,
  {
    readonly register: (job: Job, schedule: Schedule) => Effect.Effect<void, BackstopRefused>
    readonly remove: (title: string) => Effect.Effect<void, BackstopRefused>
    readonly titles: Effect.Effect<ReadonlyArray<string>, BackstopRefused>
  }
>()("dotfiles-opencode/wake/Backstop") {}

/** The runner would not launch a job; `message` says why. */
export class JobRefused extends Schema.TaggedError<JobRefused>()("JobRefused", { message: Schema.String }) {}

/**
 * Where jobs run: outside the server, so a job outlives it.
 * - `launch`: start the spec's command under a runner of its own (a systemd
 *   user unit on Linux, its own session and process group elsewhere), its
 *   stdout and stderr to the log, `$JOB_DRIP` naming its progress file. The
 *   runner records the exit beside the spec. It returns at once.
 * - `read`: the job's spec and run, undefined for an id it never launched.
 *   A run whose runner is gone without an exit reads `lost`.
 * - `tail`: the last `chars` characters of the log ("" when none).
 * - `drip`: the progress written since byte `from`, whole lines only, and
 *   the offset after them; a line still being written waits.
 * - `kill`: ask the runner to stop the command (SIGTERM to its process
 *   group, SIGKILL after a grace to what is left of it); it records the exit
 *   as killed, with the signal. A command that had ended by itself before the
 *   signal reached it keeps its own exit, not killed. Whether a
 *   running job was asked; an ended or unknown one is not, and is no failure.
 */
export class Runner extends Context.Service<
  Runner,
  {
    readonly launch: (spec: JobSpec) => Effect.Effect<Launched, JobRefused>
    readonly read: (id: string) => Effect.Effect<JobRecord | undefined>
    readonly tail: (id: string, chars: number) => Effect.Effect<string>
    readonly drip: (id: string, from: number) => Effect.Effect<{ readonly text: string; readonly offset: number }>
    readonly kill: (id: string) => Effect.Effect<boolean>
  }
>()("dotfiles-opencode/wake/Runner") {}

/** Word that a session's wakes changed, so whatever shows them reads again. */
export class Changes extends Context.Service<Changes, { readonly changed: (sessionID: string) => Effect.Effect<void> }>()(
  "dotfiles-opencode/wake/Changes",
) {}
