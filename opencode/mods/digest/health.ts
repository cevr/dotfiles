// The digest's health line, as `GET /health` answers it and the installer's health step logs it:
//
//   digest ok <build> host=<h> events=<n> last=<iso> peers=<name>:<age>,… tailnet=yes|partial|held|no:<why>
//
// - `build`: the installed build the plugin runs from (its tree's name), `dev` from a checkout.
// - `events`: the log's lines that read; `last` the newest one's time, `none` for an empty log.
// - `peers`: none until the peers unit.
// - `tailnet`:
//   - `yes`: this instance serves every tailnet address the host has;
//   - `partial`: it serves some, and another server instance holds the others' port (a restart's handover);
//   - `held`: another server instance holds them all;
//   - `no:<why>`: the host has no tailnet address, so the page is on loopback only. `why` is `no-cli`,
//     `cli-failed`, `cli-timeout`, `unparseable`, `not-running:<state>`, `no-address` (Tailscale names none on an
//     interface), `probe-failed`, or `starting` before the first read.
// - A log that cannot be read is `digest sick <build> host=<h> <why>`. The installer warns on it and never rolls a
//   build back for it.
// - On the tailnet an unpaired request reads `ok` alone (BRIEF): no counts, no names.
// - On loopback alone the line ends with `writes=<switch>[:<why closed>] members=<n> writers=<n>` (localPart): the
//   write switch in force (`digest.tailnetWrite`, "paired" with the reason when it closed, members.ts), how many of
//   his own other devices Tailscale's status names, and how many of those write as him with no token now (not agent
//   hosts), then `excluded=<n>[:unmatched:<name>|:unkeyed:<name>]`: how many of his devices `digest.excludedDevices`
//   keeps out, and each exclusion whose stable ID no device of his has (or that has none), since a missed exclusion
//   fails open. A paired browser on the tailnet reads the line without them.
import { Array as Arr, DateTime, Option } from "effect"

/** What the tailnet listener is doing, as health reports it. */
export type TailnetState = "yes" | "partial" | "held" | `no:${string}`

/** The health line's facts. */
export interface HealthFacts {
  readonly build: string
  readonly host: string
  readonly events: number
  readonly last: Option.Option<number>
  /** Each peer and how long since it was heard from, in seconds; none before the peers unit. */
  readonly peers: ReadonlyArray<{ readonly name: string; readonly age: number }>
  readonly tailnet: TailnetState
}

/** What an unpaired request on the tailnet reads. */
export const BRIEF = "ok"

/** The line for a digest that reads. */
export const healthLine = (facts: HealthFacts): string => {
  const last = Option.match(facts.last, { onNone: () => "none", onSome: (t) => DateTime.formatIso(DateTime.makeUnsafe(t)) })
  const peers = Arr.match(facts.peers, { onEmpty: () => "none", onNonEmpty: (all) => all.map((peer) => `${peer.name}:${peer.age}s`).join(",") })
  return `digest ok ${facts.build} host=${facts.host} events=${facts.events} last=${last} peers=${peers} tailnet=${facts.tailnet}`
}

/**
 * What the line adds on loopback: the write switch in force, how many of his own other devices there are, and how
 * many of those may mark and answer as him with no token (no agent host), so he can see a device he did not name.
 */
export const localPart = (writes: string, devices: number, writers: number, excluded: string): string => `writes=${writes} members=${devices} writers=${writers} excluded=${excluded}`

/** The line for a digest whose log does not read. */
export const sickLine = (build: string, host: string, why: string): string => `digest sick ${build} host=${host} ${why.replace(/\s+/g, " ").slice(0, 300)}`

/** Whether a health line says the digest is well. */
export const isWell = (line: string): boolean => line.startsWith("digest ok ")

/**
 * The installed build a plugin file runs from: the name of the `<build>.plugins` folder in its path, without
 * `opencode-` and `.plugins`; `dev` for a file outside a build's tree (a checkout).
 */
export const buildOf = (path: string): string =>
  Option.getOrElse(
    Option.map(Option.fromNullishOr(/\/opencode-([^/]+)\.plugins\//.exec(path)), (match) => match[1] ?? "dev"),
    () => "dev",
  )
