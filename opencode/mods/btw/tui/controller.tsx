// What /btw and its pane do, between the keys and the btw model: run one
// handler, say a refusal or a failure as a toast, hold the question on its
// way so the pane can show it before the fork does (gent's makeForkPane), and
// keep what each session's fork reads as for the pane to draw. A reading is
// taken when a handler is done and, while a pane watches the session, a
// moment after each host event about its fork; one reading runs at a time per
// session, and a request while one runs takes one more after it. A question
// stays pending until the reading after it lands, or until it fails.
// cmd/btw/setup.ts makes one per plugin.
import { Effect } from "effect"
import { createSignal } from "solid-js"
import type { Btw } from "../model.ts"
import type { HostFailed, Reading } from "../service.ts"
import { explain, type OpenFork, type Rejection, type SideQuestionState } from "../side-question.ts"

/** What the reader is told when a handler fails. */
export const failureText = (failure: Rejection | HostFailed): string =>
  failure._tag === "HostFailed" ? `btw: could not ${failure.operation}: ${failure.message}` : explain(failure)

/** How long after a host event about a watched fork its reading is taken, in ms; events in between share it. */
export const SETTLE_MS = 100

const NOTHING: Reading = { turns: [], replying: false }

export interface Host {
  readonly btw: Btw["Service"]
  /** The session's side question now. Reactive when the store behind it is. */
  readonly state: (sessionID: string) => SideQuestionState
  /** Calls `handler` with the session each host event is about, until the returned cleanup runs. */
  readonly listen: (handler: (sessionID: string) => void) => () => void
  readonly notify: (message: string) => void
}

export interface Controller {
  /** The fork the session's side question follows. Reactive. */
  readonly fork: (sessionID: string) => OpenFork | undefined
  /** What that fork read as last; nothing before its first reading. Reactive. */
  readonly reading: (sessionID: string) => Reading
  /** The question on its way to the session's fork, if any. Reactive. */
  readonly pending: (sessionID: string) => string | undefined
  /** Takes the session's fork's reading again. */
  readonly refresh: (sessionID: string) => Promise<void>
  /** Keeps the session's reading current with its fork's events until the returned cleanup runs. */
  readonly watch: (sessionID: string) => () => void
  /** /btw in a session; see Btw.ask. */
  readonly ask: (sessionID: string, question: string) => Promise<void>
  /** A follow-up from the pane; true once the fork has it (the ask line clears). */
  readonly followUp: (sessionID: string, question: string) => Promise<boolean>
  /** Brings the fork's newest answer back; true once the session has it. */
  readonly bringBack: (sessionID: string) => Promise<boolean>
  /** Stops listening to the host. */
  readonly dispose: () => void
}

export const controller = (host: Host): Controller => {
  const [pending, setPending] = createSignal<Readonly<Record<string, string>>>({})
  const hold = (sessionID: string, question: string) => setPending((all) => ({ ...all, [sessionID]: question }))
  const release = (sessionID: string) =>
    setPending((all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== sessionID)))

  // Readings by fork, so a new fork never shows the last one's turns.
  const [readings, setReadings] = createSignal<Readonly<Record<string, Reading>>>({})
  const running = new Map<string, Promise<void>>()
  const queued = new Map<string, Promise<void>>()

  const take = (sessionID: string): Promise<void> => {
    const fork = host.state(sessionID).fork?.sessionID
    const reading = Effect.runPromise(host.btw.read(sessionID))
      .then((value) => {
        if (fork !== undefined) setReadings((all) => ({ ...all, [fork]: value }))
      })
      .finally(() => running.delete(sessionID))
    running.set(sessionID, reading)
    return reading
  }

  const refresh = (sessionID: string): Promise<void> => {
    const current = running.get(sessionID)
    if (current === undefined) return take(sessionID)
    const next =
      queued.get(sessionID) ??
      current.then(() => {
        queued.delete(sessionID)
        return take(sessionID)
      })
    queued.set(sessionID, next)
    return next
  }

  // Sessions a pane watches, with how many panes watch each, and their settling timers.
  const watched = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const soon = (sessionID: string) => {
    if (timers.has(sessionID)) return
    timers.set(
      sessionID,
      setTimeout(() => {
        timers.delete(sessionID)
        void refresh(sessionID)
      }, SETTLE_MS),
    )
  }
  const stop = host.listen((about) => {
    for (const sessionID of watched.keys()) if (host.state(sessionID).fork?.sessionID === about) soon(sessionID)
  })

  /** Runs a handler; a failure is told and reads as undefined. */
  const settle = <A,>(handler: Effect.Effect<A, Rejection | HostFailed>) =>
    Effect.runPromise(
      handler.pipe(
        Effect.match({
          onFailure: (failure) => {
            host.notify(failureText(failure))
            return undefined
          },
          onSuccess: (value) => ({ value }),
        }),
      ),
    )

  const ask = async (sessionID: string, raw: string) => {
    const question = raw.trim()
    if (question.length > 0) hold(sessionID, question)
    if ((await settle(host.btw.ask(sessionID, raw))) !== undefined) await refresh(sessionID)
    release(sessionID)
  }

  return {
    fork: (sessionID) => host.state(sessionID).fork,
    reading: (sessionID) => {
      const fork = host.state(sessionID).fork
      return (fork === undefined ? undefined : readings()[fork.sessionID]) ?? NOTHING
    },
    pending: (sessionID) => pending()[sessionID],
    refresh,
    watch: (sessionID) => {
      watched.set(sessionID, (watched.get(sessionID) ?? 0) + 1)
      return () => {
        const left = (watched.get(sessionID) ?? 1) - 1
        if (left > 0) return void watched.set(sessionID, left)
        watched.delete(sessionID)
        clearTimeout(timers.get(sessionID))
        timers.delete(sessionID)
      }
    },
    ask,
    followUp: async (sessionID, question) => {
      // No fork yet (the first one failed): the question opens one.
      if (host.state(sessionID).fork === undefined) {
        await ask(sessionID, question)
        return host.state(sessionID).fork !== undefined
      }
      hold(sessionID, question.trim())
      const asked = await settle(host.btw.followUp(sessionID, question))
      if (asked !== undefined) await refresh(sessionID)
      release(sessionID)
      return asked !== undefined
    },
    bringBack: async (sessionID) => (await settle(host.btw.bringBack(sessionID))) !== undefined,
    dispose: () => {
      stop()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
