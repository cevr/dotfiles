// The digest's health line, as `GET /health` answers it and the installer's health step logs it:
//
//   digest ok <build> host=<h> events=<n> last=<iso> peers=<up>/<named>|none tailnet=yes|partial|held|no:<why>
//
// - `build`: the installed build the plugin runs from (its tree's name), `dev` from a checkout.
// - `events`: the log's lines that read; `last` the newest one's time, `none` for an empty log.
// - `peers`: `<up>/<named>`, how many of the peers the config names answered at their last read (peers.ts); `none`
//   when it names none.
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
//   hosts), then `excluded=<n>[:unmatched:<name>][:store-<copy 1>/<copy 2>|:store-copies-differ]`: how many of his
//   devices `digest.excludedDevices` keeps out, each exclusion whose stable IDs no device of his has (a device gone),
//   and the device store's condition when its two copies are not both read and equal (devices.ts). An exclusion the
//   store does not key shows in the switch instead, `writes=paired:unkeyed:<name>:store-...`. A paired browser on
//   the tailnet reads the line without them.
import { DateTime, Option } from "effect"

/** What the tailnet listener is doing, as health reports it. */
export type TailnetState = "yes" | "partial" | "held" | `no:${string}`

/** The health line's facts. */
export interface HealthFacts {
  readonly build: string
  readonly host: string
  readonly events: number
  readonly last: Option.Option<number>
  /** How many named peers are up, of how many are named. */
  readonly peers: { readonly up: number; readonly named: number }
  readonly tailnet: TailnetState
}

/** What an unpaired request on the tailnet reads. */
export const BRIEF = "ok"

/** The line for a digest that reads. */
export const healthLine = (facts: HealthFacts): string => {
  const last = Option.match(facts.last, { onNone: () => "none", onSome: (t) => DateTime.formatIso(DateTime.makeUnsafe(t)) })
  const peers = Option.getOrElse(Option.map(Option.liftPredicate(facts.peers, (each) => each.named > 0), (each) => `${each.up}/${each.named}`), () => "none")
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
