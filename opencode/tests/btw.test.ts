// Public UI seam: real OpenCode with the btw TUI plugin (cmd/btw) and the
// fork's own /btw off (scenarios/btw.ts). While the session waits on a shell
// call, /btw forks it and the pane answers beside the transcript, then a
// follow-up; the session finishes its own turn untouched; Esc closes the pane,
// /btw alone opens the same fork again, and ctrl+s brings its newest answer
// back into the session once, which answers it. The model requests show the
// fork reusing the session's cached prefix.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface Message {
  readonly role: string
  readonly content?: unknown
}
interface Request {
  readonly route: string
  readonly request: { readonly body: { readonly messages: Array<Message>; readonly tools?: unknown; readonly prompt_cache_key?: string } }
}

const textOf = (message: Message) =>
  typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part: unknown) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : "")).join("")
      : ""

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/btw.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("/btw", () => {
  test("answers a side question in a pane while the session works, follows up, reopens, and brings the answer back once", async () => {
    const out = mkdtempSync(join(tmpdir(), "btw-pane-"))
    const child = Bun.spawn(["bunx", "opencode-drive", "run", "scenarios/btw.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(`btw scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(join(out, "btw-timeout.txt")) ? readFileSync(join(out, "btw-timeout.txt"), "utf8") : ""}`)
    const frame = (name: string) => readFileSync(join(out, `${name}.txt`), "utf8")

    // The pane answers beside the session, which is still running its shell call.
    const pane = frame("btw-pane")
    // The hint's start can sit under the host's startup toast, so match its end.
    for (const text of ["btw: Why is the check slow?", "Why is the check slow?", "It sleeps on purpose, to hold the session busy.", "ask › a follow-up", "ctrl+s bring back · esc close", "Running sleep 600 && echo checked"])
      expect(pane).toContain(text)
    const followup = frame("btw-followup")
    for (const text of ["It sleeps on purpose, to hold the session busy.", "Which command?", "The sleep in the shell call."]) expect(followup).toContain(text)

    // Closed: the session's transcript holds its own turn and nothing of the fork's.
    const closed = frame("btw-closed")
    expect(closed).toContain("The check passed.")
    for (const text of ["ask ›", "Why is the check slow?", "It sleeps on purpose", "Which command?", "The sleep in the shell call."]) expect(closed).not.toContain(text)

    // /btw alone opens the same fork, both answers in it.
    const reopened = frame("btw-reopened")
    for (const text of ["btw: Why is the check slow?", "It sleeps on purpose, to hold the session busy.", "The sleep in the shell call.", "ctrl+s bring back"])
      expect(reopened).toContain(text)

    // ctrl+s: one notice row naming the question, and the session's answer to it.
    const brought = frame("btw-brought-back")
    expect(brought).toContain("◈ btw · Which command?")
    expect(brought).toContain("Noted the side answer.")
    expect(brought).not.toContain("ask ›")

    const requests: ReadonlyArray<Request> = readFileSync(join(out, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    const routes = requests.map((each) => each.route)
    expect(routes.filter((route) => route !== "title")).toEqual(["first", "check", "side", "follow", "check-done", "brought"])
    const body = (route: string) => {
      const found = requests.find((each) => each.route === route)
      if (found === undefined) throw new Error(`no ${route} request`)
      return found.request.body
    }
    const check = body("check")
    const side = body("side")
    const follow = body("follow")

    // The fork's request is the session's request with the note and the question after it:
    // the same system prompt, tools, history and cache key, so the provider reads its cache.
    expect(side.messages.slice(0, check.messages.length)).toEqual(check.messages)
    expect(side.tools).toEqual(check.tools)
    expect(side.prompt_cache_key).toBeDefined()
    expect(side.prompt_cache_key).toBe(check.prompt_cache_key)
    const [note = "", question] = side.messages.slice(check.messages.length).map(textOf)
    expect(note).toStartWith("A side question, asked in a fork of session ses_")
    expect(question).toBe("Why is the check slow?")
    // The follow-up extends the fork's request, the note sent once.
    expect(follow.messages.slice(0, side.messages.length)).toEqual(side.messages)
    expect(follow.messages.slice(side.messages.length).map(textOf)).toEqual(["It sleeps on purpose, to hold the session busy.", "Which command?"])
    expect(follow.messages.filter((message) => textOf(message) === note)).toHaveLength(1)

    // The bring-back went into the session once, carrying the newest answer, after its own turn.
    const back = body("brought").messages
    const notices = back.filter((message) => textOf(message).startsWith("The user brought back an answer from a /btw side question"))
    expect(notices).toHaveLength(1)
    expect(textOf(notices[0] ?? { role: "user" })).toContain("Question:\nWhich command?\n\nAnswer:\nThe sleep in the shell call.")
    expect(back.map(textOf)).toContain("The check passed.")
    for (const message of back) expect(textOf(message)).not.toBe(note)
    console.log(`btw artifacts: ${out}`)
  }, 150_000)
})
