// The cache ledger the row and the sidebar both read: each session's judged
// misses, from the TUI's session data (opencode/view.ts) and the approval
// waits this TUI saw. Approval waits leave no record in the session's
// messages (the fork's `permission.asked` and `permission.replied` events are
// ephemeral), so a wait this TUI did not see while it happened reads as the
// tool call it held up. The ledger never fetches a transcript: it reads the
// ones the TUI holds (the session shown, a subagent opened), and the
// sidebar's cache share comes from every session's own token totals. The login each step went out on comes from the pool's
// `logins` RPC, asked when a session is first read and again when one of its
// steps ends; an answer that fails or does not decode names no login, and the
// misses read as if the pool had kept every step on one. How the cache mod's
// server judged each step (the segment a changed prefix changed first, a login
// move, an unchanged prefix the cache lost) comes over its own RPC
// (`CACHE_LEDGER`), asked at the same moments; with no server half loaded the
// answer fails and the fold's own causes stand. Each agent's own cache
// lifetime comes from the location's agent list.
//
// The cost stays with what changed. Each session read is one set of memos the
// rows of every turn and the sidebar share: each message is read in a memo of
// its own, which reads it again only when a field it read changes (a streamed
// token changes none) and passes the change on only when its reading differs;
// the session's timeline is put together from those readings, judged once,
// and indexed by turn, so a turn's rows are a lookup. A session no mounted row
// or sidebar reads is let go after `RELEASE_MS`: while the ledger is not
// shown, it reads nothing and asks for nothing.
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import { $TRACK, createComputed, createMemo, createRoot, createSignal, getOwner, onCleanup, type Accessor, type Setter } from "solid-js"
import { unwrap } from "solid-js/store"
import { POOL_STATUS, SessionLogins } from "@dotfiles/opencode-pool/status"
import { costliestCause, judge, missedUsd, turnIndex, type Judged } from "../ledger.ts"
import { sidebarText } from "../line.ts"
import type { Span } from "../miss.ts"
import { assemble, descendants, hits, reading, sessionAgentTtls, sessionCatalog, type Reading } from "../opencode/view.ts"
import { CACHE_LEDGER, SessionSteps, type StepCause } from "../request-log.ts"

const decodeLogins = Schema.decodeUnknownOption(SessionLogins)
const decodeSteps = Schema.decodeUnknownOption(SessionSteps)
/** How long after a step ends the server's judgement of it is asked for again. */
const STEPS_SETTLE_MS = 1_000
/** How long a session no mounted row or sidebar reads keeps its memos, so a row that scrolls back in does not read the session again. */
const RELEASE_MS = 10_000

export interface Ledger {
  /** The rows of the turn `messageID` of `sessionID` closes, or of the compaction it names. Reactive. */
  rows(sessionID: string, messageID: string): ReadonlyArray<string>
  /** The sidebar line of `sessionID` and every session under it; undefined before any cache activity. Reactive. */
  sidebar(sessionID: string): string | undefined
  /** Stop listening. */
  dispose(): void
}

/** One session's memos, shared by every reader of it. */
interface Session {
  readonly judged: Accessor<ReadonlyArray<Judged>>
  readonly rows: (messageID: string) => ReadonlyArray<string>
  readonly setLogins: Setter<ReadonlyMap<string, string>>
  readonly setSteps: Setter<ReadonlyMap<string, StepCause>>
  readonly setWaits: Setter<ReadonlyArray<Span>>
  readonly dispose: () => void
  users: number
  release: ReturnType<typeof setTimeout> | undefined
}

/** Equal plain data: a message's reading again after a change it does not show. */
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index]))
  if (Array.isArray(b)) return false
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  )
}

export function createLedger(ctx: Plugin.Context, options: { readonly releaseMs?: number } = {}): Ledger {
  const releaseMs = options.releaseMs ?? RELEASE_MS
  const waits = new Map<string, ReadonlyArray<Span>>()
  const asked = new Map<string, { readonly sessionID: string; readonly at: number }>()
  const sessions = new Map<string, Session>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const abort = new AbortController()
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      run()
    }, ms)
    timers.add(timer)
    return timer
  }
  /** Set an answer on the session's memos if it is still read. */
  const answer = (sessionID: string, session: Session, set: (session: Session) => void) => {
    if (!abort.signal.aborted && sessions.get(sessionID) === session) set(session)
  }
  const askLogins = (sessionID: string, session: Session) =>
    void ctx.client
      .rpc(POOL_STATUS)
      .logins({ sessionID }, { location: ctx.location, signal: abort.signal })
      .then(
        (value) => Option.map(decodeLogins(value), (found) => new Map(found.steps.map((step) => [step.messageID, step.credentialID] as const))),
        () => Option.none<ReadonlyMap<string, string>>(),
      )
      .then((found) => {
        if (Option.isSome(found)) answer(sessionID, session, (it) => it.setLogins(found.value))
      })
  const askSteps = (sessionID: string, session: Session) =>
    void ctx.client
      .rpc(CACHE_LEDGER)
      .steps({ sessionID }, { location: ctx.location, signal: abort.signal })
      .then(
        (value) => Option.map(decodeSteps(value), (found) => new Map(found.steps.map((step) => [step.messageID, step] as const))),
        () => Option.none<ReadonlyMap<string, StepCause>>(),
      )
      .then((found) => {
        if (Option.isSome(found)) answer(sessionID, session, (it) => it.setSteps(found.value))
      })

  /** The memos of `sessionID`: each message's reading, the timeline, its judged misses and the rows by turn. */
  const open = (sessionID: string): Session =>
    createRoot((dispose) => {
      const [logins, setLogins] = createSignal<ReadonlyMap<string, string>>(new Map())
      const [steps, setSteps] = createSignal<ReadonlyMap<string, StepCause>>(new Map())
      const [spans, setWaits] = createSignal<ReadonlyArray<Span>>(waits.get(sessionID) ?? [])
      // The session's messages in order, as the store holds them unwrapped. It
      // tracks the list itself (`$TRACK`: a message added, moved or replaced),
      // not each of its thousands of places, and a write inside a message
      // does not reach it.
      const items = createMemo(
        () => {
          const list = ctx.data.session.message.list(sessionID)
          void (list as unknown as Record<symbol, unknown>)[$TRACK]
          return { list, raw: unwrap(list).slice() }
        },
        undefined,
        { equals: (a, b) => a !== undefined && a.list === b.list && a.raw.length === b.raw.length && a.raw.every((item, index) => item === b.raw[index]) },
      )
      // Each message's reading, kept by a computation of its own that reads the
      // message (through the store, so it tracks the fields it read) again when
      // one of them changes, and tells the timeline only when the reading
      // differs. The timeline tracks the list and that one signal, not every
      // message.
      const [changed, change] = createSignal(undefined, { equals: false })
      const readings = new Map<object, { value: Reading; readonly dispose: () => void }>()
      const readingOf = (item: unknown, tracked: () => unknown): Reading => {
        if (item === null || typeof item !== "object") return reading(item)
        let kept = readings.get(item)
        if (kept === undefined) {
          // A root of its own, read untracked: it outlives the timeline's run that made it, until the message leaves the session.
          kept = createRoot((stop) => {
            const message = tracked()
            const entry = { value: undefined as Reading | undefined, dispose: stop }
            createComputed(() => {
              const next = reading(message)
              if (entry.value !== undefined && same(entry.value, next)) return
              const first = entry.value === undefined
              entry.value = next
              if (!first) change()
            })
            return entry as { value: Reading; readonly dispose: () => void }
          })
          readings.set(item, kept)
        }
        return kept.value
      }
      const timeline = createMemo(() => {
        changed()
        const { list, raw: messages } = items()
        const read = messages.map((item, index) => readingOf(item, () => list[index]))
        if (readings.size > messages.length) {
          const present = new Set<unknown>(messages)
          for (const [item, kept] of readings)
            if (!present.has(item)) {
              kept.dispose()
              readings.delete(item)
            }
        }
        return assemble(read, logins())
      })
      const terms = createMemo(() => sessionCatalog(ctx.data, sessionID))
      const ttls = createMemo(() => sessionAgentTtls(ctx.data, sessionID))
      const judged = createMemo(() => {
        const models = terms()
        const agents = ttls()
        const server = steps()
        return judge(
          timeline(),
          spans(),
          (model) => models.get(model),
          (agent) => agents.get(agent),
          (stepID) => server.get(stepID),
        )
      })
      const index = createMemo(() => turnIndex(timeline(), judged()))
      // The last rows each turn answered: the same rows again are the same array, so a turn's row draws nothing new.
      const answered = new Map<string, ReadonlyArray<string>>()
      return {
        judged,
        rows(messageID: string) {
          const next = index()(messageID)
          const last = answered.get(messageID)
          if (last !== undefined && same(last, next)) return last
          answered.set(messageID, next)
          return next
        },
        setLogins,
        setSteps,
        setWaits,
        dispose() {
          for (const memo of readings.values()) memo.dispose()
          readings.clear()
          dispose()
        },
        users: 0,
        release: undefined,
      }
    })

  const letGo = (sessionID: string, session: Session) => {
    session.users -= 1
    if (session.users > 0 || session.release !== undefined) return
    session.release = later(releaseMs, () => {
      session.release = undefined
      if (session.users > 0 || sessions.get(sessionID) !== session) return
      sessions.delete(sessionID)
      session.dispose()
    })
  }
  /** The memos of `sessionID`, held for as long as the computation reading them lives. */
  const hold = (sessionID: string): Session => {
    let session = sessions.get(sessionID)
    if (session === undefined) {
      const created = open(sessionID)
      session = created
      sessions.set(sessionID, created)
      askLogins(sessionID, created)
      askSteps(sessionID, created)
    }
    if (session.release !== undefined) {
      clearTimeout(session.release)
      timers.delete(session.release)
      session.release = undefined
    }
    session.users += 1
    const held = session
    if (getOwner() === null) letGo(sessionID, held)
    else onCleanup(() => letGo(sessionID, held))
    return session
  }

  const unsubscribe = [
    ctx.data.on("permission.asked", (event) => {
      asked.set(event.data.id, { sessionID: event.data.sessionID, at: Date.now() })
    }),
    ctx.data.on("permission.replied", (event) => {
      const open = asked.get(event.data.requestID)
      if (open === undefined) return
      asked.delete(event.data.requestID)
      const span: Span = { name: "approval", at: open.at, ms: Date.now() - open.at }
      const all = [...(waits.get(open.sessionID) ?? []), span]
      waits.set(open.sessionID, all)
      sessions.get(open.sessionID)?.setWaits(all)
    }),
    // A shown session's new step: ask the pool where it went out and the
    // server how it judged it.
    ctx.data.on("session.step.ended", (event) => {
      const sessionID = event.data.sessionID
      const session = sessions.get(sessionID)
      if (session === undefined) return
      askLogins(sessionID, session)
      askSteps(sessionID, session)
      // The server judges the step from the same event: ask again once it has.
      later(STEPS_SETTLE_MS, () => {
        if (sessions.get(sessionID) === session) askSteps(sessionID, session)
      })
    }),
  ]

  return {
    rows: (sessionID, messageID) => hold(sessionID).rows(messageID),
    sidebar(sessionID) {
      const ids = descendants(ctx.data, sessionID)
      // The share comes from each session's own token totals. The misses need a transcript, so they count
      // the session and the subagents whose transcripts the TUI already holds: a family of hundreds of
      // subagents would otherwise load every transcript to draw one line.
      const held = ids.filter((id) => id === sessionID || ctx.data.session.message.list(id).length > 0)
      const all = held.map((id) => hold(id).judged())
      return sidebarText(hits(ctx.data, ids), missedUsd(all), costliestCause(all))
    },
    dispose() {
      abort.abort()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const session of sessions.values()) session.dispose()
      sessions.clear()
      for (const stop of unsubscribe) stop()
    },
  }
}
