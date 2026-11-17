// The plugin seam: the composition root on a stand-in host, over a catalog
// and jobs that record, and real request files in a scratch folder. It checks
// what OpenCode sees: one direct `image` tool, OpenCode's own image tool taken
// out, the `image` skill added with the file's text, and a call that asks the
// `image` permission with its route, keeps the request for the runner, starts
// one job and answers at once. tests/image.test.ts runs it in OpenCode.
// Its tests register through sim-tui/effect-test.ts, as cmd/work's do.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "bun"
import { readFileSync } from "node:fs"
import { Tool } from "@opencode/plugin/effect"
import { Array as Arr, Cause, Effect, Exit, Layer, Option, Predicate, Ref, Schema } from "effect"
import * as FileRequests from "@dotfiles/opencode-image/filesystem/requests"
import * as MemoryLaunch from "@dotfiles/opencode-image/memory/launch"
import { RequestJson } from "@dotfiles/opencode-image/request"
import { JobRefused } from "@dotfiles/opencode-image/service"
import { effectTest } from "../../sim-tui/effect-test.ts"
import ImagePlugin, { commandOf, make, SKILL_FILE } from "./server.ts"

type Host = Parameters<(typeof ImagePlugin)["effect"]>[0]

/** A value of a call's input as a model sends it: JSON, which the tool's schema decodes first. */
type Value = string | number | boolean | ReadonlyArray<Value> | { readonly [field: string]: Value }

/** A call's input. */
type Ask = { readonly [field: string]: Value }

/** What a call runs with. */
interface Call {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
}

/** A tool as the registry holds it. */
interface Registered {
  readonly name: string
  readonly description: string
  readonly options?: { readonly codemode?: boolean }
  readonly input: Schema.Decoder<Ask>
  readonly execute: (input: Ask, context: Call) => Effect.Effect<{ readonly content: ReadonlyArray<{ readonly text: string }> }, { readonly message: string }>
}

/** A skill as the registry holds it. */
interface Added {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly path: string
  readonly content: string
}

/** One permission the plugin asked. */
interface Asked {
  readonly action: string
  readonly resources: ReadonlyArray<string>
}

/** How the stand-ins answer: a deny rule, a refused job. */
interface Answers {
  readonly deny: boolean
  readonly refuse: boolean
}

const DIR = "/work/app"
const CALL: Call = { sessionID: "ses_root", agent: "build", messageID: "msg_1", id: "call_1" }
const SOL = { providerID: "openai", family: "gpt-sol", deprecated: false }
const ALLOW: Answers = { deny: false, refuse: false }
const TIMEOUT_MS = 10_000

/** A scratch folder, removed when the case's scope closes. */
const scratch = Effect.acquireRelease(
  Effect.sync(() => spawnSync(["mktemp", "-d", "-t", "image-seam"]).stdout.toString().trim()),
  (made) => Effect.sync(() => void spawnSync(["rm", "-rf", made])),
)

const decodeRequest = Schema.decodeUnknownSync(RequestJson)

/** The stand-in host's parts, before it is checked to be the plugin context in every part the plugin reads. */
const stubOf = (outputs: string, answers: Answers, tools: Map<string, Registered | "builtin">, skills: Array<Added>, asked: Array<Asked>) => ({
  options: { outputs },
  location: { directory: DIR },
  tool: {
    transform: (callback: (editor: { readonly add: (tool: Registered) => void; readonly remove: (id: string) => void }) => void) =>
      Effect.sync(() => {
        callback({ add: (tool) => void tools.set(tool.name, tool), remove: (id) => void tools.delete(id) })
        return { dispose: Effect.void }
      }),
  },
  skill: {
    transform: (callback: (editor: { readonly add: (skill: Added) => void }) => void) =>
      Effect.sync(() => {
        callback({ add: (skill) => void skills.push(skill) })
        return { dispose: Effect.void }
      }),
  },
  permission: {
    assert: (input: Asked) =>
      Effect.andThen(
        Effect.sync(() => void asked.push({ action: input.action, resources: input.resources })),
        Effect.when(Effect.fail(new Tool.Error({ message: "denied by rule" })), Effect.succeed(answers.deny)),
      ),
  },
})

/** The plugin started on a stand-in host whose registry holds OpenCode's image tool beside another. */
const start = (answers: Answers) =>
  Effect.gen(function* () {
    const outputs = yield* scratch
    const started = yield* MemoryLaunch.started
    const asked: Array<Asked> = []
    const skills: Array<Added> = []
    const tools = new Map<string, Registered | "builtin">([["shell", "builtin"], ["experimental_image_generate", "builtin"]])
    const stub = stubOf(outputs, answers, tools, skills, asked)
    const isHost = (value: typeof stub): value is typeof stub & Host => Predicate.hasProperty(value, "tool") && Predicate.hasProperty(value, "skill")
    if (!isHost(stub)) return yield* Effect.die("the stand-in host lacks a part the plugin reads")
    const jobs = MemoryLaunch.jobs(started, () =>
      Effect.andThen(Effect.when(Effect.fail(new JobRefused({ reason: "a session may run at most 20 jobs" })), Effect.succeed(answers.refuse)), Effect.succeed("jabc123")),
    )
    yield* make(() =>
      Layer.mergeAll(
        MemoryLaunch.catalog([
          { ...SOL, modelID: "gpt-6-sol", released: 1 },
          { ...SOL, modelID: "gpt-6.1-sol", released: 2 },
        ]),
        FileRequests.layer(`${outputs}/.requests`),
        jobs,
      ),
    ).effect(stub)

    const registered = Effect.fromOption(Option.filter(Option.fromUndefinedOr(tools.get("image")), (tool): tool is Registered => tool !== "builtin"))

    /** One call: its text, or `error: <message>`; its input decoded by the tool's own schema first, as the host does. */
    const call = Effect.fn("ImageServerTest.call")(function* (input: Ask) {
      const tool = yield* registered
      const decoded = yield* Schema.decodeUnknownEffect(tool.input)(input)
      const exit = yield* Effect.exit(tool.execute(decoded, CALL))
      return Exit.match(exit, {
        onSuccess: (done) => done.content.map((item) => item.text).join("\n"),
        onFailure: (cause) => `error: ${cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error.message).join("; ")}`,
      })
    })
    return { outputs, started, asked, skills, tools, registered, call }
  })

describe("the image plugin", () => {
  effectTest(
    "adds one direct image tool and takes OpenCode's image tool out, leaving the other built-in tools",
    Effect.scoped(
      Effect.gen(function* () {
        const plugin = yield* start(ALLOW)
        const tool = yield* plugin.registered
        expect([...plugin.tools.keys()]).toEqual(["shell", "image"])
        expect(tool.options).toEqual({ codemode: false })
        expect(tool.description).toContain("ChatGPT subscription")
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "adds the image skill with the skill file's name, description and text",
    Effect.scoped(
      Effect.gen(function* () {
        const plugin = yield* start(ALLOW)
        const file = readFileSync(SKILL_FILE, "utf8")
        expect(plugin.skills).toHaveLength(1)
        const skill = yield* Effect.fromOption(Arr.head(plugin.skills))
        expect(skill).toMatchObject({ id: "image", name: "image", path: SKILL_FILE })
        expect(skill.description).toStartWith("Make or edit images with the `image` tool.")
        expect(file.endsWith(skill.content)).toBe(true)
        expect(skill.content).not.toContain("description:")
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "a subscription call asks the image permission with its route, keeps the request and starts one job, answering at once",
    Effect.scoped(
      Effect.gen(function* () {
        const plugin = yield* start(ALLOW)
        const answer = yield* plugin.call({ prompt: "A red fox", size: "1536x1024", images: ["ref.png"] })
        expect(plugin.asked).toEqual([{ action: "image", resources: ["subscription"] }])
        const jobs = yield* Ref.get(plugin.started)
        expect(jobs).toHaveLength(1)
        const job = yield* Effect.fromOption(Arr.head(jobs))
        expect(job).toMatchObject({ sessionID: "ses_root", cwd: DIR })
        expect(job.note).toContain('Image (subscription): "A red fox"')
        const request = decodeRequest(readFileSync(job.file, "utf8"))
        expect(request.models).toEqual(["gpt-6.1-sol", "gpt-6-sol"])
        expect(request.images).toEqual([`${DIR}/ref.png`])
        expect(request.path).toStartWith(`${plugin.outputs}/ses_root/a-red-fox-`)
        expect(request.path).toMatch(/\/a-red-fox-[0-9a-z]{6}\.png$/u)
        expect(job.file).toMatch(/\/\.requests\/[0-9a-z]{6}\.json$/u)
        expect(Option.isNone(request.paid)).toBe(true)
        expect(answer).toContain("Image job jabc123 started via subscription.")
        expect(answer).toContain(`It saves to ${request.path}.`)
        expect(answer).toContain("do not poll")
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "a paid call names the paid route in the permission and the answer",
    Effect.scoped(
      Effect.gen(function* () {
        const plugin = yield* start(ALLOW)
        const answer = yield* plugin.call({ prompt: "A logo", path: "out/logo.png", paid: { model: "flare", quality: "high" } })
        expect(plugin.asked).toEqual([{ action: "image", resources: ["paid: gpt-image-2.5-flare, quality high, n 1"] }])
        expect(answer).toContain("started via paid: gpt-image-2.5-flare, quality high, n 1. It saves to /work/app/out/logo.png.")
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "a denied permission, a broken input or a refused job starts nothing and leaves no request behind",
    Effect.scoped(
      Effect.gen(function* () {
        const denied = yield* start({ deny: true, refuse: false })
        expect(yield* denied.call({ prompt: "A fox", paid: { model: "sunburst" } })).toBe("error: denied by rule")
        expect(yield* Ref.get(denied.started)).toEqual([])
        const broken = yield* start(ALLOW)
        expect(yield* broken.call({ prompt: "  " })).toBe("error: [INVALID_INPUT] Missing prompt: say what to create or change.")
        expect(broken.asked).toEqual([])
        const refused = yield* start({ deny: false, refuse: true })
        expect(yield* refused.call({ prompt: "A fox" })).toBe("error: The image job did not start: a session may run at most 20 jobs")
        expect(spawnSync(["ls", "-A", `${refused.outputs}/.requests`]).stdout.toString().trim()).toBe("")
      }),
    ),
    TIMEOUT_MS,
  )

  test("the job's command runs the runner on the request file, quoted, with the backends the options name", () => {
    const command = commandOf({ bun: "/opt/bun", codexOrigin: "http://127.0.0.1:9/codex" })("/tmp/it's/r.json")
    expect(command).toStartWith("'/opt/bun' '")
    expect(command).toContain("/cmd/image/run.ts' '/tmp/it'\\''s/r.json' --codex-origin 'http://127.0.0.1:9/codex'")
    expect(command).not.toContain("--openai-origin")
  })
})
