// The Host's builds (tui/host.ts `update`, `upstream`): the version the
// service the TUI talks to runs, from its `/api/info`, and upstream
// OpenCode's reading as daily left it (`readUpstream`, given). Both are read
// once at setup and again each time the TUI's event stream connects
// (`server.connected`): every install writes the reading and then restarts
// the service onto its new build, and the TUI reconnects to it. A service
// still booting answers 503, so a failed read of its version is tried again,
// backing off, until it answers or a newer read takes over.
import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import type { UpstreamReading } from "../update.ts"

/** The waits between tries of one read: 1 s, doubling, at most 30 s, about four minutes in all. */
const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000] as const

/**
 * Readers of the service's version (undefined until the first read answers)
 * and of the upstream reading, reactive in a Solid computation; the returned
 * `stop` ends the subscription and any retry pending.
 */
export function builds(context: Plugin.Context, readUpstream: () => UpstreamReading | undefined) {
  const [served, setServed] = createSignal<string>()
  const [upstream, setUpstream] = createSignal<UpstreamReading | undefined>(undefined, {
    equals: (a, b) => a?.commits === b?.commits && a?.blocked === b?.blocked,
  })
  // A read the next connection started is newer, so each read takes a turn and an older one's answer is dropped.
  let turn = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const attempt = (current: number, tries: number) => {
    void context.client.server.info().then(
      (info) => {
        if (turn === current) setServed(info.version)
      },
      () => {
        const wait = RETRY_MS[tries]
        if (turn !== current || wait === undefined) return
        timer = setTimeout(() => attempt(current, tries + 1), wait)
      },
    )
  }
  const load = () => {
    clearTimeout(timer)
    setUpstream(readUpstream())
    attempt(++turn, 0)
  }
  load()
  const unconnected = context.data.on("server.connected", load)
  return {
    served: () => served(),
    upstream: () => upstream(),
    stop() {
      turn++
      clearTimeout(timer)
      unconnected()
    },
  }
}
