// accept: deep (30.0 s alone on a quiet host: two real OpenCode runs measured at 1-minute load 5–7 on 12 cores; each drives an image job, a real detached process, whose letter the server's poll finds)
// Public tool seam: real OpenCode, the real image and wake server plugins
// (the kernel's too in the kernel run), Prime and a scripted model, the image
// backends local fakes. scenarios/image.ts, `direct`: with an image model
// OpenCode offers (so its own image tool would be registered; without our
// plugin the first request lists `experimental_image_generate`: measured by a
// control run), the root loads the `image` skill and makes a subscription
// image; `kernel`: a kernel cell makes a paid one against the fake Images API.
// Each job's end wakes the idle session. What happened is read off the
// model's requests, the fakes' log, the transcripts and the saved files.
import { readScratchFileSync } from "./read-path.ts"
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"
import { hangGuard } from "./hang-guard.ts"

interface Request {
  readonly session: "root" | "title"
  readonly request: string
}
interface Seen {
  readonly route: "codex" | "paid"
  readonly path: string
  readonly authorized: boolean
  readonly model: string
}
interface Letter {
  readonly kind: string
  readonly progress: boolean
  readonly exitCode: number
}
interface Message {
  readonly type: string
  readonly metadata: Letter
}
interface Session {
  readonly messages: ReadonlyArray<Message>
}
interface Tool {
  readonly function: { readonly name: string; readonly description: string }
}
interface Body {
  readonly body: { readonly tools: ReadonlyArray<Tool> }
}

const FAKE_KEY = "sk-fake-image-scenario"
const PNG_MAGIC = "89504e470d0a1a0a"
const ROOT = fileURLToPath(new URL("..", import.meta.url))
const SKILL_FILE = join(ROOT, "mods", "image", "SKILL.md")
const SKILL = readFileSync(SKILL_FILE, "utf8")

const unescaped = (request: string) => request.replaceAll("\\n", "\n").replaceAll('\\"', '"')
const toolsIn = (request: string): ReadonlyArray<Tool> => {
  const parsed: Body = JSON.parse(request)
  return parsed.body.tools
}
const namesIn = (request: string) => toolsIn(request).map((tool) => tool.function.name)
const kernelIn = (request: string) => toolsIn(request).find((tool) => tool.function.name === "kernel")
const isLetter = (message: Message) => message.type === "synthetic" && message.metadata.kind === "job" && message.metadata.progress !== true

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/image.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("the image tool", () => {
  const kept = keptScratch(Boolean(fork), "image-")

  /** One run of the scenario in `mode`: its files' reader, the root's requests (raw and unescaped), the fakes' log and the job letters' exits. */
  const run = async (mode: "direct" | "kernel") => {
    const out = kept.dir("image-")
    const child = owned(["bunx", "opencode-drive", "run", "scenarios/image.ts"], {
      cwd: ROOT,
      env: { ...process.env, OPENAI_API_KEY: FAKE_KEY, SCENARIO_MODE: mode, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = await new Response(child.stdout).text()
    const errors = await new Response(child.stderr).text()
    const code = await child.exited
    expect(code, `${output}${errors}`.slice(-5000)).toBe(0)
    const read = (name: string) => readScratchFileSync(join(out, `image-${mode}-${name}`), "utf8")
    const requests: ReadonlyArray<Request> = JSON.parse(read("requests.json"))
    const rootRequests = requests.filter((request) => request.session === "root")
    const raw = rootRequests.map((request) => request.request)
    const sessions: ReadonlyArray<Session> = JSON.parse(read("transcripts.json"))
    const letters = sessions.flatMap((session) => session.messages).filter(isLetter)
    const exits = letters.map((message) => message.metadata.exitCode)
    const seen: ReadonlyArray<Seen> = JSON.parse(read("backends.json"))
    return { read, raw, root: raw.map(unescaped), seen, exits }
  }

  test(
    "replaces OpenCode's image tool while an image model is offered, adds the image skill, and a direct call makes a subscription image whose letter wakes the session",
    kept.test(async () => {
      const { read, raw, root, seen, exits } = await run("direct")
      // One image tool, ours, in every request, while OpenCode offers an image model.
      for (const request of raw) {
        expect(namesIn(request)).toContain("image")
        expect(namesIn(request)).not.toContain("experimental_image_generate")
      }
      expect(root.some((text) => text.includes('"id":"painter/painter"'))).toBe(true)
      // The skill: one `image`, ours, loaded with our text.
      const skills: ReadonlyArray<{ readonly id: string; readonly path: string }> = JSON.parse(read("skills.json"))
      const images = skills.filter((skill) => skill.id === "image")
      expect(images.map((skill) => skill.path)).toEqual([SKILL_FILE])
      const routes = SKILL.split("\n").find((line) => line.startsWith("- **Subscription (default).**"))
      expect(routes).toBeString()
      expect(root.some((text) => text.includes('<skill_content name="image">') && text.includes(`${routes}`))).toBe(true)
      // The receipt names the route; the letter the saved path and its size.
      expect(root.some((text) => /Image job j[0-9a-z]{6} started via subscription\. It saves to \S+\/art\/fox\.png\./.test(text))).toBe(true)
      expect(root.some((text) => /Saved via subscription:\n- \S+\/art\/fox\.png \(1x1\)/.test(text))).toBe(true)
      // The Codex fake alone, with the login's token and account; never the paid API.
      expect(seen.map((one) => [one.route, one.path, one.authorized])).toEqual([["codex", "/backend-api/codex/responses", true]])
      expect(JSON.parse(read("files.json"))).toEqual({ fox: PNG_MAGIC, logo: "missing" })
      expect(exits).toEqual([0])
      expect(read("done.txt")).toContain("Woke on fox.")
    }),
    hangGuard("generated-schedule"),
  )

  test(
    "a kernel cell reaches tools.image, and a paid call goes to the Images API alone with the key, its letter waking the session",
    kept.test(async () => {
      const { read, raw, root, seen, exits } = await run("kernel")
      // The kernel lists ours and not OpenCode's.
      const [first] = raw
      expect(first).toBeString()
      const catalog = kernelIn(`${first}`)?.function.description
      expect(catalog).toContain("- tools.image(input: { prompt: string")
      expect(catalog).not.toContain("experimental_image_generate")
      expect(root.some((text) => /Image job j[0-9a-z]{6} started via paid: gpt-image-2\.5-flare, quality auto, n 1\. It saves to \S+\/art\/logo\.png\./.test(text))).toBe(true)
      expect(root.some((text) => /Saved via paid: gpt-image-2\.5-flare, quality auto, n 1:\n- \S+\/art\/logo\.png \(1x1\)/.test(text))).toBe(true)
      expect(seen).toEqual([{ route: "paid", path: "/v1/images/generations", authorized: true, model: "gpt-image-2.5-flare" }])
      expect(JSON.parse(read("files.json"))).toEqual({ fox: "missing", logo: PNG_MAGIC })
      expect(exits).toEqual([0])
      // The key never reaches the model.
      expect(raw.some((text) => text.includes(FAKE_KEY))).toBe(false)
      expect(read("done.txt")).toContain("Woke on logo.")
    }),
    hangGuard("generated-schedule"),
  )
})
