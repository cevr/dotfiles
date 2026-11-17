// The Host's builds (tui/host.ts `update`, `upstream`, `starting`): the version
// the service the TUI talks to runs, from its `/api/info`, and upstream
// OpenCode's reading as daily left it (`readUpstream`, given). Both are read
// once at setup and again each time the TUI's event stream connects
// (`server.connected`): every install writes the reading and then restarts
// the service onto its new build, and the TUI reconnects to it. A service
// still booting answers 503, so a failed read of its version is tried again,
// backing off, until it answers or a newer read takes over. Until it answers
// the TUI waits for the service; then, in a location, for its providers, which
// the service lists once the location's plugins are active (starting.ts).
import * as TuiClock from "@dotfiles/decider/tui-clock"
import type { Plugin } from "@opencode/plugin/tui"
import { Option } from "effect"
import { createSignal } from "solid-js"
import { type Reading, type Starting, startingAfter } from "../starting.ts"
import type { UpstreamReading } from "../update.ts"

/** The waits between tries of one read: 1 s, doubling, at most 30 s, about four minutes in all. */
const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000] as const

/** The wait between reads of a location's providers while its plugins activate (each read waits up to 5 s itself). */
const PLUGINS_RETRY_MS = 1_000

/**
 * Readers of the service's version (undefined until the first read answers),
 * of the upstream reading and of what the TUI waits for, reactive in a Solid
 * computation; the returned `stop` ends the subscription and any retry pending.
 */
export function builds(context: Plugin.Context, readUpstream: () => UpstreamReading | undefined) {
  const [served, setServed] = createSignal<string>()
  const [upstream, setUpstream] = createSignal<UpstreamReading | undefined>(undefined, {
    equals: (a, b) => a?.commits === b?.commits && a?.blocked === b?.blocked,
  })
  const [starting, setStarting] = createSignal<Option.Option<Starting>>(Option.none(), {
    equals: (a, b) =>
      Option.match(a, {
        onNone: () => Option.isNone(b),
        onSome: (left) => Option.match(b, { onNone: () => false, onSome: (right) => left.phase === right.phase && left.since === right.since }),
      }),
  })
  // A read the next connection started is newer, so each read takes a turn and an older one's answer is dropped.
  let turn = 0
  let cancel: (() => void) | undefined
  const location = Option.fromNullishOr(context.location)
  const learnt = (reading: Reading) => setStarting((waiting) => startingAfter(waiting, reading, TuiClock.now(), Option.isSome(location)))
  // The location's providers answer once its plugins are active; with no location there is nothing more to wait for.
  const plugins = (current: number) =>
    Option.map(location, ({ directory }) =>
      context.client.provider.list({ location: { directory } }).then(
        () => {
          if (turn === current) learnt("providers")
        },
        () => {
          if (turn === current) cancel = TuiClock.once(PLUGINS_RETRY_MS, () => void plugins(current))
        },
      ),
    )
  const attempt = (current: number, tries: number) => {
    void context.client.server.info().then(
      (info) => {
        if (turn !== current) return
        setServed(info.version)
        learnt("served")
        plugins(current)
      },
      () => {
        const wait = RETRY_MS[tries]
        if (turn !== current || wait === undefined) return
        cancel = TuiClock.once(wait, () => attempt(current, tries + 1))
      },
    )
  }
  const load = () => {
    cancel?.()
    setUpstream(readUpstream())
    learnt("connected")
    attempt(++turn, 0)
  }
  load()
  const unconnected = context.data.on("server.connected", load)
  return {
    served: () => served(),
    upstream: () => upstream(),
    starting: () => starting(),
    stop() {
      turn++
      cancel?.()
      unconnected()
    },
  }
}
