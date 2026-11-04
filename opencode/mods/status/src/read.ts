import { readFile, readdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { homedir } from "node:os"
import type { AgentCall, Run, Unit } from "./protocol.ts"

/** Fold by owner AND call id: tool ids can repeat across scripted/live sessions.
 * A trailing partial append is ignored until the next refresh. A background
 * tool's `done:running` means its child still owns work, not a finished agent.
 */
export async function readAgents(file: string): Promise<readonly AgentCall[]> {
  let text: string
  try { text = await readFile(file, "utf8") } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const calls = new Map<string, AgentCall>()
  for (const line of text.split("\n")) {
    let row: Record<string, unknown>
    try { row = JSON.parse(line) } catch { continue }
    if (!row || typeof row !== "object") continue
    if (typeof row.sessionID !== "string" || typeof row.callID !== "string") continue
    const key = `${row.sessionID}/${row.callID}`
    if (row.kind === "call" && typeof row.agent === "string") calls.set(key, {
      sessionID: row.sessionID, callID: row.callID, agent: row.agent,
      ...(typeof row.description === "string" ? { description: row.description } : {}),
      ...(typeof row.child === "string" ? { child: row.child } : {}),
    })
    if (row.kind === "done") {
      const call = calls.get(key)
      if (call) calls.set(key, { ...call, ...(typeof row.child === "string" ? { child: row.child } : {}), ...(typeof row.status === "string" ? { status: row.status } : {}) })
    }
  }
  return [...calls.values()].filter((call) => call.status !== "completed" && call.status !== "error")
}

async function command(argv: string[], cwd?: string) {
  const run = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(20_000) })
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(`${argv[0]} failed: ${err.trim()}`)
  return out
}

/** Exactly the status mod's source: shared status.ts derives states from unit
 * log.md transitions. Never read a hand-maintained state column in plan.md.
 */
export async function readRuns(cwd: string, script = join(homedir(), ".claude/skills/orchestrate/scripts/status.ts")): Promise<readonly Run[]> {
  let top = cwd
  try {
    const common = (await command(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)).trim()
    top = basename(common) === ".git" ? dirname(common) : cwd
  } catch { return [] }
  const root = join(top, "tmp/orchestrate")
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const output = await command([process.execPath, script, join(root, entry.name)])
    const units: Unit[] = []
    for (const line of output.split("\n")) {
      const [, unit, state, round, since] = line.split("|").map((part) => part.trim())
      if (!unit || unit === "Unit" || unit.startsWith("-") || !state) continue
      units.push({ unit, state, round: round ?? "", since: since ?? "" })
    }
    return { name: entry.name, units }
  }))
}
