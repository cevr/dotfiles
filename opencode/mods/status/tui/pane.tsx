// The /pool pane: the account pool, the fleet, the running agents and the
// orchestrate runs. Thin: it reads the pool's RPC and the status RPC every 2 seconds,
// takes the running child sessions from the same collection Prime's dock
// counts, and draws the rows pane.ts projects from them. An answer that fails
// or does not decode keeps the last reading and says so; a pool with no fleet
// or resets method (one from before it) hides that section, as does a pool
// that has worked no reset. cmd/status/tui.tsx
// registers it.
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import { accountRows, agentRows, fleetRows, PaneFleet, PanePools, PaneResets, resetRows, resetsLine, stamp, unavailable, unitLine } from "../pane.ts"
import { Snapshot, STATUS } from "../status.ts"

const decodePools = Schema.decodeUnknownOption(PanePools)
const decodeSnapshot = Schema.decodeUnknownOption(Snapshot)
const decodeFleet = Schema.decodeUnknownOption(PaneFleet)
const decodeResets = Schema.decodeUnknownOption(PaneResets)

/** What an answer decodes to; a call that failed decodes to nothing. */
const answer = <A,>(result: PromiseSettledResult<unknown>, decode: (input: unknown) => Option.Option<A>) =>
  result.status === "fulfilled" ? decode(result.value) : Option.none<A>()

type PanelInput = { readonly focused: boolean; readonly close: () => void }

export function Pane(props: { ctx: Plugin.Context; sessionID: string; panel: PanelInput }) {
  const ctx = props.ctx
  // The pane holds focus once open; Esc or q hands it back to the prompt.
  ctx.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    commands: [{ title: "Close the account pool", group: "Pool", bind: "escape,q", run: () => props.panel.close() }],
  }))
  const [pool, setPool] = createSignal<PanePools>()
  const [snapshot, setSnapshot] = createSignal<Snapshot>()
  const [fleet, setFleet] = createSignal<PaneFleet>()
  const [claims, setClaims] = createSignal<PaneResets>()
  const [errors, setErrors] = createSignal<ReadonlyArray<string>>([])
  const [at, setAt] = createSignal<number>()
  const abort = new AbortController()
  let pending = false
  let closed = false
  const refresh = async () => {
    if (pending) return
    pending = true
    const location = ctx.location
    const [poolResult, statusResult, fleetResult, resetsResult] = await Promise.allSettled([
      ctx.client.rpc(POOL_STATUS).status({}, { location, signal: abort.signal }),
      ctx.client.rpc(STATUS).status({}, { location, signal: abort.signal }),
      ctx.client.rpc(POOL_STATUS).fleet({}, { location, signal: abort.signal }),
      ctx.client.rpc(POOL_STATUS).resets({}, { location, signal: abort.signal }),
    ])
    if (closed) return
    const pools = answer(poolResult, decodePools)
    const status = answer(statusResult, decodeSnapshot)
    if (Option.isSome(pools)) setPool(pools.value)
    if (Option.isSome(status)) setSnapshot(status.value)
    setFleet(Option.getOrUndefined(answer(fleetResult, decodeFleet)))
    setClaims(Option.getOrUndefined(answer(resetsResult, decodeResets)))
    setErrors(unavailable(Option.isNone(pools), Option.isNone(status)))
    setAt(Date.now())
    pending = false
  }
  void refresh()
  const timer = setInterval(() => void refresh(), 2000)
  onCleanup(() => {
    closed = true
    abort.abort()
    clearInterval(timer)
  })
  const agents = createMemo(() =>
    agentRows(
      ctx.data.session
        .family(props.sessionID)
        .filter((id) => id !== props.sessionID && ctx.data.session.status(id) === "running")
        .map((id) => {
          const session = ctx.data.session.get(id)
          return { id, ...(session?.agent === undefined ? {} : { agent: session.agent }), ...(session?.title === undefined ? {} : { title: session.title }) }
        }),
      snapshot()?.agents ?? [],
    ),
  )
  const accounts = createMemo(() => {
    const pools = pool()
    return pools === undefined ? undefined : accountRows(pools)
  })
  const resets = createMemo(() => {
    const pools = pool()
    return pools === undefined ? undefined : resetsLine(pools)
  })
  /** The resets the pool works and the claims made; none when it has worked none. */
  const worked = createMemo(() => {
    const read = claims()
    const rows = read === undefined ? [] : resetRows(read)
    return rows.length === 0 ? undefined : rows
  })
  const theme = () => ctx.theme
  const heading = (label: string) => <text fg={theme().text.base} attributes={1} marginTop={1}>{label}</text>
  const muted = (text: string) => <text fg={theme().text.muted}>{text}</text>
  return (
    <scrollbox flexGrow={1}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <text fg={theme().text.base} attributes={1}>Account pool</text>
        {muted(at() ? `Read ${stamp(at())} · refresh 2s` : "Loading pool, agents and runs…")}
        <For each={errors()}>{(error) => <text fg={theme().text.feedback.warning.base}>{error}</text>}</For>
        <For each={snapshot()?.errors}>{(error) => <text fg={theme().text.feedback.warning.base}>{error}</text>}</For>
        {heading("Accounts")}
        <Show when={resets()}>{(line) => <text fg={theme().text.base}>{line()}</text>}</Show>
        <Show when={accounts()} fallback={muted("Loading accounts…")}>
          {(rows) => (
            <For each={rows()} fallback={muted("No pool accounts.")}>
              {(row) => (
                <box flexDirection="column" marginBottom={1}>
                  <text fg={row.held ? theme().text.feedback.warning.base : theme().text.base}>{row.title}</text>
                  <For each={row.windows}>{(line) => <text fg={theme().text.muted}>{line}</text>}</For>
                </box>
              )}
            </For>
          )}
        </Show>
        <Show when={worked()}>
          {(rows) => (
            <>
              {heading("Resets")}
              <For each={rows()}>
                {(row) => <text fg={row.asking ? theme().text.feedback.warning.base : theme().text.base}>{row.text}</text>}
              </For>
            </>
          )}
        </Show>
        <Show when={fleet()}>
          {(read) => (
            <>
              {heading("Fleet")}
              <For each={fleetRows(read())}>
                {(row) => <text fg={row.down ? theme().text.feedback.warning.base : theme().text.base}>{row.text}</text>}
              </For>
            </>
          )}
        </Show>
        {heading(`Running agents (${agents().length})`)}
        <For each={agents()} fallback={muted("No running agents.")}>
          {(agent) => <text fg={theme().text.base}>◆ {agent.role} · {agent.description}</text>}
        </For>

        {heading("Orchestrate runs")}
        <For each={snapshot()?.runs} fallback={muted(snapshot() ? "No run dir in this repo." : "Loading runs…")}>
          {(run) => (
            <box flexDirection="column">
              <text fg={theme().text.base}>{run.name}</text>
              <For each={run.units} fallback={muted("No unit logs.")}>{(unit) => muted(unitLine(unit))}</For>
            </box>
          )}
        </For>
      </box>
    </scrollbox>
  )
}
