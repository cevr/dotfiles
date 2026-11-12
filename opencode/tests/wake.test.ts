// Public UI seam: real OpenCode, the real wake server plugin, Prime (whose
// dock counts the wakes) and a scripted model. scenarios/wake.ts drives an
// alarm, a notice, a monitor, a cancel and a plugin reload;
// scenarios/wake-downtime.ts stops the server past an alarm's time and starts
// it again. What fired is read off the frames, the
// model's requests and the transcripts.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { scratch } from "./scratch.ts"

/** The frame's lines, without the sidebar's column. */
const lines = (frame: string): ReadonlyArray<string> => frame.split("\n").map((line) => line.slice(0, 108).trim())
/** The dock's wake item: Prime's dock line after the subagents and shells, or undefined without one. */
const trayOf = (frame: string) => {
  const dock = lines(frame).find((line) => /^◆ \d+ subagents?  ·  \d+ shells?/.test(line))
  const item = dock?.split("  ·  ").slice(2).join("  ·  ")
  return item ? item : undefined
}

interface Request {
  readonly session?: "root" | "title"
  readonly at: number
  readonly request: string
}
interface Message {
  readonly type?: string
  readonly text?: string
  readonly metadata?: { readonly source?: string; readonly kind?: string; readonly mode?: string; readonly firedAt?: number; readonly lateMs?: number }
}
interface Session {
  readonly id: string
  readonly parentID?: string | null
  readonly messages: ReadonlyArray<Message>
}

/** What the model read: the JSON-escaped request, unescaped enough to read its strings. */
const unescaped = (request: string) => request.replaceAll("\\n", "\n").replaceAll('\\"', '"')
const count = (text: string, part: string) => text.split(part).length - 1
const wakes = (sessions: ReadonlyArray<Session>) =>
  sessions.flatMap((session) => session.messages.filter((message) => message.type === "synthetic" && message.metadata?.source === "wake"))
const textOf = (message: Message) => message.text ?? ""

const scenario = async (out: string, args: ReadonlyArray<string>, label: string, env: (out: string) => Record<string, string> = () => ({})) => {
  const child = owned(["bunx", "opencode-drive", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media"), ...env(out) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timeout = join(out, `${label}-timeout.txt`)
  if (code !== 0) throw new Error(`${label} scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)
  return { stdout, read: (name: string) => readFileSync(join(out, `${label}-${name}`), "utf8") }
}

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/wake.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("wakes", () => {
  test("an alarm wakes the idle session, a notice waits for the next turn, a monitor wakes on its match, a cancel holds, and a reload fires once", async () => {
    using out = scratch("wake-")
    const { stdout, read } = await scenario(out.path, ["run", "scenarios/wake.ts"], "wake")
    expect(stdout).toMatch(/screenshot: .*wake-pending\.png/)
    const requests: ReadonlyArray<Request> = JSON.parse(read("requests.json"))
    const root = requests.filter((request) => request.session === "root").map((request) => ({ ...request, text: unescaped(request.request) }))
    const sessions: ReadonlyArray<Session> = JSON.parse(read("transcripts.json"))
    const fired = wakes(sessions)

    // The alarm: the tray counts it while it waits; its fire is one notice row, and the model answers it.
    expect(trayOf(read("pending.txt"))).toMatch(/^1 wake$/)
    const alpha = lines(read("alpha.txt"))
    expect(alpha.some((line) => /^◈ wake w[0-9a-z]+ · ALPHA: check that the build finished$/.test(line))).toBe(true)
    expect(alpha).toContain("Woke on alpha.")
    expect(trayOf(read("alpha.txt"))).toBeUndefined()
    // The letter: what fired, when it was set and due, the note verbatim; on time, so it does not say late.
    const woken = root.find((request) => request.text.includes("Note: ALPHA"))
    expect(woken?.text).toMatch(/⏰ Wake w[0-9a-z]+ fired: the alarm you set at \d{4}-\d\d-\d\dT[\d:.]+Z, due \d{4}-\d\d-\d\dT[\d:.]+Z\.\nNote: ALPHA: check that the build finished/)
    expect(woken?.text).not.toContain("no OpenCode server was running")

    // The notice: drawn at its time and counted in the tray, but it starts no turn; the next turn reads it.
    expect(lines(read("notice.txt")).some((line) => /^◈ notice w[0-9a-z]+ · BETA: glance at the deploy$/.test(line))).toBe(true)
    expect(trayOf(read("notice.txt"))).toBe("1 notice")
    const sawBeta = root.findIndex((request) => request.text.includes("Note: BETA"))
    expect(sawBeta).toBeGreaterThan(0)
    expect(root[sawBeta]?.text).toContain("step-after-notice")
    expect(root[sawBeta]?.text).toContain("This is a notice: it started no turn, and you are reading it at your next one.")
    expect(lines(read("after-notice.txt"))).toContain("Saw the beta notice.")
    expect(trayOf(read("after-notice.txt"))).toBeUndefined()

    // The monitor: counted with its deadline while it polls, then a wake with the match, the note and the last output.
    expect(trayOf(read("monitor-pending.txt"))).toMatch(/^1 monitor$/)
    expect(lines(read("gamma.txt")).some((line) => /^◈ monitor w[0-9a-z]+ matched · GAMMA: the service is up$/.test(line))).toBe(true)
    const gamma = root.find((request) => request.text.includes("Note: GAMMA"))?.text ?? ""
    expect(gamma).toMatch(/⏰ Monitor w[0-9a-z]+ matched: `.*` printed a match for \/\^READY\$\/ after \d+ checks\./)
    expect(gamma).toContain("Note: GAMMA: the service is up\nLast output (exit 0):\nREADY")
    expect(lines(read("gamma.txt"))).toContain("Woke on gamma.")

    // The cancel: the alarm is gone, and past its time it never fired.
    expect(lines(read("cancelled.txt"))).toContain("Delta cancelled.")
    expect(root.some((request) => request.text.includes("Note: DELTA"))).toBe(false)
    expect(fired.some((message) => textOf(message).includes("DELTA"))).toBe(false)

    // The reload: the plugin activated twice, the second time before the alarm was due, and the alarm fired once, from the second.
    expect(trayOf(read("reload-pending.txt"))).toMatch(/^1 wake$/)
    const revisions = readFileSync(join(out.path, "wake-plugin.log"), "utf8").trim().split("\n")
    expect(revisions.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual(["rev 1", "rev 2"])
    const reloadedAt = Number(revisions[1]?.split(" ")[2])
    const epsilon = fired.filter((message) => textOf(message).includes("EPSILON"))
    expect(epsilon).toHaveLength(1)
    expect(epsilon[0]?.metadata?.firedAt ?? 0).toBeGreaterThan(reloadedAt)
    expect(count(root.at(-1)?.text ?? "", "Note: EPSILON")).toBe(1)
    expect(lines(read("epsilon.txt"))).toContain("Woke on epsilon.")

    // One message per fire, each a wake or a notice as set.
    expect(fired.map((message) => `${message.metadata?.kind}/${message.metadata?.mode}`)).toEqual(["alarm/wake", "alarm/notify", "monitor/wake", "alarm/wake"])
  }, 240_000)

  test("an alarm due while no server ran fires when one starts, and says it went late", async () => {
    const fork = process.env.OPENCODE_DEV ?? ""
    using out = scratch("wake-downtime-")
    const { stdout, read } = await scenario(out.path, ["start", "--name", `wake-downtime-${process.pid}`, "--dev", fork, "--script", "scenarios/wake-downtime.ts"], "wake-downtime", (out) => ({
      // A file, so the restarted server finds the session and its wake.
      OPENCODE_DRIVE_DB: join(out, "opencode.db"),
    }))
    expect(stdout).toMatch(/screenshot: .*wake-downtime-late\.png/)
    expect(trayOf(read("pending.txt"))).toMatch(/^1 wake$/)

    const stopped = Number(read("stopped.txt"))
    const started = Number(read("started.txt"))
    const requests: ReadonlyArray<Request> = JSON.parse(read("requests.json"))
    const late = requests.map((request) => ({ ...request, text: unescaped(request.request) })).find((request) => request.text.includes("Note: ZETA"))
    // The fire came after the start, and its letter says how late and why.
    expect(late?.at ?? 0).toBeGreaterThan(started)
    expect(late?.text).toMatch(/It fired \d+m late: no OpenCode server was running at \d{4}-\d\d-\d\dT[\d:.]+Z, so it went when one started\.\nNote: ZETA: look again after the outage/)
    expect(requests.some((request) => request.at > stopped && request.at < started)).toBe(false)

    const frame = lines(read("late.txt"))
    expect(frame.some((line) => /^◈ wake w[0-9a-z]+ · \d+m late · ZETA: look again after the outage$/.test(line))).toBe(true)
    expect(frame).toContain("Woke late on zeta.")
    expect(trayOf(read("late.txt"))).toBeUndefined()

    const sessions: ReadonlyArray<Session> = JSON.parse(read("transcripts.json"))
    const fired = wakes(sessions)
    expect(fired).toHaveLength(1)
    expect(fired[0]?.metadata?.lateMs ?? 0).toBeGreaterThanOrEqual(60_000)
  }, 300_000)
})
