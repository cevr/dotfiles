// Landing Rifts as one batch: an integration Rift of the warm source starts
// at origin's newest default branch, merges each Rift's branch in order (a
// conflict in lock files alone is settled by installing again; any other
// stops the batch and names the Rift and the files), writes the generated
// files again for the merged sources (a clean merge can leave them stale),
// runs the repository's gate once, pushes to the default branch, trashes the landed Rifts, then
// runs the repository's accept check once, in the background, on everything
// the batch changed, and wakes the calling session with its result; then the
// repository's own post-land work (`rift.postLand`), the same way, waking it
// with its report. The repository names its commands in its warm source's
// Git config (`rift.gate`, `rift.accept`, `rift.postLand`), so the tool knows
// no repository's checks.
// A repository that lands through pull requests sets `rift.push` false: the
// batch is merged, gated and checked the same way, nothing goes to the
// default branch, every Rift stays, and each one is answered green or red (a
// conflict reds only its Rift; a red check reds every Rift it ran on), its
// own branch pushed when green and `rift.pushBranches` is set.
// This file holds the rules and the words the model reads; model.ts runs the
// steps.
import { Schema } from "effect"

/** The Rift every batch is merged in, one per warm source, kept between batches. */
export const INTEGRATION = "integrate"

/** How a repository lands, from its warm source's Git config. */
export interface LandConfig {
  /** The default branch: `workrift.main`, else origin's HEAD. */
  readonly main: string
  /** `rift.gate`: the fast check run in the integration Rift before the push; required. */
  readonly gate: string | undefined
  /** `rift.accept`: the slow check run there after the push, in the background, with RIFT_LAND_BASE set to the batch's base. */
  readonly accept: string | undefined
  /**
   * `rift.generated` (one value per file, relative to the repository root):
   * files a command writes, whose merge conflict `rift.regenerate` settles,
   * as a lock file's is settled by installing again, and which it writes
   * again after every batch's merges.
   */
  readonly generated: ReadonlyArray<string>
  /** `rift.regenerate`: the shell line, run at the repository root after the merges and the install, that writes the generated files again. */
  readonly regenerate: string | undefined
  /**
   * `rift.push` (default true): whether a green batch is pushed to the
   * default branch and its Rifts removed. A repository that lands through
   * pull requests sets it false: the batch is gated and checked, each Rift
   * answered green or red, and every Rift kept.
   */
  readonly push: boolean
  /** `rift.pushBranches` (default false): with `rift.push` false, push each green Rift's own branch, for its pull request. */
  readonly pushBranches: boolean
  /**
   * `rift.postLand`: the repository's own work after a pushed batch (the
   * dotfiles merge upstream OpenCode into their fork), a shell line run in
   * the integration Rift in the background after the accept check, one at a
   * time with it, with RIFT_LAND_BASE, RIFT_LAND_HEAD and
   * RIFT_POST_LAND_REPORT set: what it writes to that file is the report the
   * session is woken with. Skipped while the host is loaded past its cores;
   * the next land runs it again.
   */
  readonly postLand: string | undefined
}

/** A post-land step's run: the check's run, and the report it wrote, when it wrote one. */
export interface PostLanded extends Ran {
  readonly report: string | undefined
}

/** The host's 1-minute load and its cores, read before a post-land step. */
export interface HostLoad {
  readonly load: number
  readonly cores: number
}

/** Where a batch starts: origin's newest default branch, checked out in the integration Rift. */
export interface Started {
  /** The commit the batch starts from. */
  readonly base: string
  /** The integration Rift's commit before, whose installed packages it still holds. */
  readonly previous: string
}

/** One Rift's branch merged into the integration Rift. */
export type Merged =
  | {
      readonly _tag: "Merged"
      /** The lock files and generated files whose conflict an install or `rift.regenerate` settled. */
      readonly regenerated: ReadonlyArray<string>
    }
  /** The merge stopped on these files and was aborted. */
  | { readonly _tag: "Conflict"; readonly files: ReadonlyArray<string> }

/** One run of a repository command. */
export interface Ran {
  readonly code: number
  readonly seconds: number
  /** The file holding everything it printed. */
  readonly log: string
  /** What it printed. */
  readonly output: string
}

/** A Rift to land: its directory and its branch. */
export interface Unit {
  readonly path: string
  readonly branch: string
}

/** A batch that was pushed. */
export interface Landed {
  readonly units: ReadonlyArray<Unit>
  /** The default branch it was pushed to. */
  readonly main: string
  /** The commit the batch started from. */
  readonly base: string
  /** The pushed commit, `<hash> <subject>`. */
  readonly pushed: string
  readonly gate: Ran
  /** The lock files and generated files settled or rewritten by an install or `rift.regenerate`, committed in the batch. */
  readonly locks: ReadonlyArray<string>
  /** Each landed Rift kept, with why; the others went to the trash. */
  readonly kept: ReadonlyArray<{ readonly path: string; readonly why: string }>
}

/** The repository names no gate, so the tool will not push. */
export class GateMissing extends Schema.TaggedError<GateMissing>()("GateMissing", { source: Schema.String }) {}

/** A Rift the tool will not land, before touching any. */
export class LandRefused extends Schema.TaggedError<LandRefused>()("LandRefused", {
  path: Schema.String,
  reason: Schema.String,
}) {}

/** A batch stopped at one step; nothing was pushed. `path` is the Rift whose merge stopped it, else the integration Rift. */
export class LandStopped extends Schema.TaggedError<LandStopped>()("LandStopped", {
  path: Schema.String,
  step: Schema.Literals(["start", "merge", "conflict", "install", "regenerate", "gate", "push"]),
  detail: Schema.String,
}) {}

const SUMMARY = /^ *\d+ (pass|fail)\b|\(fail\)|error TS|error:/

/** The lines of a check's output worth reading: its counts and failures, else its last lines. */
export const digest = (output: string, limit = 12): string => {
  const lines = output.split("\n").map((line) => line.trimEnd())
  const hits = lines.filter((line) => SUMMARY.test(line)).slice(0, limit)
  const shown = hits.length > 0 ? hits : lines.filter((line) => line !== "").slice(-limit)
  return shown.map((line) => `  ${line}`).join("\n")
}

const branches = (units: ReadonlyArray<Unit>): string => units.map((unit) => unit.branch).join(", ")

/** The answer to a land that pushed. */
export const landedText = (landed: Landed, integration: string, accepting: boolean, postLand = false): string => {
  const removed = landed.units.filter((unit) => !landed.kept.some((kept) => kept.path === unit.path))
  return [
    `Landed ${landed.units.length} Rift(s) as one push: ${landed.pushed} to ${landed.main} (merged ${branches(landed.units)}; the gate passed in ${landed.gate.seconds}s).`,
    ...(landed.locks.length > 0 ? [`Installed or regenerated and committed: ${landed.locks.join(", ")}.`] : []),
    ...(removed.length > 0 ? [`To the trash: ${removed.map((unit) => unit.path).join(", ")}.`] : []),
    ...landed.kept.map((kept) => `Kept ${kept.path}: ${kept.why}`),
    accepting
      ? `The accept check runs in the background in ${integration} on the batch since ${landed.base.slice(0, 9)}; this session is woken with its result.`
      : "No rift.accept is configured, so no check runs after the push.",
    ...(postLand
      ? [`Then the repository's post-land step (rift.postLand) runs there in the background${accepting ? ", after the accept check" : ""}; this session is woken with its report, and the next land waits for it.`]
      : []),
  ].join("\n")
}

/** The wake a post-land step sends: its report (else its output's last lines), and how it ended. */
export const postLandedText = (units: ReadonlyArray<Unit>, ran: PostLanded): string =>
  [
    ran.code === 0
      ? `rift land: the post-land step after ${branches(units)} ran in ${ran.seconds}s. Log: ${ran.log}`
      : `rift land: the post-land step after ${branches(units)} FAILED (exit ${ran.code}) in ${ran.seconds}s. The batch is already pushed. Log: ${ran.log}`,
    ran.report !== undefined && ran.report.trim() !== "" ? ran.report.trimEnd() : digest(ran.output, 20),
  ].join("\n")

/** The wake a post-land step skipped under load sends. */
export const postLandSkippedText = (units: ReadonlyArray<Unit>, load: HostLoad): string =>
  `rift land: the post-land step after ${branches(units)} was skipped: the 1-minute load is ${load.load.toFixed(1)}, at or past the host's ${load.cores} cores. The next land runs it again.`

/** The wake a background accept check sends. */
export const acceptedText = (units: ReadonlyArray<Unit>, accept: Ran): string =>
  accept.code === 0
    ? `rift land: the accept check for ${branches(units)} passed in ${accept.seconds}s.`
    : [
        `rift land: the accept check for ${branches(units)} FAILED (exit ${accept.code}) in ${accept.seconds}s. The batch is already pushed: fix forward. Log: ${accept.log}`,
        digest(accept.output, 20),
      ].join("\n")

/** One Rift's result in a batch that is checked, not pushed (`rift.push` false). */
export interface Outcome {
  readonly unit: Unit
  readonly verdict: "green" | "red" | "pending"
  /** Why it is red, or what became of its branch. */
  readonly note?: string
}

const outcomeLines = (outcomes: ReadonlyArray<Outcome>): ReadonlyArray<string> =>
  outcomes.map((outcome) => `- ${outcome.unit.branch} (${outcome.unit.path}): ${outcome.verdict}${outcome.note === undefined ? "" : `; ${outcome.note}`}`)

/** A batch checked without a push. */
export interface Checked {
  readonly units: ReadonlyArray<Unit>
  readonly main: string
  readonly base: string
  readonly integration: string
  /** The gate's run; absent when no Rift merged. */
  readonly gate: Ran | undefined
  readonly locks: ReadonlyArray<string>
  readonly outcomes: ReadonlyArray<Outcome>
  /** The accept check runs in the background and wakes the session with the final outcomes. */
  readonly accepting: boolean
  readonly pushBranches: boolean
}

/** The answer to a land with `rift.push` false. */
export const checkedText = (checked: Checked): string => {
  const gate = checked.gate
  return [
    `Checked ${checked.units.length} Rift(s) as one batch in ${checked.integration} on ${checked.main} since ${checked.base.slice(0, 9)}; rift.push is false, so ${checked.main} was not pushed and every Rift stays.`,
    ...(checked.locks.length > 0 ? [`Installed or regenerated and committed in the integration Rift: ${checked.locks.join(", ")}.`] : []),
    gate === undefined
      ? "The gate did not run: no Rift merged."
      : gate.code === 0
        ? `The gate passed in ${gate.seconds}s.`
        : [
            `The gate FAILED (exit ${gate.code}) in ${gate.seconds}s; log: ${gate.log}. Route each failure to the Rift whose diff it touches.`,
            digest(gate.output),
          ].join("\n"),
    ...outcomeLines(checked.outcomes),
    ...(checked.accepting
      ? [
          `The accept check runs in the background in ${checked.integration}; this session is woken with each Rift's result${checked.pushBranches ? ", and a green Rift's branch is pushed then" : ""}.`,
        ]
      : []),
  ].join("\n")
}

/** The wake a background accept check sends for a batch checked without a push. */
export const checkAcceptedText = (main: string, ran: ReadonlyArray<Unit>, accept: Ran, outcomes: ReadonlyArray<Outcome>): string =>
  [
    accept.code === 0
      ? `rift land: the accept check for ${branches(ran)} passed in ${accept.seconds}s; ${main} was not pushed.`
      : [
          `rift land: the accept check for ${branches(ran)} FAILED (exit ${accept.code}) in ${accept.seconds}s; ${main} was not pushed. Route each failure to the Rift whose diff it touches. Log: ${accept.log}`,
          digest(accept.output, 20),
        ].join("\n"),
    ...outcomeLines(outcomes),
  ].join("\n")

/** What the model reads when a land does not push. */
export const explainLand = (failure: GateMissing | LandRefused | LandStopped): string => {
  switch (failure._tag) {
    case "GateMissing":
      return `The repository of ${failure.source} names no gate, so land will not push. Set it in the warm source's Git config: git -C ${failure.source} config rift.gate '<fast check>' (and rift.accept '<slow check, given $RIFT_LAND_BASE>' for the background check).`
    case "LandRefused":
      return `Did not land anything: ${failure.path} ${failure.reason}`
    case "LandStopped":
      switch (failure.step) {
        case "conflict":
          return `Merging ${failure.path} conflicts with the batch; nothing was pushed and the merge was aborted. Merge the default branch into it, resolve these, commit, and land again:\n${failure.detail}`
        case "gate":
          return `The gate failed on the batch in ${failure.path}; nothing was pushed.\n${failure.detail}`
        case "push":
          return `The push from ${failure.path} failed: ${failure.detail}`
        default:
          return `The ${failure.step} step failed in ${failure.path}; nothing was pushed: ${failure.detail}`
      }
  }
}
