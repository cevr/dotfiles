// The view as /view.json answers it: the JSON encoding of mods/digest/view.ts's View (an absent Option is an absent
// key). The page decides nothing the view already says: order, pinning, the cut, unread and every label are there.

export interface Round {
  readonly n: number
  readonly handed?: number
  readonly verdict?: string
  readonly batch?: string
  readonly verdictAt?: number
  readonly request?: string
  readonly findings?: string
}

export interface Unit {
  readonly name: string
  readonly purpose?: string
  readonly rounds: ReadonlyArray<Round>
}

export interface Decision {
  readonly q: string
  readonly assumed: string
  readonly said: string
  readonly matches: boolean
  /** Where he answered: "tray" or "page". */
  readonly via?: string
}

/** What a message asks him: its options and the run\x27s assumption meanwhile. */
export interface Ask {
  readonly ref: string
  readonly options: ReadonlyArray<string>
  readonly assume?: string
}

export type Kind = "shipped" | "stuck" | "needs" | "decided" | "fyi"

export interface Message {
  readonly id: string
  readonly kind: Kind
  readonly level: "red" | "need" | "ok" | "none"
  readonly subject: string
  readonly body: string
  readonly t: number
  readonly units: ReadonlyArray<Unit>
  readonly ask?: Ask
  readonly decided?: ReadonlyArray<Decision>
  readonly open: boolean
  readonly unread: boolean
  readonly pinned: boolean
  readonly returnsAt?: number
  readonly when: string
}

export interface TimeMark {
  readonly id: string
  readonly t: number
  readonly unread: boolean
  readonly red: boolean
}

export interface Project {
  readonly id: string
  readonly name: string
  readonly defaultName: string
  readonly where: string
  readonly level: "red" | "need" | "none"
  readonly headline: string
  readonly unread: number
  readonly needs: number
  readonly inbox: ReadonlyArray<Message>
  readonly cut: number
  readonly later: ReadonlyArray<Message>
  readonly marks: ReadonlyArray<TimeMark>
  /** The host it lives on, when the page shows more than one. */
  readonly host?: string
  /** A peer's project: that host's page, where it is marked and answered. */
  readonly origin?: string
}

export interface Span {
  readonly start: number
  readonly end: number
  readonly label: string
  readonly day?: string
  readonly name: string
}

export interface View {
  readonly v: number
  readonly now: number
  readonly zone: string
  readonly nowLabel: string
  readonly lastRead?: number
  readonly lastReadLabel?: string
  readonly since?: number
  readonly projects: ReadonlyArray<Project>
  readonly spans: ReadonlyArray<Span>
  /** The host serving the page. */
  readonly host?: string
  /** The other hosts the page shows, and whether their projects are in. */
  readonly peers?: ReadonlyArray<PeerStatus>
}

/** Another host: up (its projects are in), down, or on a build this page cannot read; when last read well. */
export interface PeerStatus {
  readonly name: string
  readonly state: "up" | "down" | "update"
  readonly reason: string
  readonly lastSeen?: number
  readonly lastSeenLabel?: string
  readonly origin?: string
}

/** Whether a message or project id is a peer's (peers.ts `peerId`): read here, marked and answered on its host. */
export const isPeer = (id: string): boolean => id.startsWith("peer:")

/** Whether `t` falls in `span` (the last span holds its end, now). */
export const inSpan = (span: Span, t: number, last: boolean): boolean => t >= span.start && (t < span.end || (last && t <= span.end))
