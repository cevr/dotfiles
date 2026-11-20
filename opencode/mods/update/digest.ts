// The install's fact for the digest: one line when a handoff ends, its outcome (proven, rolled back, given up) on
// this host, for the build it handed off to (the handoff's reason: the batch or unit it installs).
import { Option } from "effect"
import { DigestEvent, VERSION } from "@dotfiles/opencode-digest/event"
import type { Outcome } from "./model.ts"

/** The digest line of a handoff that ended `outcome` on `host`, installing `repo` for `reason`, at `t`. */
export const installOf = (host: string, outcome: Outcome, reason: string, repo: string, t: number): DigestEvent =>
  DigestEvent.cases.Install.make({
    v: VERSION,
    t,
    host,
    outcome,
    build: Option.liftPredicate(reason.trim(), (said) => said !== ""),
    said: Option.none(),
    repo: Option.some(repo),
  })
