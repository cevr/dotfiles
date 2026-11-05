// Public seam: real OpenCode, the real mail plugin, three sessions on scripted
// models (scenarios/mail.ts). A pings an idle B, which wakes and answers A at
// the id its letter names; then A steers a message into C while C runs, and
// C's next model request carries it. The model requests, the transcripts and
// A's frame are read off the run.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface Request {
  readonly session: "A" | "B" | "C" | "title"
  readonly request: string
}
interface Part {
  readonly type?: string
  readonly name?: string
  readonly text?: string
  readonly state?: { readonly content?: ReadonlyArray<{ readonly text?: string }> }
}
interface Message {
  readonly type?: string
  readonly text?: string
  readonly description?: string
  readonly metadata?: { readonly source?: string; readonly from?: { readonly sessionID?: string; readonly title?: string } }
  readonly content?: ReadonlyArray<Part> | string
}
interface Transcript {
  readonly id: string
  readonly title: string
  readonly messages: ReadonlyArray<Message>
}

const parts = (message: Message): ReadonlyArray<Part> => (typeof message.content === "string" ? [] : (message.content ?? []))

/** The text the `message` tool answered with, in order. */
const receipts = (transcript: Transcript): ReadonlyArray<string> =>
  transcript.messages
    .flatMap(parts)
    .flatMap((part) => (part.type === "tool" && part.name === "message" ? (part.state?.content ?? []).map((item) => item.text ?? "") : []))

const letters = (transcript: Transcript): ReadonlyArray<Message> => transcript.messages.filter((message) => message.metadata?.source === "mail")

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/mail.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("session mail", () => {
  test("a message wakes an idle session, which answers its sender, and a running session reads one at its next step", async () => {
    const out = mkdtempSync(join(tmpdir(), "mail-"))
    const child = Bun.spawn(["bunx", "opencode-drive", "run", "scenarios/mail.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = join(out, "mail-timeout.txt")
    if (code !== 0) throw new Error(`mail scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)

    const requests: ReadonlyArray<Request> = JSON.parse(readFileSync(join(out, "mail-requests.json"), "utf8"))
    const transcripts: ReadonlyArray<Transcript> = JSON.parse(readFileSync(join(out, "mail-transcripts.json"), "utf8"))
    const session = (title: string) => {
      const found = transcripts.find((transcript) => transcript.title === title)
      if (found === undefined) throw new Error(`no session titled ${title}`)
      return found
    }
    const [a, b, c] = [session("Mail A"), session("Mail B"), session("Mail C")]
    const of = (name: Request["session"]) => requests.filter((request) => request.session === name).map((request) => request.request)

    // A listed the sessions: B and C by id and title, its own marked.
    const listing = JSON.stringify(a.messages)
    expect(listing).toContain(`${b.id} \\"Mail B\\" · idle`)
    expect(listing).toContain(`${c.id} \\"Mail C\\"`)
    expect(listing).toMatch(new RegExp(`${a.id} \\\\"Mail A\\\\" · running[^"]*\\(you\\)`))

    // B, idle, was woken by the ping: its first request is the letter, under a header naming A and how to answer.
    const [bFirst] = of("B")
    expect(bFirst).toContain(`✉ Message from session \\"Mail A\\" (${a.id}), sent with the message tool. It is not the user speaking.`)
    expect(bFirst).toContain(`To answer, call the message tool with { \\"to\\": \\"${a.id}\\", \\"text\\": \\"…\\" }; answer only if it asks for something.`)
    expect(bFirst).toContain("mail-ping: answer me")
    expect(receipts(a)[0]).toBe(`Delivered to session "Mail B" (${b.id}). It was idle and is now reading it.`)
    expect(letters(b).map((letter) => [letter.description, letter.metadata?.from])).toEqual([
      ["✉ from Mail A · mail-ping: answer me", { sessionID: a.id, title: "Mail A" }],
    ])

    // B answered at that id; A, idle by then, woke and read it.
    expect(receipts(b)).toEqual([`Delivered to session "Mail A" (${a.id}). It was idle and is now reading it.`])
    expect(letters(a).map((letter) => letter.description)).toEqual(["✉ from Mail B · mail-pong"])
    const texts = a.messages.flatMap(parts).flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
    expect(texts.slice(0, 2)).toEqual(["A sent the ping", "A got the pong"])

    // The transcript draws the letter as one notice row, between A's turns.
    const exchange = readFileSync(join(out, "mail-exchange.txt"), "utf8")
    const row = exchange.indexOf("◈ ✉ from Mail B · mail-pong")
    expect(row).toBeGreaterThan(exchange.indexOf("A sent the ping"))
    expect(row).toBeLessThan(exchange.indexOf("A got the pong"))
    expect(exchange).not.toContain("It is not the user speaking")

    // C was running when A wrote: the receipt says so, and C's next request, after its held one, carries the letter.
    expect(receipts(a)[1]).toBe(`Delivered to session "Mail C" (${c.id}). It is running and reads it at its next step.`)
    const [cHeld, cNext] = of("C")
    expect(cHeld).not.toContain("mail-steer-text")
    expect(cNext).toContain("mail-steer-text")
    expect(cNext).toContain(`✉ Message from session \\"Mail A\\" (${a.id})`)
    expect(of("C")).toHaveLength(2)
    expect(JSON.stringify(c.messages)).toContain("C read the steer")
    console.log(`Mail artifacts: ${out}`)
  }, 150_000)
})
