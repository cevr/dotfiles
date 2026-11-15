// The TUI's state reporter for Rex: it holds the terminal's program status
// (the host's `ui.programStatus.claim()`, so the host's own records stop) and
// writes the record of what the TUI shows (../state.ts `reportOf`) each time
// it changes, spaced by the gap `step` keeps. Outside a Rex pane it claims
// nothing and writes nothing, and the host keeps its own records. `exit`
// writes the clearing report at once (the TUI runs it when told to stop,
// ahead of its teardown); disposing the root runs it too. Create it inside a
// Solid root.
import { decide, type View } from "@dotfiles/opencode-herdr/activity"
import { Clock as EffectClock, Effect, Fiber, Option, Result } from "effect"
import { type Accessor, createEffect, onCleanup } from "solid-js"
import { type BlockedKind, type Event, type Report, reportOf, type Reporting, type Seen, start, step } from "../state.ts"

/**
 * What the record reads of the TUI's view: herdr's decision over the root
 * session of the route and its family (any busy member works, any blocked
 * one blocks), blocked on a permission when any member waits on one and on a
 * question otherwise (a form, or the owner's background questions), and
 * whether the root's last run failed.
 */
export const seenOf = (view: View, failed: boolean): Seen => {
  const activity = decide(view)
  const members = Option.match(Option.fromUndefinedOr(view.root), { onNone: () => [], onSome: (root) => [root, ...view.descendants] })
  const blockedOn = Option.match(
    Option.liftPredicate(members, (all) => all.some((session) => session.permissions.length > 0)),
    { onSome: (): BlockedKind => "permission", onNone: (): BlockedKind => "question" },
  )
  return { state: activity.state, title: activity.title, working: activity.working, message: activity.message, blockedOn, failed }
}

/** The host's hold on the terminal's program status, as `ui.programStatus.claim()` returns it. */
export interface Claim {
  /** Writes one report; false when the renderer did not queue it. May throw on a report the protocol refuses. */
  readonly report: (report: Report) => boolean
}

/** The clock the reporter waits on: a test supplies its own. */
export interface Clock {
  readonly now: () => number
  /** Runs `run` after `ms`; the returned function cancels it. */
  readonly after: (ms: number, run: () => void) => () => void
}

/** Effect's clock: the time now, and a sleep in a fiber of its own that cancelling interrupts. */
export const systemClock: Clock = {
  now: () => Effect.runSync(EffectClock.currentTimeMillis),
  after: (ms, run) => {
    const fiber = Effect.runFork(Effect.sleep(ms).pipe(Effect.andThen(Effect.sync(run))))
    return () => void Effect.runFork(Fiber.interrupt(fiber))
  },
}

export interface StateReporter {
  /** Clears the record and stops reporting, the first time it runs. */
  readonly exit: () => void
}

const silent: StateReporter = { exit: () => {} }

/**
 * Report `seen` to the terminal when `rex` holds: claim the program status
 * once, then write each change through it. A report the renderer refuses, or
 * one that throws, is held and tried again at the next tick.
 */
export function reportState(input: {
  readonly rex: boolean
  readonly claim: () => Claim
  readonly seen: Accessor<Seen>
  readonly clock?: Clock
  /** Solid's own, or the reactive build's in a test (Bun resolves solid-js to its server build, which never re-runs a computation). */
  readonly solid?: { readonly createEffect: typeof createEffect; readonly onCleanup: typeof onCleanup }
}): StateReporter {
  if (!input.rex) return silent
  const clock = input.clock ?? systemClock
  const solid = input.solid ?? { createEffect, onCleanup }
  const claim = input.claim()
  let state: Reporting = start(true)
  let cancel: Option.Option<() => void> = Option.none()

  const stopTimer = () => {
    Option.map(cancel, (stop) => stop())
    cancel = Option.none()
  }

  const write = (report: Report) => Result.getOrElse(Result.try(() => claim.report(report)), () => false)

  const apply = (event: Event): void => {
    const next = step(state, event)
    state = next.state
    for (const report of next.write) if (!write(report)) apply({ type: "refused", report, at: clock.now() })
    Option.map(Option.fromUndefinedOr(next.wake), (wake) => {
      stopTimer()
      cancel = Option.some(
        clock.after(Math.max(0, wake - clock.now()), () => {
          cancel = Option.none()
          apply({ type: "tick", at: clock.now() })
        }),
      )
    })
  }

  solid.createEffect(() => apply({ type: "show", report: reportOf(input.seen()), at: clock.now() }))
  const exit = () => {
    stopTimer()
    apply({ type: "exit" })
  }
  solid.onCleanup(exit)
  return { exit }
}
