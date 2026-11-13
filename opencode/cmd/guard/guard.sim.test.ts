// The guard on the simulated host, each test at 20 seeds: tests/guard.test.ts's
// names, with what the world carries of each claim. The guard runs from its
// composition root (`cmd/guard/server.ts`'s `make`) on the world's context: the
// registry's `execute.before` hook after the host's input repair, the shell's
// `create.before` hook on each spawn (sim/host-laws.ts holds both to real
// OpenCode). Where a session runs and whether it is a subagent come through the
// guard's own OpenCode adapters; the process table, the repositories and the
// launchers are the world's machine (sim/plugins.ts `guard`).
//
// What stays real (tests/parity/hooks.json says which, by name): the kernel's
// cell (a Bun worker), the subagent tool's own part, a work repository's HEAD
// and dirty file on disk, the niceness a launcher really runs at, and the
// launcher file on disk. The world proves the guard's decisions: what is
// refused in which words, what reaches the shell, and with which program.
import { Array as Arr, Effect, Option, Schema } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"
import {
  CHILD_SLEEP,
  DIRECT_TASK,
  DONE,
  HARMLESS,
  HARMLESS_OUT,
  HEAVY_NICE,
  killByPattern,
  LIGHT_NICE,
  POLICY_TASK,
  RESET,
  ROOT_SLEEP,
  SLEEP_CHILD_TASK,
  SLEEP_TASK,
} from "../../tests/guard/sim.ts"

const { seeded } = Seed.runner("cmd/guard/guard.sim.test.ts")

const WORK = "/scratch/guard/work"
const HOME = "/Users/owner"
/** The run's spec file, in the command line of the server's process alone: the policy task kills by it. */
const SPEC = "/scratch/guard/policy/spec.json"
const REFUSAL = "guard-destructive: `git reset --hard` discards uncommitted work; stash it (`git stash -u`) or commit first."
const RUN_LIMIT_MS = 300_000

/** The machine: the server this test stands for (the guard reads `process.pid`), started with the spec file, beside a dev server. */
const machine = () =>
  Plugins.guardMachine({
    processes: [
      { pid: process.pid, name: "bun", args: `bun tests/guard/run.ts ${SPEC}` },
      { pid: process.pid + 1, name: "vite", args: "node vite --port 5173" },
    ],
    repos: [WORK],
  })

/** Each task's calls, in order, as tests/guard/sim.ts scripts them (the subagent's own call aside: the world starts the child itself). */
const SCRIPTS = new Map<string, ReadonlyArray<{ readonly name: string; readonly input: { readonly [key: string]: string } }>>([
  [
    DIRECT_TASK,
    [
      { name: "shell", input: { command: RESET, description: "Reset the work tree" } },
      { name: "shell", input: { command: HARMLESS, description: "Run a harmless command" } },
    ],
  ],
  [SLEEP_TASK, [{ name: "shell", input: { command: ROOT_SLEEP, description: "Sleep in the root" } }]],
  [SLEEP_CHILD_TASK, [{ name: "shell", input: { command: CHILD_SLEEP, description: "Sleep in the subagent" } }]],
  [
    POLICY_TASK,
    [
      { name: "shell", input: { command: HEAVY_NICE, description: "Niceness of a heavy command" } },
      { name: "shell", input: { command: LIGHT_NICE, description: "Niceness of a light command" } },
      { name: "shell", input: { command: killByPattern(SPEC), description: "Kill by pattern" } },
    ],
  ],
])

/** The model: a title's words, else the task's next call by how many tool answers the conversation holds, then `DONE`. */
const script = (offered: Array<ReadonlyArray<string>>) => (request: World.Request) => {
  if (request.kind !== "primary") return World.say("Guard run")
  offered.push(request.tools)
  const lines = request.text.split("\n")
  const task = Arr.findFirst(SCRIPTS.keys(), (name) => lines[0] === `user: ${name}`)
  const calls = Option.getOrElse(
    Option.flatMap(task, (name) => Option.fromNullishOr(SCRIPTS.get(name))),
    () => [],
  )
  const answered = lines.filter((entry) => entry.startsWith("tool ")).length
  return Option.match(Arr.get(calls, answered), {
    onNone: () => World.say(DONE),
    onSome: (next) => World.call(`call_${answered}`, next.name, next.input),
  })
}

/** What each command prints in the world's shell, and how long it runs. */
const processes = (command: string): World.Process => {
  if (command === HARMLESS) return { exitCode: 0, stdout: `${HARMLESS_OUT}\n`, ms: 40 }
  if (command === ROOT_SLEEP) return { exitCode: 0, stdout: "root slept\n", ms: 30_000 }
  if (command === CHILD_SLEEP) return { exitCode: 0, stdout: "child slept\n", ms: 60_000 }
  if (command === HEAVY_NICE || command === LIGHT_NICE) return { exitCode: 0, stdout: "0\n", ms: 30 }
  return World.PROCESSES(command)
}

/** A session's tool answers, in order. */
const toolsOf = (world: World.World, id: string) => world.messages(id).filter((message): message is ToolMessage => message.type === "tool")

type ToolMessage = Extract<World.Message, { readonly type: "tool" }>

/** A shell call's command, from its input. */
const decodeCommand = Schema.decodeUnknownOption(Schema.Struct({ command: Schema.String }))

/** The commands a session's model called the shell with, in order, as its assistant messages hold them. */
const commandsOf = (world: World.World, id: string) =>
  world
    .messages(id)
    .filter((message): message is Extract<World.Message, { readonly type: "assistant" }> => message.type === "assistant")
    .flatMap((message) => Option.toArray(Option.flatMap(message.call, (call) => decodeCommand(call.input))))
    .map((input) => input.command)

/** One run of `task` in a root session, and of `child` in a subagent of it when given, to rest: the world, each session's tool answers. */
const run = (seed: number, task: string, child: Option.Option<string> = Option.none()) =>
  Effect.gen(function* () {
    const offered: Array<ReadonlyArray<string>> = []
    const world = World.make({ seed, script: script(offered), processes })
    const held = machine()
    yield* world.load(Plugins.guard(held), { directory: WORK, options: { home: HOME } })
    const root = yield* world.session(WORK)
    yield* world.prompt(root, task)
    const sub = yield* Option.match(child, {
      onNone: () => Effect.succeed(Arr.empty<string>()),
      onSome: (text) =>
        world.session(WORK, { parentID: root }).pipe(
          Effect.tap((id) => world.prompt(id, text)),
          Effect.map(Arr.of),
        ),
    })
    yield* world.until(() => [root, ...sub].every((id) => world.sessions.get(id)?.running === false), RUN_LIMIT_MS)
    const said = world
      .messages(root)
      .filter((message): message is Extract<World.Message, { readonly type: "assistant" }> => message.type === "assistant")
      .map((message) => message.text)
    return { world, held, offered, root, childID: sub.join(""), tools: toolsOf(world, root), childTools: sub.flatMap((id) => toolsOf(world, id)), said }
  })

seeded(
  "a direct shell call of git reset --hard is refused in the guard's words, a cell cannot reach the shell, and a harmless command runs",
  ({ seed, expect }) =>
    Effect.gen(function* () {
      const { world, root, offered, tools, said } = yield* run(seed, DIRECT_TASK)
      expect(offered[0]).toContain("shell")
      const [reset, harmless, ...rest] = tools
      expect(rest).toEqual([])
      expect(reset?.name).toBe("shell")
      expect(reset?.error).toBe(true)
      expect(reset?.output).toContain(REFUSAL)
      expect(harmless?.name).toBe("shell")
      expect(harmless?.error).toBe(false)
      expect(harmless?.output).toContain(HARMLESS_OUT)
      // The refused reset never reached the shell; the harmless command did, once, as written, with the shell itself.
      expect(world.spawned().map((spawned) => [spawned.command, spawned.shell, spawned.cwd])).toEqual([[HARMLESS, World.SHELL, WORK]])
      expect(said.at(-1)).toBe(DONE)
      // The model's calls carry the commands as it wrote them.
      const [resetCall, harmlessCall] = commandsOf(world, root)
      expect(resetCall).toBe(RESET)
      expect(harmlessCall).toBe(HARMLESS)
    }),
)

seeded("a subagent's shell call opening with sleep 60 is refused in the guard's words, and the root's sleep runs", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, root, childID, tools, childTools } = yield* run(seed, SLEEP_TASK, Option.some(SLEEP_CHILD_TASK))
    const [rootSleep, ...rest] = tools
    expect(rest).toEqual([])
    expect(rootSleep?.name).toBe("shell")
    expect(rootSleep?.error).toBe(false)
    expect(rootSleep?.output).not.toContain("guard-sleep")
    expect(rootSleep?.output).toContain("root slept")
    const [childSleep, ...childRest] = childTools
    expect(childRest).toEqual([])
    expect(childSleep?.name).toBe("shell")
    expect(childSleep?.error).toBe(true)
    expect(childSleep?.output).toContain("guard-sleep: `sleep 60` would hold this subagent's turn for 60 s doing nothing")
    expect(childSleep?.output).toContain('wait", id, ms })')
    expect(childSleep?.output).not.toContain("child slept")
    // Only the root's sleep reached the shell.
    expect(world.spawned().map((spawned) => [spawned.sessionID, spawned.command])).toEqual([[root, ROOT_SLEEP]])
    expect(world.spawned().some((spawned) => spawned.sessionID === childID)).toBe(false)
    expect(commandsOf(world, root)).toEqual([ROOT_SLEEP])
    expect(commandsOf(world, childID)).toEqual([CHILD_SLEEP])
  }),
)

seeded(
  "a heavy command runs niced under its command as written, a light one at the run's niceness, and a kill by a pattern that matches the server is refused",
  ({ seed, expect }) =>
    Effect.gen(function* () {
      const { world, root, held, tools } = yield* run(seed, POLICY_TASK)
      // The model's calls, and so the tool parts, show each command as the model wrote it: only the program that runs it changes.
      const [heavyCall, lightCall, killCall] = commandsOf(world, root)
      expect(heavyCall).toBe(HEAVY_NICE)
      expect(lightCall).toBe(LIGHT_NICE)
      expect(killCall).toBe(killByPattern(SPEC))
      const [heavy, light, kill, ...rest] = tools
      expect(rest).toEqual([])
      expect(heavy?.error).toBe(false)
      expect(light?.error).toBe(false)
      const [heavySpawn, lightSpawn, ...spawnedRest] = world.spawned()
      expect(spawnedRest).toEqual([])
      // The heavy line runs as written, through the one launcher, named as the shell it stands in for, at nice 10.
      expect(heavySpawn?.command).toBe(HEAVY_NICE)
      const launchers = [...held.launchers]
      expect(launchers).toHaveLength(1)
      const [path, text] = launchers[0] ?? ["", ""]
      expect(heavySpawn?.shell).toBe(path)
      expect(path.slice(path.lastIndexOf("/") + 1)).toMatch(/^(ba|z|da|k)?sh$/)
      expect(text).toContain(`exec nice -n 10 '${World.SHELL}' "$@"`)
      // The light line runs with the shell itself, at the run's niceness.
      expect(lightSpawn?.command).toBe(LIGHT_NICE)
      expect(lightSpawn?.shell).toBe(World.SHELL)
      expect(kill?.name).toBe("shell")
      expect(kill?.error).toBe(true)
      expect(kill?.output).toContain("would also kill the OpenCode server this session runs on")
    }),
)
