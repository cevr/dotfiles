import { Effect } from "effect"

/** No numeric process or group target exists here. Retained native child
 * handles are closed over by their spawn site; a cgroup stop is authorized
 * only while the caller inhabits that exact transient unit. */
export type SignalIntent =
  | { readonly target: "self"; readonly signal: "STOP" }
  | { readonly target: "own-group"; readonly signal: "TERM" | "KILL" | "CONT" }
  | { readonly target: "retained-child"; readonly signal: "TERM" }
  | { readonly target: "current-unit"; readonly signal: "TERM" }

export interface Actuation<E = never, R = never> {
  readonly dispatch: (intent: SignalIntent) => Effect.Effect<void, E, R>
}

export const termination = [
  { target: "own-group", signal: "TERM" },
  { target: "own-group", signal: "KILL" },
] as const satisfies ReadonlyArray<SignalIntent>

export type WatchAuthority =
  | { readonly source: "pipe"; readonly armed: boolean; readonly order: "eof" | "stop" | "drained" | "none" }
  | { readonly source: "leader"; readonly ownGroup: boolean; readonly watchdog: "gone" | "live" | "unknown" }
  | { readonly source: "observation"; readonly proof: "escaped" | "reused" | "unknown" }

export const watchdogPlan = (authority: WatchAuthority): ReadonlyArray<Extract<SignalIntent, { target: "own-group" }>> => {
  switch (authority.source) {
    case "pipe":
      if (authority.armed && (authority.order === "eof" || authority.order === "stop")) return termination
      return []
    case "leader":
      if (authority.ownGroup && authority.watchdog === "gone") return termination
      return []
    case "observation":
      return []
  }
}

export const issue = <E, R>(port: Actuation<E, R>, sequence: ReadonlyArray<SignalIntent>): Effect.Effect<void, E, R> =>
  Effect.forEach(sequence, port.dispatch, { discard: true })

/** The independent watcher needs no JS runtime after its launcher has
 * died. Compile its typed endpoint to the shell's self-group primitive. */
export const watchdogProgram = (sequence: ReadonlyArray<Extract<SignalIntent, { target: "own-group" }>>) => [
  "trap '' TERM HUP INT TSTP TTIN TTOU",
  'printf "%s\\n" ready',
  "IFS= read -r armed || exit 0",
  '[ "$armed" = armed ] || exit 0',
  'if IFS= read -r order && [ "$order" != stop ]; then exit 0; fi',
  ...sequence.flatMap(({ signal }) => {
    if (signal === "TERM") return ["kill -TERM 0", "/bin/sleep 2"]
    return [`kill -${signal} 0`]
  }),
].join("\n")
