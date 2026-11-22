// Who may do what on the digest page: one pure decision over (listener, route, paired, origin, host), `decide`. The
// listener asks it for every request and acts on its answer alone.
//
// - Host: a request must name one of the listener's own hosts (`hosts`: its addresses and names, with the port).
//   Any other `Host` is refused on every route (DNS rebinding: a name rebound to the address reads nothing).
// - A write (a POST) must come from the page's own origin, `http://<the Host it named>`, carry PAGE_HEADER and be
//   JSON. Each of the listener's names is its own origin, and the browser keeps a token per origin, so a page opened
//   by its IP and later by its MagicDNS name pairs once for each.
// - What a route needs then (ACCESS):
//   - On loopback, a read or a mark needs nothing more, an answer a paired browser.
//   - Off loopback (the tailnet) every route needs a paired browser except the page's shell (its static bundle,
//     which holds no data), whether this browser is paired, the pairing itself, and `/health`, which answers only
//     `ok` there unless paired.
//   - `digest.tailnetRead: "member"` opens the tailnet's reads to every tailnet member. The default is "paired".
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

/** What a route needs: nothing more, a paired browser, or (health) a paired browser for more than `ok`. */
export type Need = "open" | "paired" | "brief"

/** What each route needs on each listener, with `digest.tailnetRead` at its default. */
export const ACCESS: Readonly<Record<Listener, Readonly<Record<RouteKind, Need>>>> = {
  loopback: { shell: "open", status: "open", health: "open", read: "open", mark: "open", answer: "paired", pair: "open" },
  tailnet: { shell: "open", status: "open", health: "brief", read: "paired", mark: "paired", answer: "paired", pair: "open" },
}

/** What `kind` needs on `listener`, given `digest.tailnetRead`. */
export const needOf = (listener: Listener, kind: RouteKind, tailnetRead: TailnetRead = "paired"): Need =>
  Match.value({ listener, kind, tailnetRead }).pipe(
    Match.when({ listener: "tailnet", kind: "read", tailnetRead: "member" }, (): Need => "open"),
    Match.orElse(() => ACCESS[listener][kind]),
  )

/** What one request is, as the decision reads it. */
export interface Facts {
  readonly listener: Listener
  readonly kind: RouteKind
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

/** The one decision: by host, then a write's origin and headers, then what the route needs. */
export const decide = (facts: Facts, tailnetRead: TailnetRead = "paired"): Decision => {
  if (!facts.hosts.includes(facts.host)) return Decision.Refuse({ status: 421, reason: "this page answers on its own names only" })
  if (WRITES.includes(facts.kind)) {
    if (facts.origin !== `http://${facts.host}`) return Decision.Refuse({ status: 403, reason: "a write must come from the page's own origin" })
    if (!facts.pageHeader) return Decision.Refuse({ status: 403, reason: "a write must carry the page's header" })
    if (!facts.json) return Decision.Refuse({ status: 415, reason: "a write is JSON" })
  }
  const need = needOf(facts.listener, facts.kind, tailnetRead)
  if (need === "open" || facts.paired) return Decision.Serve()
  if (need === "brief") return Decision.Brief()
  return Decision.Refuse({ status: 401, reason: PAIR_FIRST })
}
