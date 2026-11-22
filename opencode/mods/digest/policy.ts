// Who may do what on the digest page: one pure decision over (listener, route, source, paired, origin, host),
// `decide`. The listener asks it for every request and acts on its answer alone.
//
// - Host: a request must name one of the listener's own hosts (`hosts`: its addresses and names, with the port).
//   Any other `Host` is refused on every route (DNS rebinding: a name rebound to the address reads nothing).
// - Source: on the tailnet listener, who sent it, from the socket's peer address alone, never a header (members.ts
//   `sourceOf`). A source outside Tailscale's ranges is refused on every route there (the bind makes it impossible;
//   the decision refuses it anyway).
// - A write (a POST) must come from the page's own origin, `http://<the Host it named>`, carry PAGE_HEADER and be
//   JSON. Each of the listener's names is its own origin, and the browser keeps a token per origin, so a page opened
//   by its IP and later by its MagicDNS name pairs once for each. With writes open to his devices (no token), these
//   are what stop a page of another site, opened in his browser, from writing through it.
// - The one exception (peers.ts, the write half): on the tailnet listener a mark or an answer may also come from a
//   named peer's page, its origin exactly one of `peerOrigins` (the keyed device's addresses and names on the
//   page's port, from this host's own status and device store). Such a write is tokenless by construction: its token
//   header, if any, is never read (the preflight never allows it either), so it is served only where this host's
//   policy serves the same request from its own page, tokenless, from that source. Nothing else is ever allowed
//   cross-origin: no read, no pairing, nothing on loopback (`isPeerWrite`, `preflightOf`).
// - What a route needs then (ACCESS):
//   - On loopback, a read or a mark needs nothing more, an answer a paired browser.
//   - Off loopback (the tailnet) every route needs a paired browser except the page's shell (its static bundle,
//     which holds no data), whether this browser is paired, the pairing itself, and `/health`, which answers only
//     `ok` there unless paired.
//   - `digest.tailnetRead: "member"` opens the tailnet's reads to his own devices: those of this host's Tailscale
//     user (`own`), this host and the agent hosts (`agent`) included. The default is "paired".
//   - `digest.tailnetWrite` opens the marks and answers: "member" to his own devices, agent hosts included;
//     "member-except-hosts" to his own devices except the agent hosts and this host, which still need the token
//     (an agent there must not act as him). The default is "paired".
//   - Another user's device, a shared-in or tagged one, or an address the status does not name (`other`) always
//     needs the token.
import { Data, Match } from "effect"

/** The listener a request came in on. */
export type Listener = "loopback" | "tailnet"

/**
 * A route's kind:
 * - `shell`: the page and its assets, no data;
 * - `status`: whether this browser is paired;
 * - `health`: the health line;
 * - `read`: the view, its data;
 * - `mark`: read, Later, a name;
 * - `answer`;
 * - `pair`: a code for a token.
 */
export type RouteKind = "shell" | "status" | "health" | "read" | "mark" | "answer" | "pair"

export const ROUTE_KINDS: ReadonlyArray<RouteKind> = ["shell", "status", "health", "read", "mark", "answer", "pair"]

/** The kinds that change state: each a JSON POST from the page's own origin. */
export const WRITES: ReadonlyArray<RouteKind> = ["mark", "answer", "pair"]

/** `digest.tailnetRead`: who reads the page on the tailnet. */
export type TailnetRead = "paired" | "member"

/** `digest.tailnetWrite`: who marks and answers on the tailnet without a token. */
export type TailnetWrite = "paired" | "member" | "member-except-hosts"

export const TAILNET_WRITES: ReadonlyArray<TailnetWrite> = ["paired", "member", "member-except-hosts"]

/** The two switches, as in force now (members.ts closes `tailnetWrite` to "paired" when it cannot tell the hosts). */
export interface Policy {
  readonly tailnetRead: TailnetRead
  readonly tailnetWrite: TailnetWrite
}

/** Every switch at its default: pairing for everything on the tailnet. */
export const PAIRED: Policy = { tailnetRead: "paired", tailnetWrite: "paired" }

/**
 * Who sent a request, by its socket's peer address:
 * - `local`: it came in on the loopback listener;
 * - `agent`: one of HIS devices that runs agents: this host, or one `digest.agentHosts` names (members.ts). It is
 *   `own` with less: it may read like `own`, but never writes more, so naming an agent host only restricts;
 * - `own`: another device of this host's Tailscale user;
 * - `other`: any other tailnet address (another user's device, a shared-in or tagged one, one the status lacks);
 * - `outside`: not in Tailscale's ranges.
 */
export type Source = "local" | "agent" | "own" | "other" | "outside"

export const SOURCES: ReadonlyArray<Source> = ["local", "agent", "own", "other", "outside"]

/** What a route needs: nothing more, a paired browser, or (health) a paired browser for more than `ok`. */
export type Need = "open" | "paired" | "brief"

/** What each route needs on each listener, with every switch at its default. */
export const ACCESS: Readonly<Record<Listener, Readonly<Record<RouteKind, Need>>>> = {
  loopback: { shell: "open", status: "open", health: "open", read: "open", mark: "open", answer: "paired", pair: "open" },
  tailnet: { shell: "open", status: "open", health: "brief", read: "paired", mark: "paired", answer: "paired", pair: "open" },
}

/** His own devices: this host's Tailscale user's, this host and the agent hosts included. */
const MEMBERS: ReadonlyArray<Source> = ["own", "agent"]

const isMember = (source: Source) => MEMBERS.includes(source)
const isMarkOrAnswer = (kind: RouteKind) => kind === "mark" || kind === "answer"

/** What `kind` needs on `listener` from `source`, given the switches. */
export const needOf = (listener: Listener, kind: RouteKind, policy: Policy = PAIRED, source: Source = "other"): Need =>
  Match.value({ listener, kind, policy, source }).pipe(
    Match.when({ listener: "tailnet", kind: "read", policy: { tailnetRead: "member" }, source: isMember }, (): Need => "open"),
    Match.when({ listener: "tailnet", kind: isMarkOrAnswer, policy: { tailnetWrite: "member" }, source: isMember }, (): Need => "open"),
    Match.when({ listener: "tailnet", kind: isMarkOrAnswer, policy: { tailnetWrite: "member-except-hosts" }, source: "own" }, (): Need => "open"),
    Match.orElse(() => ACCESS[listener][kind]),
  )

/** What one request is, as the decision reads it. */
export interface Facts {
  readonly listener: Listener
  readonly kind: RouteKind
  /** Who sent it, by its socket's peer address; `local` on loopback. */
  readonly source: Source
  /** The `Host` it named; "" for none. */
  readonly host: string
  /** The listener's own hosts, each with its port. */
  readonly hosts: ReadonlyArray<string>
  /** Its `Origin`; "" for none. */
  readonly origin: string
  readonly pageHeader: boolean
  readonly json: boolean
  /** Whether it carries a paired browser's token. */
  readonly paired: boolean
}

/** What the listener does with a request: serve it, serve the health line's `ok` alone, or refuse it, and why. */
export type Decision = Data.TaggedEnum<{
  Serve: {}
  Brief: {}
  Refuse: { readonly status: number; readonly reason: string }
}>
export const Decision = Data.taggedEnum<Decision>()

/** The pairing instruction an unpaired browser is given. */
export const PAIR_FIRST = "pair this browser first: run bun cmd/digest/pair.ts on the host and type the code it prints here"
/** What a peer's page is told when this host needs a token for its write: pair on this host's own page, and act there. */
export const PAIR_ON_HOST = "this host needs this browser paired: open its own page, pair there, and act on it there"

/** The kinds a named peer's page may send here cross-origin: the marks and the answers, never a read or a pairing. */
export const PEER_WRITES: ReadonlyArray<RouteKind> = ["mark", "answer"]
/** The request headers a peer's page may send cross-origin: the page's header and JSON's type, never the token's. */
export const PEER_HEADERS: ReadonlyArray<string> = ["content-type", "x-digest-page"]

/** Whether the tailnet listener on `hosts` and `source` would answer at all: its own Host, a tailnet source. */
const reachable = (listener: Listener, host: string, hosts: ReadonlyArray<string>, source: Source): boolean =>
  hosts.includes(host) && !(listener === "tailnet" && (source === "outside" || source === "local"))

/**
 * Whether a request is a named peer's page writing here: the tailnet listener, a mark or an answer, and an Origin
 * that is not this page's own but exactly one of `peerOrigins`. Exact string equality: never a pattern, never the
 * Origin reflected for its own sake.
 */
export const isPeerWrite = (facts: Pick<Facts, "listener" | "kind" | "host" | "origin">, peerOrigins: ReadonlyArray<string>): boolean =>
  facts.listener === "tailnet" && PEER_WRITES.includes(facts.kind) && facts.origin !== `http://${facts.host}` && peerOrigins.includes(facts.origin)

/** A CORS preflight as the decision reads it: the request it announces (`kind`, none when no route takes it), its method and headers. */
export interface Preflight {
  readonly listener: Listener
  readonly kind: RouteKind | "none"
  readonly source: Source
  readonly host: string
  readonly hosts: ReadonlyArray<string>
  readonly origin: string
  readonly method: string
  /** Access-Control-Request-Headers, each lower case. */
  readonly headers: ReadonlyArray<string>
}

/** Whether to answer a preflight with the peer origin allowed: a peer's write (isPeerWrite) by POST, asking only PEER_HEADERS. */
export const preflightOf = (asked: Preflight, peerOrigins: ReadonlyArray<string>): boolean =>
  asked.kind !== "none" &&
  reachable(asked.listener, asked.host, asked.hosts, asked.source) &&
  asked.method === "POST" &&
  asked.headers.every((header) => PEER_HEADERS.includes(header)) &&
  isPeerWrite({ listener: asked.listener, kind: asked.kind, host: asked.host, origin: asked.origin }, peerOrigins)

/**
 * The one decision: by host, then the source, then a write's origin and headers, then what the route needs.
 * `peerOrigins`: the named peers' pages' origins (isPeerWrite), none by default.
 */
export const decide = (facts: Facts, policy: Policy = PAIRED, peerOrigins: ReadonlyArray<string> = []): Decision => {
  if (!facts.hosts.includes(facts.host)) return Decision.Refuse({ status: 421, reason: "this page answers on its own names only" })
  if (facts.listener === "tailnet" && (facts.source === "outside" || facts.source === "local")) return Decision.Refuse({ status: 403, reason: "this listener answers the tailnet only" })
  const peerWrite = isPeerWrite(facts, peerOrigins)
  if (WRITES.includes(facts.kind)) {
    if (facts.origin !== `http://${facts.host}` && !peerWrite) return Decision.Refuse({ status: 403, reason: "a write must come from the page's own origin" })
    if (!facts.pageHeader) return Decision.Refuse({ status: 403, reason: "a write must carry the page's header" })
    if (!facts.json) return Decision.Refuse({ status: 415, reason: "a write is JSON" })
  }
  // A peer's page holds no token of this host's: one that arrives with its write is not read.
  const paired = facts.paired && !peerWrite
  const need = needOf(facts.listener, facts.kind, policy, facts.source)
  if (need === "open" || paired) return Decision.Serve()
  if (need === "brief") return Decision.Brief()
  if (peerWrite) return Decision.Refuse({ status: 401, reason: PAIR_ON_HOST })
  return Decision.Refuse({ status: 401, reason: PAIR_FIRST })
}

/**
 * Whether this request's browser may answer now, as `/paired.json` tells the page: paired, or from a device his
 * switches open answers to. It says no more than an answer it sent would.
 */
export const mayAnswer = (listener: Listener, policy: Policy, source: Source, paired: boolean): boolean => paired || needOf(listener, "answer", policy, source) === "open"
