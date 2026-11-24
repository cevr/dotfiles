import * as TuiClock from "@dotfiles/decider/tui-clock"
import { type BindPaneRequest, PANE_AGENT } from "@dotfiles/opencode-pane-agent/worker"
import { Plugin } from "@opencode/plugin/tui"
import { Config, Effect, Option } from "effect"

const HEARTBEAT_MS = 5_000

const attached = (argv: ReadonlyArray<string>): boolean =>
  argv.some((arg) => arg === "attach" || arg === "--server" || arg.startsWith("--server="))

export interface RouteState {
  readonly type: string
  readonly sessionID?: string
}

export type Host = Pick<Plugin.Context, "location"> & {
  readonly ui: { readonly router: { current(): RouteState } }
  readonly data: {
    readonly session: { root(sessionID: string): string }
    readonly listen: (listener: () => void) => () => void
  }
  readonly bindPane: (input: BindPaneRequest, onError: () => void) => void
}

export interface RexPaneEnv {
  readonly rexSession: Option.Option<string>
  readonly rexBlock: Option.Option<string>
}

const readNonEmptyConfig = (name: string): Option.Option<string> =>
  Effect.runSync(
    Config.option(Config.String(name)).pipe(
      Effect.map(Option.filter((value) => value.length > 0)),
      Effect.orElseSucceed(() => Option.none<string>()),
    ),
  )

const readRexEnv = (): RexPaneEnv => ({
  rexSession: readNonEmptyConfig("REX_SESSION"),
  rexBlock: readNonEmptyConfig("REX_BLOCK"),
})

export const bindActivePane = (
  ctx: Host,
  env: RexPaneEnv,
  argv: ReadonlyArray<string>,
): Option.Option<() => void> => {
  if (attached(argv)) return Option.none()
  const pane = Option.all({ session: env.rexSession, block: env.rexBlock })
  if (Option.isNone(pane)) return Option.none()
  let lastSession = ""
  const report = () => {
    const route = ctx.ui.router.current()
    if (route.type !== "session") return
    const sessionID = Option.fromUndefinedOr(route.sessionID)
    if (Option.isNone(sessionID)) return
    const rootID = ctx.data.session.root(sessionID.value)
    if (rootID.length === 0 || rootID === lastSession) return
    lastSession = rootID
    ctx.bindPane({ sessionID: rootID, rexSession: pane.value.session, rexBlock: pane.value.block }, () => {
      lastSession = ""
    })
  }
  report()
  const stopListen = ctx.data.listen(report)
  const stopClock = TuiClock.every(HEARTBEAT_MS, report)
  return Option.some(() => {
    stopListen()
    stopClock()
  })
}

export default Plugin.define({
  id: PANE_AGENT.id,
  setup: (ctx) => {
    const host: Host = {
      location: ctx.location,
      ui: ctx.ui,
      data: ctx.data,
      bindPane: (input, onError) => {
        void ctx.client
          .rpc(PANE_AGENT)
          .bindPane(input, { location: ctx.location })
          .catch(onError)
      },
    }
    return Option.getOrUndefined(bindActivePane(host, readRexEnv(), Bun.argv.slice(2)))
  },
})
