// /pool is a host-owned panel. Reads go through RPC; live session identity
// and activity come from the same collection Prime's dock counts.
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { AccountStatus } from "../../pool/src/pool.ts"
import { POOL_STATUS } from "../../pool/src/protocol.ts"
import { STATUS, type Snapshot } from "./protocol.ts"

type Pools = Record<string, { accounts: readonly AccountStatus[] }>
const stamp = (at?: number) => at === undefined ? "unknown" : new Date(at).toISOString().slice(0, 16).replace("T", " ") + "Z"

type PanelInput = { readonly focused: boolean; readonly close: () => void }

function Pane(props: { ctx: Plugin.Context; sessionID: string; panel: PanelInput }) {
  const ctx = props.ctx
  // The pane holds focus once open; Esc or q hands it back to the prompt.
  ctx.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    commands: [{ title: "Close the account pool", group: "Pool", bind: "escape,q", run: () => props.panel.close() }],
  }))
  const [pool, setPool] = createSignal<Pools>()
  const [snapshot, setSnapshot] = createSignal<Snapshot>()
  const [errors, setErrors] = createSignal<string[]>([])
  const [at, setAt] = createSignal<number>()
  const abort = new AbortController()
  let pending = false
  let closed = false
  const refresh = async () => {
    if (pending) return
    pending = true
    const location = ctx.location
    const results = await Promise.allSettled([
      ctx.client.rpc(POOL_STATUS).status({}, { location, signal: abort.signal }),
      ctx.client.rpc(STATUS).status({}, { location, signal: abort.signal }),
    ])
    if (closed) return
    const [p, s] = results
    if (p.status === "fulfilled") setPool(p.value as Pools)
    if (s.status === "fulfilled") setSnapshot(s.value as Snapshot)
    setErrors(results.flatMap((r, i) => r.status === "rejected" ? [`${["Pool", "Agents and runs"][i]} unavailable; keeping last reading`] : []))
    setAt(Date.now())
    pending = false
  }
  void refresh()
  const timer = setInterval(() => void refresh(), 2000)
  onCleanup(() => { closed = true; abort.abort(); clearInterval(timer) })
  const agents = createMemo(() => ctx.data.session.family(props.sessionID)
    .filter((id) => id !== props.sessionID && ctx.data.session.status(id) === "running")
    .map((id) => {
      const call = snapshot()?.agents.find((item) => item.child === id)
      const session = ctx.data.session.get(id)
      return { id, role: session?.agent ?? call?.agent ?? "agent", description: call?.description ?? session?.title ?? id }
    }))
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
        <Show when={pool()} fallback={muted("Loading accounts…")}>
          <Show when={Object.values(pool()!).some((entry) => entry.accounts.length)} fallback={muted("No pool accounts.")}>
            <For each={Object.entries(pool()!)}>{([provider, entry]) => <For each={entry.accounts}>{(account) => (
              <box flexDirection="column" marginBottom={1}>
                <text fg={account.hold ? theme().text.feedback.warning.base : theme().text.base}>
                  {provider} / {account.credentialID} · {account.hold ? `held (${account.hold.kind}) until ${stamp(account.hold.until)}` : "available"}
                </text>
                <For each={["5h", "7d"]}>{(name) => {
                  const window = () => account.reading?.windows.find((window) => window.name === name)
                  return <text fg={theme().text.muted}>  {name} {window() ? `${Math.round(window()!.utilization * 100)}%` : "unknown"} · reset {stamp(window()?.resetAt)}</text>
                }}</For>
              </box>
            )}</For>}</For>
          </Show>
        </Show>
        {heading(`Running agents (${agents().length})`)}
        <For each={agents()} fallback={muted("No running agents.")}>{(agent) => <text fg={theme().text.base}>◆ {agent.role} · {agent.description}</text>}</For>

        {heading("Orchestrate runs")}
        <For each={snapshot()?.runs} fallback={muted(snapshot() ? "No run dir in this repo." : "Loading runs…")}>{(run) => (
          <box flexDirection="column">
            <text fg={theme().text.base}>{run.name}</text>
            <For each={run.units} fallback={muted("No unit logs.")}>{(unit) => muted(`  ${unit.unit} · ${unit.state} · r${unit.round || "?"} · ${unit.since}`)}</For>
          </box>
        )}</For>
      </box>
    </scrollbox>
  )
}

export default Plugin.define({
  id: "dotfiles-opencode.status",
  setup(ctx) {
    ctx.keymap.layer(() => ({ mode: "global", commands: [{ id: "dotfiles-opencode.pool.open", title: "Account pool, agents and runs", slash: { name: "pool" }, run() {
      // /pool toggles, as /diff does.
      if (ctx.ui.panel.current()?.name === "pool") ctx.ui.panel.close()
      else ctx.ui.panel.open("pool")
    } }] }))
    ctx.ui.slot({ append: "session.panel", render: (input) => input.name === "pool" ? <Pane ctx={ctx} sessionID={input.sessionID} panel={input} /> : null })
  },
})
