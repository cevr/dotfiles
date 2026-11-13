// A generated property over the guard's faults, on the simulated host at 20
// seeds: the guard (`cmd/guard/server.ts`'s `make`, sim/plugins.ts `guard`) in
// a root session and its subagent, the seed choosing up to 40 commands of shell
// calls (destructive, harmless, heavy, kills by pattern, a long sleep), each
// made by the session's model in a turn, as `shell` or as `bash` with its input
// an object or a JSON string (the host's input repair turns both into
// `shell`'s), and faults: a process table that cannot be read, a launcher that
// cannot be written, a restart at any point, time passing.
//
// After each call: a call the guard must refuse (a reset, `rm -rf` of the home
// or a repository, a kill by a pattern that matches the server, any kill by
// pattern while `ps` fails, a subagent's foreground long sleep) answers in the
// guard's words and never reaches the shell; any other reaches it exactly once,
// its command as written, a heavy one through a launcher unless none can be
// written (then with the shell itself), a light one with the shell itself. An
// aliased call's answer names the tool that ran. After each restart, one copy's
// hooks are registered; at the end, no timer of a closed copy fired.
import { expect } from "bun:test"
import { Array as Arr, Effect, Option, Schema } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import { below, generator } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/guard/guard-faults.sim.test.ts")

const WORK = "/scratch/guard/work"
const HOME = "/Users/owner"
const SPEC = "/scratch/guard/faults/spec.json"

/** A shell call by what the guard must make of it. */
const CALLS = [
  { kind: "reset", command: "git reset --hard", refused: "always" },
  { kind: "rm-home", command: "rm -rf ~", refused: "always" },
  { kind: "rm-repo", command: `rm -rf ${WORK}`, refused: "always" },
  { kind: "kill-server", command: `pkill -f '${SPEC}'`, refused: "always" },
  { kind: "kill-other", command: "pkill -f vite", refused: "when ps fails" },
  { kind: "sleep", command: "sleep 60", refused: "in a subagent" },
  { kind: "harmless", command: "echo ok", refused: "never" },
  { kind: "heavy", command: "bun test ./mods", refused: "never" },
] as const

type Call = (typeof CALLS)[number]

/** How the model sends the call: the host's tool as it is, or as a model carries it over, its input an object or a JSON string. */
const FORMS = [
  { id: "shell", name: "shell", text: false },
  { id: "bash", name: "bash", text: false },
  { id: "shell-text", name: "shell", text: true },
  { id: "bash-text", name: "bash", text: true },
] as const

type Form = (typeof FORMS)[number]

type CallCommand = { readonly type: "call"; readonly call: Call; readonly form: Form; readonly child: boolean }

type Command =
  | CallCommand
  | { readonly type: "ps-fails"; readonly on: boolean }
  | { readonly type: "launchers-fail"; readonly on: boolean }
  | { readonly type: "restart" }
  | { readonly type: "advance"; readonly ms: number }

const commandOf = (random: ReturnType<typeof generator>): Command => {
  const pick = below(random, 20)
  if (pick < 13) return { type: "call", call: CALLS[below(random, CALLS.length)], form: FORMS[below(random, FORMS.length)], child: below(random, 2) === 1 }
  if (pick < 15) return { type: "ps-fails", on: below(random, 2) === 1 }
  if (pick < 17) return { type: "launchers-fail", on: below(random, 2) === 1 }
  if (pick < 18) return { type: "restart" }
  return { type: "advance", ms: 1 + below(random, 120_000) }
}

/** Up to 40 commands, the seed choosing each. */
const commandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`guard-faults:${seed}`)
  return Array.from({ length: 10 + below(random, 31) }, () => commandOf(random))
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

/** A long sleep in the root runs in the background: the guard's sleep rule is the subagent's foreground call. */
const inBackground = (command: CallCommand) => command.call.kind === "sleep" && !command.child

/** The call's tool name and input, in its form. */
const sent = (command: CallCommand) => {
  const input = { command: command.call.command, description: command.call.kind, ...(inBackground(command) && { background: true }) }
  if (command.form.text) return { name: command.form.name, input: encodeJson(input) }
  return { name: command.form.name, input }
}

/** Whether the guard must refuse `call`, given the faults on and where it runs. */
const mustRefuse = (command: CallCommand, psFails: boolean) => {
  if (command.call.refused === "always") return true
  if (command.call.refused === "when ps fails") return psFails
  if (command.call.refused === "in a subagent") return command.child
  return false
}

type ToolMessage = Extract<World.Message, { readonly type: "tool" }>

/** The words a refusal of the guard opens with. */
const GUARD_WORDS = /^Error: guard-(destructive|sleep): /

/** What one call came to, held against what the guard must do with it under the faults on at the time. */
const judge = (
  check: typeof expect,
  command: CallCommand,
  state: { readonly psFails: boolean; readonly launchersFail: boolean },
  answer: Pick<ToolMessage, "output" | "error">,
  spawned: ReadonlyArray<World.Spawned>,
) => {
  const what = { kind: command.call.kind, form: command.form.id, child: command.child, psFails: state.psFails }
  if (mustRefuse(command, state.psFails)) {
    check({ ...what, error: answer.error, guardWords: GUARD_WORDS.test(answer.output), spawned: spawned.length }).toEqual({ ...what, error: true, guardWords: true, spawned: 0 })
    return
  }
  check({ ...what, refusal: /guard-(destructive|sleep)/.test(answer.output), spawned: spawned.map((each) => each.command) }).toEqual({
    ...what,
    refusal: false,
    spawned: [command.call.command],
  })
  const heavyLauncher = command.call.kind === "heavy" && !state.launchersFail
  const shell = spawned.map((each) => each.shell).join("")
  check({ ...what, heavyLauncher, launcher: shell.startsWith("/launchers/") && shell.endsWith("/zsh") }).toEqual({ ...what, heavyLauncher, launcher: heavyLauncher })
  if (!heavyLauncher) check({ ...what, shell }).toEqual({ ...what, shell: World.SHELL })
  check({ ...what, aliasNoted: answer.output.includes(World.aliasNote("bash", "shell")) }).toEqual({ ...what, aliasNoted: command.form.name === "bash" })
}

seeded(
  "a generated run of shell calls in a root and its subagent, under an unreadable process table, unwritable launchers and restarts, refuses exactly what loses work or idles a subagent, and runs the rest once as written",
  ({ seed, expect: check }) =>
    Effect.gen(function* () {
      const machine = Plugins.guardMachine({
        processes: [
          { pid: process.pid, name: "bun", args: `bun tests/guard/run.ts ${SPEC}` },
          { pid: process.pid + 1, name: "vite", args: "node vite --port 5173" },
        ],
        repos: [WORK],
      })
      // The model makes each session's waiting call when a prompt asks for it, then ends the turn.
      const pending = new Map<string, { readonly name: string; readonly input: Schema.Json }>()
      const world = World.make({
        seed,
        script: (request) =>
          Option.match(
            Option.filter(Option.fromNullishOr(pending.get(request.sessionID)), () => request.kind === "primary"),
            {
              onNone: () => World.say("done"),
              onSome: (next) => {
                pending.delete(request.sessionID)
                return World.call(`call_${world.spawned().length}`, next.name, next.input)
              },
            },
          ),
      })
      /** One call made by the session's model in a turn: its answer, once the turn is at rest. */
      const callIn = (sessionID: string, call: { readonly name: string; readonly input: Schema.Json }) =>
        Effect.gen(function* () {
          pending.set(sessionID, call)
          yield* world.prompt(sessionID, "make the call")
          yield* world.until(() => world.sessions.get(sessionID)?.running === false, 120_000, 10)
          const answers = world.messages(sessionID).filter((message): message is ToolMessage => message.type === "tool")
          return Option.getOrElse(Arr.last(answers), () => ({ output: "", error: false }))
        })
      yield* world.load(Plugins.guard(machine), { directory: WORK, options: { home: HOME } })
      const root = yield* world.session(WORK)
      const child = yield* world.session(WORK, { parentID: root })
      for (const command of commandsOf(seed)) {
        if (command.type === "ps-fails") machine.psFails = command.on
        if (command.type === "launchers-fail") machine.launchersFail = command.on
        if (command.type === "advance") yield* world.advance(command.ms)
        if (command.type === "restart") {
          yield* world.restart
          check({ toolHooks: world.hooked(World.TOOL_BEFORE), shellHooks: world.hooked(World.SHELL_CREATE) }).toEqual({ toolHooks: 1, shellHooks: 1 })
        }
        if (command.type !== "call") continue
        const before = world.spawned().length
        const answer = yield* callIn(
          Option.getOrElse(Option.liftPredicate(child, () => command.child), () => root),
          sent(command),
        )
        judge(check, command, { psFails: machine.psFails, launchersFail: machine.launchersFail }, answer, world.spawned().slice(before))
      }
      check(world.stale()).toEqual([])
    }),
)

Seed.effect(
  "the gate's 20 seeds reach every call in every form, in a root and a subagent, both faults on, and a restart",
  Effect.sync(() => {
    const all = Array.from({ length: Seed.SEEDS }, (_, index) => commandsOf(index + 1)).flat()
    const calls = new Set(all.filter((command): command is CallCommand => command.type === "call").map((command) => `${command.call.kind} ${command.form.id} ${command.child}`))
    expect(calls.size).toBe(CALLS.length * FORMS.length * 2)
    expect(all.some((command) => command.type === "ps-fails" && command.on)).toBe(true)
    expect(all.some((command) => command.type === "launchers-fail" && command.on)).toBe(true)
    expect(all.some((command) => command.type === "restart")).toBe(true)
  }),
)
