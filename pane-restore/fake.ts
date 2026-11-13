// A fake `herdr`, `hc` and `opencode` for the tests: each reads the world in
// $PANE_RESTORE_WORLD, answers the few calls pane-restore makes, records every
// call in the world's `calls`, and writes the world back (hc's labels change).
// The tests put shims named herdr, hc and opencode on PATH that run this file.
import { readFileSync, writeFileSync } from "node:fs"

export interface World {
  herdr: {
    /** `herdr api snapshot`'s `.result.snapshot`. */
    snapshot: unknown
    /** pane id → the foreground process argv lists `pane process-info` shows. */
    processes: Record<string, ReadonlyArray<ReadonlyArray<string>>>
    /** machine label → its own snapshot and processes, for `--machine`. */
    machines?: Record<string, { snapshot: unknown; processes: Record<string, ReadonlyArray<ReadonlyArray<string>>> }>
  }
  hc: { terminals: Array<{ address: string; state: string; labels: Record<string, string>; foreground: { name: string; argv: string[] } | null }> }
  opencode: { sessions: string[] }
  calls: string[][]
}

const path = process.env.PANE_RESTORE_WORLD ?? ""
const world = JSON.parse(readFileSync(path, "utf8")) as World
const [tool = "", ...args] = process.argv.slice(2)
world.calls.push([tool, ...args])
const save = () => writeFileSync(path, JSON.stringify(world, null, 2))
const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const fail = (message: string, code = 1) => {
  save()
  process.stderr.write(message + "\n")
  process.exit(code)
}

if (tool === "herdr") {
  let rest = args
  let host: { snapshot: unknown; processes: Record<string, ReadonlyArray<ReadonlyArray<string>>> } = world.herdr
  if (rest[0] === "--machine") {
    const machine = world.herdr.machines?.[rest[1] ?? ""]
    if (machine === undefined) fail(`{"error":{"code":"machine_not_found"}}`)
    host = machine!
    rest = rest.slice(2)
  } else if (rest[0] === "--session") rest = rest.slice(2)
  if (rest[0] === "api" && rest[1] === "snapshot") {
    out({ id: "cli:api:snapshot", result: { snapshot: host.snapshot } })
  } else if (rest[0] === "pane" && rest[1] === "process-info" && rest[2] === "--pane") {
    const pane = rest[3] ?? ""
    const argvs = host.processes[pane] ?? [["-zsh"]]
    out({
      id: "cli:pane:process_info",
      result: { process_info: { pane_id: pane, foreground_processes: argvs.map((argv, i) => ({ argv, pid: 100 + i, name: argv[0] })) } },
    })
  } else fail(`fake herdr: unexpected ${rest.join(" ")}`, 2)
} else if (tool === "hc") {
  if (args[0] === "ls") {
    out({ hidden_finished: 0, terminals: world.hc.terminals })
  } else if (args[0] === "label") {
    const terminal = world.hc.terminals.find((t) => t.address === args[1])
    if (terminal === undefined) fail(`{"error":{"kind":"not_found"}}`, 3)
    for (const pair of args.slice(2).filter((a) => a !== "--json")) {
      const at = pair.indexOf("=")
      const [key, value] = [pair.slice(0, at), pair.slice(at + 1)]
      if (value === "") delete terminal!.labels[key]
      else terminal!.labels[key] = value
    }
    out(terminal)
  } else fail(`fake hc: unexpected ${args.join(" ")}`, 2)
} else if (tool === "opencode") {
  const match = args[0] === "api" && args[1] === "GET" ? /^\/api\/session\/([^/]+)$/.exec(args[2] ?? "") : null
  if (match === null) fail(`fake opencode: unexpected ${args.join(" ")}`, 2)
  const id = match![1] ?? ""
  if (!world.opencode.sessions.includes(id)) fail(`{"_tag":"SessionNotFoundError","sessionID":"${id}"}\nHTTP 404 Not Found`)
  out({ data: { id } })
} else fail(`fake: unknown tool ${tool}`, 2)
save()
