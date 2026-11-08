// A run's skill drift: the orchestrate skill moved on after a run started.
// Each run dir records the skill version the run last saw (`SEEN_FILE`): the
// newest commit that touched the skill in the dotfiles checkout it is
// installed from. When a root that owns the run goes idle and the installed
// skill is newer than that, the root is told once, in one message: the commit
// subjects since its version, the "Departs from" lines in the run's own rules
// files, and to reconcile those files with the skill (`noteOf`). The run then
// records the new version, so each version reaches each run once.
//
// A run seen for the first time records the version silently: that is the
// version it started on. An older installed skill (a checkout moved back)
// says nothing and records nothing.

/** The file in a run dir that holds the skill version the run last saw. */
export const SEEN_FILE = "skill-version"

/** The words that open a run's departure from a skill default: `Departs from <rule>: <why>`. */
export const DEPARTS = "Departs from"

/** The metadata key the note carries, so its arrival reads as the note it is. */
export const DRIFT_MARK = "dotfiles-opencode.orchestrate.skill"

/** How the installed version stands to the one a run saw: what changed between them. */
export type Relation =
  /** The installed version descends from the seen one; `subjects` are the commits between, newest first. */
  | { readonly _tag: "Newer"; readonly subjects: ReadonlyArray<string> }
  | { readonly _tag: "Same" }
  /** The seen version descends from the installed one: the checkout moved back. */
  | { readonly _tag: "Older" }
  /** The seen version is not in the checkout's history; `subjects` are the newest commits to the skill. */
  | { readonly _tag: "Unrelated"; readonly subjects: ReadonlyArray<string> }

/** What a run's idle check does: record the version silently, tell the root and record it, or nothing. */
export type Step = { readonly _tag: "Record" } | { readonly _tag: "Tell"; readonly subjects: ReadonlyArray<string>; readonly unrelated: boolean } | { readonly _tag: "Stay" }

/**
 * The step for a run that saw `seen` (none: never seen) now that `installed`
 * is installed, given how the two relate (asked only when they differ).
 */
export const stepOf = (seen: string | undefined, installed: string, relation: Relation | undefined): Step => {
  if (seen === undefined) return { _tag: "Record" }
  if (seen === installed || relation === undefined) return { _tag: "Stay" }
  switch (relation._tag) {
    case "Same":
    case "Older":
      return { _tag: "Stay" }
    case "Newer":
      return { _tag: "Tell", subjects: relation.subjects, unrelated: false }
    case "Unrelated":
      return { _tag: "Tell", subjects: relation.subjects, unrelated: true }
  }
}

/** One run's drift, as the note names it. */
export interface Drift {
  readonly run: string
  readonly seen: string
  readonly installed: string
  readonly subjects: ReadonlyArray<string>
  /** The seen version is not in the checkout's history: the subjects are the newest ones. */
  readonly unrelated: boolean
  /** The run's departure lines, `<file>:<line>: <text>`. */
  readonly departures: ReadonlyArray<string>
}

/** At most this many subjects or departures are listed per run; the rest are counted. */
export const LISTED = 12

/** A departure or subject line is cut to this many characters. */
export const WIDTH = 240

const short = (hash: string) => hash.slice(0, 7)
const cut = (line: string) => (line.length > WIDTH ? `${line.slice(0, WIDTH - 1)}…` : line)
const listed = (lines: ReadonlyArray<string>) => [
  ...lines.slice(0, LISTED).map((line) => `- ${cut(line)}`),
  ...(lines.length > LISTED ? [`- and ${lines.length - LISTED} more`] : []),
]

/** What the reconcile asks, the same for every run. */
export const RECONCILE =
  "Reconcile the run's rules files (common.md and the like) with the skill now: delete what the skill now covers, keep project facts (commands, paths, flags, thread shares), and write each remaining departure from a skill default as `Departs from <rule>: <why>`; a departure is offered upstream as a skill change at close. A worker hears of a change only at its next round boundary, in one message. This note comes once per skill version."

/** The one note the root gets for its drifted runs. */
export const noteOf = (drifts: ReadonlyArray<Drift>): string =>
  [
    ...drifts.flatMap((drift) => [
      drift.unrelated
        ? `The orchestrate skill changed since run ${drift.run} saw it (${short(drift.seen)}, not in this checkout's history; now ${short(drift.installed)}). Its newest changes:`
        : `The orchestrate skill changed since run ${drift.run} saw it (${short(drift.seen)}..${short(drift.installed)}, ${drift.subjects.length} commit${drift.subjects.length === 1 ? "" : "s"}):`,
      ...listed(drift.subjects),
      ...(drift.departures.length === 0
        ? [`Run ${drift.run}'s rules files mark no departure ("${DEPARTS} <rule>: <why>"); any rule in them that differs from the skill is drift.`]
        : [`Run ${drift.run}'s departures, to check against these changes:`, ...listed(drift.departures)]),
    ]),
    RECONCILE,
  ].join("\n")

/** The note's one-line description, the TUI's notice row. */
export const descriptionOf = (drifts: ReadonlyArray<Drift>): string =>
  `orchestrate skill changed since ${drifts.map((drift) => drift.run).join(", ")} saw it: reconcile the run's rules files`

/** The departure lines of one file's text: each line that holds `DEPARTS`, as `<file>:<line>: <text>`. */
export const departuresOf = (file: string, text: string): ReadonlyArray<string> =>
  text.split("\n").flatMap((line, index) => (line.includes(DEPARTS) ? [`${file}:${index + 1}: ${line.trim()}`] : []))
