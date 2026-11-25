// Cross-host Antigravity quota record and its pure join-semilattice merge.
// Each host shares its own AntigravityReport in the fleet Report (never a
// token): its limit events (group, reset, seenAt, host, key), its newest
// reading, its last read attempt + floor, whether it has a readable sign-in,
// and its last failure. Merging records from N hosts in any order, duplicated,
// delayed or partly unreadable is commutative, associative and idempotent:
// - for one (group, span), the worse (higher used) live reading wins;
// - a reset is never moved earlier (for readings or limits);
// - a limit holds until its reset or until a LATER reading with room;
// - an unreadable peer is shown stale with its age, never as open;
// - an unknown or absent window is never "unlimited" and never blocks a start.
// Pure: no clock, no I/O.
import { Array as Arr, Match, Option, Schema } from "effect"
import { GEMINI, keyOf, SHARED, Span, Window } from "./quota.ts"
import { Answer, READ_EVERY_MS, Shown, type State, Why } from "./state.ts"

/** One pane limit event observed on a host. */
export const LimitEvent = Schema.Struct({
  group: Schema.String,
  seenAt: Schema.Finite,
  resetAt: Schema.optionalKey(Schema.Finite),
  host: Schema.String,
  /** Stable dedup key (Error ID line when present, else reset time). */
  key: Schema.optionalKey(Schema.String),
})
export type LimitEvent = typeof LimitEvent.Type

/** One quota reading taken on a host. */
export const HostReading = Schema.Struct({
  at: Schema.Finite,
  host: Schema.String,
  windows: Schema.Array(Window),
})
export type HostReading = typeof HostReading.Type

/** One read attempt and its floor, for cross-host 5-minute spacing. */
export const HostAttempt = Schema.Struct({
  id: Schema.String,
  at: Schema.Finite,
  nextReadAt: Schema.Finite,
  host: Schema.String,
})
export type HostAttempt = typeof HostAttempt.Type

/** One host's last read failure, for status display. */
export const HostFailure = Schema.Struct({
  host: Schema.String,
  at: Schema.Finite,
  why: Why,
})
export type HostFailure = typeof HostFailure.Type

/** One host's Antigravity report, carried in the fleet Report. Never carries a token. */
export const AntigravityReport = Schema.Struct({
  host: Schema.String,
  at: Schema.Finite,
  /** Whether this host currently has a readable sign-in (managed profile token file or held token; never touches keychain). */
  readableSignIn: Schema.Boolean,
  /** Limit events seen on this host. */
  limits: Schema.Array(LimitEvent),
  /** Dedup keys of pane limit frames this host has already recorded. */
  seenLimitKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  /** This host's newest reading, if any. */
  reading: Schema.optionalKey(HostReading),
  /** This host's last read attempt and floor, if any. */
  attempt: Schema.optionalKey(HostAttempt),
  /** Why this host last failed or could not read, if any. */
  failure: Schema.optionalKey(Schema.Struct({ at: Schema.Finite, why: Why })),
})
export type AntigravityReport = typeof AntigravityReport.Type

/** One host's reachability in the merged fleet view. */
export const PeerHealth = Schema.TaggedUnion({
  Fresh: { host: Schema.String, seenAt: Schema.Finite, readableSignIn: Schema.Boolean },
  Stale: { host: Schema.String, since: Schema.Finite, seenAt: Schema.optionalKey(Schema.Finite), message: Schema.String },
})
export type PeerHealth = typeof PeerHealth.Type

/** The merged Antigravity state across hosts: canonical, sorted, join-semilattice. */
export const MergedRecord = Schema.Struct({
  hosts: Schema.Array(PeerHealth),
  limits: Schema.Array(LimitEvent),
  seenLimitKeys: Schema.Array(Schema.String),
  readings: Schema.Array(HostReading),
  attempts: Schema.Array(HostAttempt),
  failures: Schema.Array(HostFailure),
})
export type MergedRecord = typeof MergedRecord.Type

export const EMPTY_MERGED: MergedRecord = {
  hosts: [],
  limits: [],
  seenLimitKeys: [],
  readings: [],
  attempts: [],
  failures: [],
}

/** Deterministic string comparison independent of locale. */
export const compareText = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const compareOptNumber = (left: Option.Option<number>, right: Option.Option<number>): number =>
  Option.match(left, {
    onNone: () => Option.match(right, { onNone: () => 0, onSome: () => -1 }),
    onSome: (l) => Option.match(right, { onNone: () => 1, onSome: (r) => l - r }),
  })

const maxOpt = (left: Option.Option<number>, right: Option.Option<number>): Option.Option<number> =>
  Option.match(left, {
    onNone: () => right,
    onSome: (l) => Option.match(right, { onNone: () => left, onSome: (r) => Option.some(Math.max(l, r)) }),
  })

/** Worse of two windows for one (group, span): higher used wins, reset never moved earlier, deterministic label. */
const joinWindow = (left: Window, right: Window): Window => {
  const used = Math.max(left.used, right.used)
  const reset = maxOpt(Option.fromUndefinedOr(left.resetAt), Option.fromUndefinedOr(right.resetAt))
  const label = Match.value(compareText(left.label, right.label) <= 0).pipe(
    Match.when(true, () => left.label),
    Match.orElse(() => right.label),
  )
  const base: Window = { group: left.group, label, span: left.span, used }
  return Option.match(reset, { onNone: () => base, onSome: (resetAt) => ({ ...base, resetAt }) })
}

const canonicalWindows = (windows: ReadonlyArray<Window>): ReadonlyArray<Window> => {
  const byKey = new Map<string, Window>()
  for (const window of windows) {
    const key = keyOf(window)
    const before = Option.fromUndefinedOr(byKey.get(key))
    byKey.set(key, Option.match(before, { onNone: () => window, onSome: (prev) => joinWindow(prev, window) }))
  }
  return [...byKey.values()].toSorted((a, b) => compareText(keyOf(a), keyOf(b)))
}

const compareHealthRank = (left: PeerHealth, right: PeerHealth): number => {
  const timeOf = (health: PeerHealth) => PeerHealth.match(health, { Fresh: ({ seenAt }) => seenAt, Stale: ({ since }) => since })
  const staleOf = (health: PeerHealth) => PeerHealth.match(health, { Fresh: () => 0, Stale: () => 1 })
  const byTime = timeOf(left) - timeOf(right)
  if (byTime !== 0) return byTime
  const byStale = staleOf(left) - staleOf(right)
  if (byStale !== 0) return byStale
  return PeerHealth.match(left, {
    Fresh: (l) =>
      PeerHealth.match(right, {
        Fresh: (r) => Number(l.readableSignIn) - Number(r.readableSignIn),
        Stale: () => -1,
      }),
    Stale: (l) =>
      PeerHealth.match(right, {
        Fresh: () => 1,
        Stale: (r) => compareText(l.message, r.message),
      }),
  })
}

const seenAtOf = (health: PeerHealth): Option.Option<number> =>
  PeerHealth.match(health, {
    Fresh: ({ seenAt }) => Option.some(seenAt),
    Stale: ({ seenAt }) => Option.fromUndefinedOr(seenAt),
  })

/** Join two health observations for the same host: commutative, associative, idempotent. */
const joinHealth = (left: PeerHealth, right: PeerHealth): PeerHealth => {
  const winner = Match.value(compareHealthRank(left, right) >= 0).pipe(
    Match.when(true, () => left),
    Match.orElse(() => right),
  )
  const latestSeen = maxOpt(seenAtOf(left), seenAtOf(right))
  return PeerHealth.match(winner, {
    Fresh: (fresh) =>
      PeerHealth.cases.Fresh.make({
        host: fresh.host,
        seenAt: Option.getOrElse(latestSeen, () => fresh.seenAt),
        readableSignIn: fresh.readableSignIn,
      }),
    Stale: (stale) =>
      Option.match(latestSeen, {
        onNone: () => PeerHealth.cases.Stale.make({ host: stale.host, since: stale.since, message: stale.message }),
        onSome: (seenAt) => PeerHealth.cases.Stale.make({ host: stale.host, since: stale.since, seenAt, message: stale.message }),
      }),
  })
}

const limitIdentity = (limit: LimitEvent): string =>
  `${limit.group}\0${limit.host}\0${limit.seenAt}\0${Option.getOrElse(Option.map(Option.fromUndefinedOr(limit.resetAt), String), () => "")}\0${Option.getOrElse(Option.fromUndefinedOr(limit.key), () => "")}`

const compareLimit = (left: LimitEvent, right: LimitEvent): number => {
  const byGroup = compareText(left.group, right.group)
  if (byGroup !== 0) return byGroup
  if (left.seenAt !== right.seenAt) return left.seenAt - right.seenAt
  const byReset = compareOptNumber(Option.fromUndefinedOr(left.resetAt), Option.fromUndefinedOr(right.resetAt))
  if (byReset !== 0) return byReset
  const byHost = compareText(left.host, right.host)
  if (byHost !== 0) return byHost
  return compareText(Option.getOrElse(Option.fromUndefinedOr(left.key), () => ""), Option.getOrElse(Option.fromUndefinedOr(right.key), () => ""))
}

const compareReading = (left: HostReading, right: HostReading): number => {
  const byHost = compareText(left.host, right.host)
  if (byHost !== 0) return byHost
  return left.at - right.at
}

const attemptIdentity = (attempt: HostAttempt): string => `${attempt.host}\0${attempt.id}\0${attempt.at}\0${attempt.nextReadAt}`

const compareAttempt = (left: HostAttempt, right: HostAttempt): number => {
  const byHost = compareText(left.host, right.host)
  if (byHost !== 0) return byHost
  if (left.at !== right.at) return left.at - right.at
  if (left.nextReadAt !== right.nextReadAt) return left.nextReadAt - right.nextReadAt
  return compareText(left.id, right.id)
}

const joinFailure = (left: HostFailure, right: HostFailure): HostFailure => {
  if (left.at !== right.at) {
    return Match.value(left.at > right.at).pipe(Match.when(true, () => left), Match.orElse(() => right))
  }
  return Match.value(compareText(left.why._tag, right.why._tag) >= 0).pipe(Match.when(true, () => left), Match.orElse(() => right))
}

/** Lift a single host's AntigravityReport into a MergedRecord. */
export const fromReport = (report: AntigravityReport, seenAt: number = report.at): MergedRecord => {
  const limits = [...report.limits].toSorted(compareLimit)
  const keys = new Set<string>(Option.getOrElse(Option.fromUndefinedOr(report.seenLimitKeys), () => []))
  for (const limit of limits) {
    const key = Option.fromUndefinedOr(limit.key)
    if (Option.isSome(key)) keys.add(key.value)
  }
  const readings = Option.toArray(
    Option.map(Option.fromUndefinedOr(report.reading), (reading): HostReading => ({ ...reading, windows: canonicalWindows(reading.windows) })),
  )
  const attempts = Option.toArray(Option.fromUndefinedOr(report.attempt))
  const failures = Option.toArray(Option.map(Option.fromUndefinedOr(report.failure), (failure): HostFailure => ({ host: report.host, at: failure.at, why: failure.why })))
  return {
    hosts: [PeerHealth.cases.Fresh.make({ host: report.host, seenAt, readableSignIn: report.readableSignIn })],
    limits,
    seenLimitKeys: [...keys].toSorted(compareText),
    readings,
    attempts,
    failures,
  }
}

/** Lift an unreadable peer (plus its last report, if any) into a MergedRecord marked Stale. */
export const fromStalePeer = (peer: {
  readonly host: string
  readonly since: number
  readonly seenAt?: number
  readonly message: string
  readonly lastReport?: AntigravityReport
}): MergedRecord => {
  const stale: PeerHealth = Option.match(Option.fromUndefinedOr(peer.seenAt), {
    onNone: () => PeerHealth.cases.Stale.make({ host: peer.host, since: peer.since, message: peer.message }),
    onSome: (seenAt) => PeerHealth.cases.Stale.make({ host: peer.host, since: peer.since, seenAt, message: peer.message }),
  })
  const base: MergedRecord = { ...EMPTY_MERGED, hosts: [stale] }
  return Option.match(Option.fromUndefinedOr(peer.lastReport), {
    onNone: () => base,
    onSome: (last) => {
      const lifted = fromReport(last, Option.getOrElse(Option.fromUndefinedOr(peer.seenAt), () => last.at))
      return mergeRecords({ ...lifted, hosts: [stale] }, base)
    },
  })
}

/** Join two MergedRecords. Provably commutative, associative and idempotent. */
export const mergeRecords = (left: MergedRecord, right: MergedRecord): MergedRecord => {
  const hostsMap = new Map<string, PeerHealth>()
  for (const health of [...left.hosts, ...right.hosts]) {
    const prev = Option.fromUndefinedOr(hostsMap.get(health.host))
    hostsMap.set(health.host, Option.match(prev, { onNone: () => health, onSome: (existing) => joinHealth(existing, health) }))
  }
  const hosts = [...hostsMap.values()].toSorted((a, b) => compareText(a.host, b.host))

  const limitsMap = new Map<string, LimitEvent>()
  for (const limit of [...left.limits, ...right.limits]) limitsMap.set(limitIdentity(limit), limit)
  const limits = [...limitsMap.values()].toSorted(compareLimit)

  const keys = new Set<string>([...left.seenLimitKeys, ...right.seenLimitKeys])
  for (const limit of limits) {
    const key = Option.fromUndefinedOr(limit.key)
    if (Option.isSome(key)) keys.add(key.value)
  }
  const seenLimitKeys = [...keys].toSorted(compareText)

  const readingsMap = new Map<string, HostReading>()
  for (const reading of [...left.readings, ...right.readings]) {
    const key = `${reading.host}\0${reading.at}`
    const prev = Option.fromUndefinedOr(readingsMap.get(key))
    readingsMap.set(
      key,
      Option.match(prev, {
        onNone: () => ({ ...reading, windows: canonicalWindows(reading.windows) }),
        onSome: (existing) => ({ ...existing, windows: canonicalWindows([...existing.windows, ...reading.windows]) }),
      }),
    )
  }
  const readings = [...readingsMap.values()].toSorted(compareReading)

  const attemptsMap = new Map<string, HostAttempt>()
  for (const attempt of [...left.attempts, ...right.attempts]) attemptsMap.set(attemptIdentity(attempt), attempt)
  const attempts = [...attemptsMap.values()].toSorted(compareAttempt)

  const failuresMap = new Map<string, HostFailure>()
  for (const failure of [...left.failures, ...right.failures]) {
    const prev = Option.fromUndefinedOr(failuresMap.get(failure.host))
    failuresMap.set(failure.host, Option.match(prev, { onNone: () => failure, onSome: (existing) => joinFailure(existing, failure) }))
  }
  const failures = [...failuresMap.values()].toSorted((a, b) => compareText(a.host, b.host))

  return { hosts, limits, seenLimitKeys, readings, attempts, failures }
}

/** Fold mergeRecords over any collection of records. */
export const mergeAll = (records: ReadonlyArray<MergedRecord>): MergedRecord => records.reduce(mergeRecords, EMPTY_MERGED)

/** Build this host's own AntigravityReport from its local disk state (never carries a token). */
export const fromLocalState = (host: string, state: State, now: number, readableSignIn: boolean): AntigravityReport => {
  const limits: ReadonlyArray<LimitEvent> = Option.getOrElse(Option.fromUndefinedOr(state.limits), () => []).map((limit) => {
    const base: LimitEvent = {
      group: limit.group,
      seenAt: limit.seenAt,
      host: Option.getOrElse(Option.fromUndefinedOr(limit.host), () => host),
    }
    const withReset = Option.match(Option.fromUndefinedOr(limit.resetAt), { onNone: () => base, onSome: (resetAt) => ({ ...base, resetAt }) })
    return Option.match(Option.fromUndefinedOr(limit.key), { onNone: () => withReset, onSome: (key) => ({ ...withReset, key }) })
  })
  const base: AntigravityReport = { host, at: now, readableSignIn, limits }
  const withKeys = Option.match(Option.filter(Option.fromUndefinedOr(state.seenLimitKeys), Arr.isReadonlyArrayNonEmpty), {
    onNone: () => base,
    onSome: (seenLimitKeys) => ({ ...base, seenLimitKeys }),
  })
  const withReading = Option.match(Option.fromUndefinedOr(state.reading), {
    onNone: () => withKeys,
    onSome: (reading) => ({ ...withKeys, reading: { at: reading.at, host, windows: reading.windows } }),
  })
  const withAttempt = Option.match(Option.fromUndefinedOr(state.attempt), {
    onNone: () =>
      Match.value(state.nextReadAt > 0).pipe(
        Match.when(true, () => ({ ...withReading, attempt: { id: `floor-${state.nextReadAt}`, at: state.nextReadAt, nextReadAt: state.nextReadAt, host } })),
        Match.orElse(() => withReading),
      ),
    onSome: (attempt) => ({ ...withReading, attempt: { id: attempt.id, at: attempt.at, nextReadAt: state.nextReadAt, host } }),
  })
  return Option.match(Option.fromUndefinedOr(state.failure), {
    onNone: () => withAttempt,
    onSome: (failure) => ({ ...withAttempt, failure }),
  })
}

/** A peer's fleet entry shape (mirrors mods/pool/fleet.ts `Peer` without circular import). */
export interface PeerRecord {
  readonly report?: { readonly host: string; readonly antigravity?: AntigravityReport }
  readonly seenAt?: number
  readonly missed?: { readonly since: number; readonly message: string }
}

/** Merge this host's own AntigravityReport with every peer from the fleet state. */
export const mergeFleet = (
  own: AntigravityReport,
  peers: Readonly<Record<string, PeerRecord>>,
  peerNames: ReadonlyArray<string>,
  now: number,
): MergedRecord => {
  const names = Arr.dedupe([...peerNames, ...Object.keys(peers)])
  const records: Array<MergedRecord> = [fromReport(own, now)]
  for (const name of names) {
    const entry = Option.fromUndefinedOr(peers[name])
    if (Option.isNone(entry)) {
      records.push(fromStalePeer({ host: name, since: now, message: "not polled yet" }))
      continue
    }
    const peer = entry.value
    const host = Option.getOrElse(Option.map(Option.fromUndefinedOr(peer.report), (r) => r.host), () => name)
    const lastReport = Option.flatMap(Option.fromUndefinedOr(peer.report), (r) => Option.fromUndefinedOr(r.antigravity))
    const missed = Option.fromUndefinedOr(peer.missed)
    if (Option.isSome(missed)) {
      records.push(
        fromStalePeer({
          host,
          since: missed.value.since,
          message: missed.value.message,
          ...Option.match(Option.fromUndefinedOr(peer.seenAt), { onNone: () => ({}), onSome: (seenAt) => ({ seenAt }) }),
          ...Option.match(lastReport, { onNone: () => ({}), onSome: (report) => ({ lastReport: report }) }),
        }),
      )
      continue
    }
    Option.match(lastReport, {
      onSome: (report) => records.push(fromReport(report, Option.getOrElse(Option.fromUndefinedOr(peer.seenAt), () => report.at))),
      onNone: () => {
        // Peer answered with a report from before Antigravity was added (or not yet polled).
        const seenAt = Option.fromUndefinedOr(peer.seenAt)
        if (Option.isSome(seenAt)) {
          records.push({ ...EMPTY_MERGED, hosts: [PeerHealth.cases.Fresh.make({ host, seenAt: seenAt.value, readableSignIn: false })] })
        } else {
          records.push(fromStalePeer({ host, since: now, message: "not polled yet" }))
        }
      },
    })
  }
  return mergeAll(records)
}

/** The quota groups known to the merged record, Gemini and Claude & GPT first. */
export const mergedGroupsOf = (merged: MergedRecord): ReadonlyArray<{ readonly id: string; readonly label: string }> => {
  const base = [
    { id: "gemini", label: "Gemini" },
    { id: "claude-gpt", label: "Claude & GPT (shared)" },
  ]
  const fromReadings = merged.readings.flatMap((reading) => reading.windows.map((window) => ({ id: window.group, label: window.label })))
  const fromLimits = merged.limits.map((limit) => ({ id: limit.group, label: limit.group }))
  return Arr.dedupeWith([...base, ...fromReadings, ...fromLimits], (left, right) => left.id === right.id)
}

/** The merged live window of `(group, span)` at `now`: worse reading wins, reset never moved earlier; unknown when absent or expired. */
export const mergedWindowAt = (merged: MergedRecord, now: number, group: string, span: Span): Shown => {
  const live = merged.readings.flatMap((reading) =>
    reading.windows.filter(
      (window) => window.group === group && window.span === span && !Option.exists(Option.fromUndefinedOr(window.resetAt), (at) => at <= now),
    ),
  )
  return Arr.match(live, {
    onEmpty: () => Shown.cases.Unknown.make({ why: Why.cases.WindowUnknown.make({ group, span }) }),
    onNonEmpty: (items) => Shown.cases.Known.make({ window: items.reduce(joinWindow) }),
  })
}

/** Stale peers in the merged record, sorted by host. */
export const stalePeersOf = (merged: MergedRecord): ReadonlyArray<Extract<PeerHealth, { readonly _tag: "Stale" }>> =>
  merged.hosts.filter((health): health is Extract<PeerHealth, { readonly _tag: "Stale" }> => health._tag === "Stale")

/** How old a stale peer's information is at `now`: since its last good read if known, else since it became unreachable. */
export const staleAgeMs = (peer: Extract<PeerHealth, { readonly _tag: "Stale" }>, now: number): number =>
  Math.max(0, now - Option.getOrElse(Option.fromUndefinedOr(peer.seenAt), () => peer.since))

const peerStaleWhy = (stale: Extract<PeerHealth, { readonly _tag: "Stale" }>, now: number): Why =>
  Why.cases.PeerStale.make({ peer: stale.host, ageMs: staleAgeMs(stale, now) })

/** Whether any reading strictly LATER than `afterSeenAt` shows room on `group` at `now` (and no live merged window on `group` is full). */
const hasLaterReadingWithRoom = (merged: MergedRecord, now: number, group: string, afterSeenAt: number): boolean => {
  const spans: ReadonlyArray<Span> = ["5h", "7d", "quota"]
  const anyFull = spans.some((span) =>
    Shown.match(mergedWindowAt(merged, now, group, span), {
      Known: ({ window }) => window.used >= 1,
      Unknown: () => false,
    }),
  )
  if (anyFull) return false
  return merged.readings.some((reading) => {
    if (reading.at <= afterSeenAt) return false
    const liveForGroup = reading.windows.filter(
      (window) => window.group === group && !Option.exists(Option.fromUndefinedOr(window.resetAt), (at) => at <= now),
    )
    return liveForGroup.length > 0 && liveForGroup.every((window) => window.used < 1)
  })
}

const unreadWhy = (merged: MergedRecord, now: number): Why => {
  const stale = Arr.head(stalePeersOf(merged))
  if (Option.isSome(stale)) return peerStaleWhy(stale.value, now)
  const latestFailure = Arr.last([...merged.failures].toSorted((a, b) => a.at - b.at))
  return Option.match(latestFailure, { onNone: () => Why.cases.NotRead.make({}), onSome: (failure) => failure.why })
}

/**
 * Whether `group` is open at `now` from the merged fleet record:
 * 1. A limit holds until its reset or until a LATER reading with room (max reset wins, never moved earlier).
 * 2. A limit with no reset holds until a LATER reading with room.
 * 3. With no readings at all, Unmeasured (never open, never blocks).
 * 4. A full live window holds until its reset (max reset wins), or Unknown(FullWithoutReset).
 * 5. An unreadable peer is shown stale with its age, never as open.
 * 6. Open only when both 5h and 7d are live and not full and all peers are fresh; else Unknown (never unlimited, never blocks).
 */
export const mergedAnswerAt = (merged: MergedRecord, now: number, group: string): Answer => {
  const groupLimits = merged.limits.filter((limit) => limit.group === group)
  const activeLimits = groupLimits.filter((limit) => !hasLaterReadingWithRoom(merged, now, group, limit.seenAt))
  const liveResets = activeLimits.flatMap((limit) => Option.toArray(Option.filter(Option.fromUndefinedOr(limit.resetAt), (at) => at > now)))
  if (Arr.isReadonlyArrayNonEmpty(liveResets)) return Answer.cases.Limited.make({ until: Math.max(...liveResets), by: "limit" })
  const silentLimits = activeLimits.filter((limit) => Option.isNone(Option.fromUndefinedOr(limit.resetAt)))
  if (Arr.isReadonlyArrayNonEmpty(silentLimits)) return Answer.cases.LimitedResetUnknown.make({ seenAt: Math.max(...silentLimits.map((l) => l.seenAt)) })

  if (merged.readings.length === 0) {
    const pastResets = groupLimits.flatMap((limit) => Option.toArray(Option.fromUndefinedOr(limit.resetAt)))
    return Arr.match(pastResets, {
      onEmpty: () => Answer.cases.Unmeasured.make({ why: unreadWhy(merged, now) }),
      onNonEmpty: (resets) => Answer.cases.Unmeasured.make({ why: unreadWhy(merged, now), since: Math.max(...resets) }),
    })
  }

  const spans: ReadonlyArray<Span> = ["5h", "7d", "quota"]
  const known = spans.flatMap((span) =>
    Shown.match(mergedWindowAt(merged, now, group, span), {
      Known: ({ window }) => [window],
      Unknown: () => [],
    }),
  )
  const full = known.filter((window) => window.used >= 1)
  const fullWithoutReset = Arr.findFirst(full, (window) => Option.isNone(Option.fromUndefinedOr(window.resetAt)))
  if (Option.isSome(fullWithoutReset)) {
    return Answer.cases.Unknown.make({ why: Why.cases.FullWithoutReset.make({ group, span: fullWithoutReset.value.span }) })
  }
  const resets = full.flatMap((window) => Option.toArray(Option.fromUndefinedOr(window.resetAt)))
  if (Arr.isReadonlyArrayNonEmpty(resets)) return Answer.cases.Limited.make({ until: Math.max(...resets), by: "window" })

  const stale = Arr.head(stalePeersOf(merged))
  if (Option.isSome(stale)) return Answer.cases.Unknown.make({ why: peerStaleWhy(stale.value, now) })

  const missing = Arr.findFirst(["5h", "7d"] as const, (span) => !known.some((window) => window.span === span))
  return Option.match(missing, {
    onNone: () => Answer.cases.Open.make({}),
    onSome: (span) => Answer.cases.Unknown.make({ why: Why.cases.WindowUnknown.make({ group, span }) }),
  })
}

/** The 5-minute read floor counted across all hosts from the merged attempts. */
export const mergedNextReadAt = (merged: MergedRecord): number =>
  Arr.match(merged.attempts, {
    onEmpty: () => 0,
    onNonEmpty: (attempts) => Math.max(...attempts.map((attempt) => attempt.nextReadAt)),
  })

/** The sole reading host: the fleet's lowest host id (ASCII order) among fresh hosts with a readable sign-in. */
export const readingHost = (merged: MergedRecord): Option.Option<string> => {
  const eligible = merged.hosts
    .filter((health): health is Extract<PeerHealth, { readonly _tag: "Fresh" }> => health._tag === "Fresh" && health.readableSignIn)
    .map((health) => health.host)
    .toSorted(compareText)
  return Arr.head(eligible)
}

const SHARED_NAMES: ReadonlySet<string> = new Set([SHARED, "claude & gpt (shared)", "third-party", "3p", "anthropic", "openai"])
const SHARED_PREFIXES: ReadonlyArray<string> = ["claude", "opus", "sonnet", "haiku", "fable", "gpt", "codex", "o1", "o3", "o4"]
const EXACT_GROUPS: ReadonlyMap<string, string> = new Map([
  [GEMINI, GEMINI],
  ["google", GEMINI],
  ["gemini-argon", "gemini-argon"],
  ["gemini argon", "gemini-argon"],
  ["gemini-carbon", "gemini-carbon"],
  ["gemini carbon", "gemini-carbon"],
])

/**
 * Resolve a model id (`google/gemini-3-pro#high`, `anthropic/claude-opus-4-6`,
 * `openai/gpt-5.3-codex`) or a group id/label (`gemini`, `Claude & GPT (shared)`,
 * `third-party`) to its canonical quota group id; none when unrecognised.
 */
export const resolveGroup = (name: string): Option.Option<string> => {
  const trimmed = name.trim().toLowerCase()
  if (trimmed === "") return Option.none()
  const exact = Option.fromUndefinedOr(EXACT_GROUPS.get(trimmed))
  if (Option.isSome(exact)) return exact
  if (SHARED_NAMES.has(trimmed)) return Option.some(SHARED)
  const slash = trimmed.indexOf("/")
  const provider = Match.value(slash >= 0).pipe(Match.when(true, () => trimmed.slice(0, slash)), Match.orElse(() => ""))
  const withoutProvider = Match.value(slash >= 0).pipe(Match.when(true, () => trimmed.slice(slash + 1)), Match.orElse(() => trimmed))
  const bare = Option.getOrElse(Option.fromUndefinedOr(withoutProvider.split("#")[0]), () => withoutProvider)
  if (bare.startsWith("gemini-argon")) return Option.some("gemini-argon")
  if (bare.startsWith("gemini-carbon")) return Option.some("gemini-carbon")
  if (bare.startsWith("gemini")) return Option.some(GEMINI)
  if (SHARED_PREFIXES.some((prefix) => bare.startsWith(prefix))) return Option.some(SHARED)
  if (provider === "google" || provider === "gemini") return Option.some(GEMINI)
  if (provider === "anthropic" || provider === "openai") return Option.some(SHARED)
  return Option.none()
}

/**
 * "Open now, else when" for one quota group:
 * - `Now`: usable now (`measured: true` only when both windows are live with room and all peers are fresh;
 *   `measured: false` for unmeasured/unknown/stale — never called "open" or "unlimited", never blocks by itself).
 * - `NotNow`: held, ALWAYS with a finite epoch-ms `until > now`.
 */
export const OpenStatus = Schema.TaggedUnion({
  Now: { measured: Schema.Boolean, answer: Answer },
  NotNow: {
    until: Schema.Finite,
    why: Schema.Literals(["limit", "window", "limit-reset-unknown"]),
    answer: Answer,
  },
})
export type OpenStatus = typeof OpenStatus.Type

/** Answer "open now, else when" for `group` from the merged fleet record at `now`. */
export const openDecisionAt = (merged: MergedRecord, now: number, group: string): OpenStatus => {
  const answer = mergedAnswerAt(merged, now, group)
  return Answer.match(answer, {
    Open: () => OpenStatus.cases.Now.make({ measured: true, answer }),
    Unmeasured: () => OpenStatus.cases.Now.make({ measured: false, answer }),
    Unknown: () => OpenStatus.cases.Now.make({ measured: false, answer }),
    Limited: ({ until, by }) => OpenStatus.cases.NotNow.make({ until, why: by, answer }),
    LimitedResetUnknown: () =>
      OpenStatus.cases.NotNow.make({
        until: Math.max(now + READ_EVERY_MS, mergedNextReadAt(merged)),
        why: "limit-reset-unknown",
        answer,
      }),
  })
}
