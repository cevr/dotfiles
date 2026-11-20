// The run's facts for the digest, as the orchestrate plugin sees them happen: a run's record and a unit's lane when the
// root lanes it; a step's start; a planner's or implementor's hand-back, and a verifier's verdict with its findings'
// rows, each with the `Digest:` line it carried; a land; a land's failed check, from the work plugin's notice. Pure:
// the plugin (cmd/orchestrate/digest.ts) reads the clock, the host and the findings file, and appends each line.
import { Array as Arr, Option } from "effect"
import { DigestEvent, digestLineOf, type UnitVerdict, VERSION } from "@dotfiles/opencode-digest/event"
import type { Lane } from "./tools.ts"
import { isStep } from "./described.ts"
import { handBackOf } from "./unit-log.ts"

/** Where a run is: its host, its repository's name and, when the run tables know it, its run dir. */
export interface Place {
  readonly host: string
  readonly repo: string
  readonly runDir: Option.Option<string>
}

const baseName = (path: string): string => Option.getOrElse(Arr.last(path.replace(/\/+$/, "").split("/")), () => path)

/** A lane answered or made: the run's record (the newest wins, so each lane restates it) and the unit's lane. */
export const laneFacts = (root: string, unit: string, lane: Lane, place: Place, t: number): ReadonlyArray<DigestEvent> => [
  DigestEvent.cases.Run.make({ v: VERSION, t, root, host: place.host, repo: place.repo, dir: place.runDir, name: Option.map(place.runDir, baseName) }),
  DigestEvent.cases.Lane.make({
    v: VERSION,
    t,
    root,
    unit,
    purpose: Option.fromUndefinedOr(lane.purpose),
    branch: Option.fromUndefinedOr(lane.branch),
    path: Option.some(lane.path),
  }),
]

/** A step's call description: `<role> <unit> r<N>`. */
const STEP = /^(planner|implementor|verifier) ([a-z0-9][a-z0-9._-]*) r(\d+)\b/

/** A role's start, from its call's description; none for a call that is not a step's. */
export const startFact = (root: string, session: string, agent: string, description: string, t: number): Option.Option<DigestEvent> =>
  Option.flatMap(Option.fromNullishOr(STEP.exec(description.trim())), ([, role = "", unit = "", round = "0"]) =>
    Option.liftPredicate(DigestEvent.cases.Start.make({ v: VERSION, t, root, session, role, unit, round: Number(round) }), () => isStep(agent) && role === agent),
  )

/** The round a hand-back line names: `r<N>` after its unit. */
const roundOf = (words: string): number =>
  Option.getOrElse(Option.map(Option.fromNullishOr(/^[`*\s]*\w+ [a-z0-9][a-z0-9._-]* r(\d+)/i.exec(words.trimStart())), ([, round = "0"]) => Number(round)), () => 0)

/** A findings file's verdict table, one row per unit: `| <unit> (…) | r<N> or <N> | <verdict> … |`. */
export const findingsRowsOf = (findings: string): ReadonlyArray<UnitVerdict> =>
  findings.split("\n").flatMap((line) =>
    Option.toArray(
      Option.map(Option.fromNullishOr(/^\|\s*`?([a-z0-9][a-z0-9._-]*)`?[^|]*\|\s*r?(\d+)\s*\|\s*[*_`]*(accepted|changes|stuck)\b/i.exec(line)), ([, unit = "", round = "0", verdict = ""]) => ({
        unit,
        round: Number(round),
        verdict: verdict.toLowerCase(),
      })),
    ),
  )

/**
 * A step's hand-back, from its last words: a planner's or implementor's, or a verifier's verdict with the rows of the
 * findings it names (`findings`, its text when read). None for words that open with no hand-back line of its role.
 */
export const handBackFact = (root: string, session: string, agent: string, words: string, findings: Option.Option<string>, t: number): Option.Option<DigestEvent> =>
  Option.map(Option.fromUndefinedOr(handBackOf(agent, words)), (said) => {
    const common = { v: VERSION, t, root, session, round: roundOf(words), verdict: said.verdict, file: Option.fromUndefinedOr(said.file), digest: digestLineOf(words) }
    if (agent !== "verifier") return DigestEvent.cases.HandBack.make({ ...common, role: agent, unit: said.unit })
    return DigestEvent.cases.Verdict.make({ ...common, batch: said.unit, units: Option.getOrElse(Option.map(findings, findingsRowsOf), () => []) })
  })

/** The file a verifier's hand-back names, to read for its rows. */
export const findingsPathOf = (agent: string, words: string): Option.Option<string> =>
  Option.flatMap(
    Option.filter(Option.fromUndefinedOr(handBackOf(agent, words)), () => agent === "verifier"),
    (said) => Option.fromUndefinedOr(said.file),
  )

/** A land that pushed. */
export const landFact = (root: string, units: ReadonlyArray<string>, pushed: string, t: number): DigestEvent =>
  DigestEvent.cases.Land.make({ v: VERSION, t, root, units, pushed: Option.some(pushed) })

/** The work plugin's land notice, as a check: its accept check passed or failed, or a post-land step failed; none for any other notice. */
export const checkFact = (root: string, text: string, t: number): Option.Option<DigestEvent> => {
  const line = Option.getOrElse(Arr.head(text.split("\n")), () => "")
  const accept = Option.map(Option.fromNullishOr(/the accept check for .* (passed|FAILED)\b/.exec(line)), ([, outcome]) => outcome === "passed")
  const ok = Option.orElse(accept, () => Option.map(Option.fromNullishOr(/\bFAILED\b/.exec(line)), () => false))
  return Option.map(ok, (passed) => DigestEvent.cases.Check.make({ v: VERSION, t, root, ok: passed, text: line.replace(/^(?:rift|lane) land: /, "") }))
}
