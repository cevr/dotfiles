// A repository's default branch as the watcher follows it: the
// DefaultBranch aggregate. Each read of the branch's head and its checks is
// Observe; the branch TurnedRed when its checks fail and it was not red
// already, TurnedGreen when they pass again, and is Seen otherwise. It stays
// red through the pending reads of later commits, so one red spell is one
// notice. The notice goes to the sessions that used the `pr` tool on the
// repository lately (`recipients`).
import { Effect, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { type Check, groups, RepoName, short, verdict } from "./report.ts"

/** A read of the default branch: its name, head commit and the checks at it. */
export interface BranchRead {
  readonly name: string
  readonly head: string
  readonly checks: ReadonlyArray<Check>
}

export const BranchState = Schema.Struct({
  head: Schema.String,
  verdict: Schema.Literals(["none", "pass", "fail", "pending"]),
  /** Red from a failing read until a passing one. */
  red: Schema.Boolean,
})
export type BranchState = typeof BranchState.Type

export const TurnedRed = Schema.TaggedStruct("TurnedRed", { state: BranchState, failing: Schema.Array(Schema.String) })
export interface TurnedRed extends Schema.Schema.Type<typeof TurnedRed> {}
export const TurnedGreen = Schema.TaggedStruct("TurnedGreen", { state: BranchState })
export interface TurnedGreen extends Schema.Schema.Type<typeof TurnedGreen> {}
export const BranchSeen = Schema.TaggedStruct("BranchSeen", { state: BranchState })
export interface BranchSeen extends Schema.Schema.Type<typeof BranchSeen> {}
export type BranchEvent = TurnedRed | TurnedGreen | BranchSeen

export interface ObserveBranch {
  readonly _tag: "ObserveBranch"
  readonly read: BranchRead
}

export const DefaultBranch: Decider<BranchState | undefined, ObserveBranch, BranchEvent> = {
  initial: undefined,
  decide: (state, command) => {
    const now = verdict(command.read.checks)
    const wasRed = state?.red ?? false
    const next: BranchState = { head: command.read.head, verdict: now, red: now === "fail" ? true : now === "pass" ? false : wasRed }
    if (now === "fail" && !wasRed) return Effect.succeed([TurnedRed.make({ state: next, failing: groups(command.read.checks).fail.map((check) => check.name) })])
    if (now === "pass" && wasRed) return Effect.succeed([TurnedGreen.make({ state: next })])
    if (state !== undefined && state.head === next.head && state.verdict === next.verdict && state.red === next.red) return Effect.succeed([])
    return Effect.succeed([BranchSeen.make({ state: next })])
  },
  evolve: (_state, event) => event.state,
}

/** A repository the watcher follows: its default branch and who used the `pr` tool on it, when. */
export const RepoRecord = Schema.Struct({
  repo: RepoName,
  /** Root session id → when it last used the `pr` tool on this repository, epoch ms. */
  users: Schema.Record(Schema.String, Schema.Number),
  branch: Schema.optionalKey(BranchState),
})
export type RepoRecord = typeof RepoRecord.Type

/** How long a use of the `pr` tool keeps a session hearing of the default branch. */
export const RECIPIENT_MS = 24 * 60 * 60_000
/** How long the watcher follows a repository's default branch after the tool was last used on it. */
export const FOLLOW_MS = 7 * 24 * 60 * 60_000

/** The repository with `sessionID`'s use at `now`. */
export const used = (record: RepoRecord, sessionID: string, now: number): RepoRecord => ({ ...record, users: { ...record.users, [sessionID]: now } })

/** The sessions that used the tool on the repository within RECIPIENT_MS of `now`. */
export const recipients = (record: RepoRecord, now: number): ReadonlyArray<string> =>
  Object.entries(record.users)
    .filter(([, at]) => now - at <= RECIPIENT_MS)
    .map(([sessionID]) => sessionID)

/** Whether the watcher still follows the repository's default branch at `now`: always when configured, else within FOLLOW_MS of a use. */
export const followed = (record: RepoRecord, now: number, configured: boolean): boolean =>
  configured || Object.values(record.users).some((at) => now - at <= FOLLOW_MS)

/** The uses older than FOLLOW_MS go. */
export const pruned = (record: RepoRecord, now: number): RepoRecord => ({
  ...record,
  users: Object.fromEntries(Object.entries(record.users).filter(([, at]) => now - at <= FOLLOW_MS)),
})

/** The notice a turn of the default branch sends. */
export const branchNotice = (repo: string, read: BranchRead, event: TurnedRed | TurnedGreen, detail?: string): { readonly title: string; readonly text: string } => {
  if (event._tag === "TurnedGreen")
    return {
      title: `${repo} ${read.name} is green again`,
      text: `Default branch · ${repo} ${read.name} is green again at ${short(read.head)}.`,
    }
  const failing = groups(read.checks).fail
  return {
    title: `${repo} ${read.name} turned red`,
    text: [
      `Default branch · ${repo} ${read.name} turned red at ${short(read.head)}: ${event.failing.join(", ")}`,
      ...failing.flatMap((check) => (check.url === undefined ? [] : [`  ${check.name}: ${check.url}`])),
      ...(detail === undefined ? [] : ["", detail]),
      "",
      "A red default branch fails every branch built on it; say whether your work caused it before you merge.",
    ].join("\n"),
  }
}
