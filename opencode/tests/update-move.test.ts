// accept: deep (28.8 s alone on a quiet host: 1-minute load 16.5–19.1 on 12 cores; it starts a service and a TUI from source on a scripted model and holds two turns of 8 s each before the move)
// An open TUI moves onto a build that differs from its own only in the dotfiles half, and only at its quiet moment.
//
// The version names the fork commit and the dotfiles commit (`<base>-prime.<fork 8>.<dotfiles 8>`,
// mods/update/process/pin.ts `versionOf`), so an update of the plugins alone is a new build that every open TUI
// moves onto, as a fork update always was. The fork's move (packages/tui/src/context/update-restart.tsx) holds
// while the session on screen runs a root turn or holds a prompt queued behind it, and carries the composer's draft
// into the new process. Its own tests cover each hold one by one (packages/tui/test/update-restart.test.tsx); this
// one runs them together on real OpenCode.
//
// The fork runs from source in a scratch HOME on a scripted model, on the reconnect files' platform
// (tests/reconnect/host.ts). Its version is a compile-time define: the service, and every process started from
// the test's environment, run as build B (`BUN_OPTIONS=--define=OPENCODE_VERSION:"B"`), and the TUI starts as
// build A by a define on its own command line, which wins over the environment's. A and B share the fork half and
// differ in the dotfiles half. The install record names B, by the service's own command, and lists A as
// superseded, as a stage and its handoff leave it. Then, in the TUI on A: a root turn runs, a prompt waits in the
// queue behind it, and a draft sits in the composer. No move while that turn runs, none while the queued prompt's
// turn runs; once it ends, the TUI moves onto B, on the same session, the draft in the new process's composer.
import { describe } from "bun:test"
import { Data, Deferred, Effect, FileSystem, Option, Schedule, Schema, Stream } from "effect"
import { expect, it } from "effect-bun-test"
import { Base64 } from "effect/encoding"
import { HttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { hostCall, serve } from "../testbeds/gamut/pty-host.ts"
import { ENV, listen, Platform, run } from "./reconnect/host.ts"
import { forkRuns, keptScratch } from "./scratch.ts"
import { freePort, ready, type Service } from "./service.ts"
import { hangGuard } from "./hang-guard.ts"

/** The TUI's build and the installed one: one fork commit, two dotfiles commits. */
const OWN = "2.2.7-prime.f0f0f0f0.d1d1d1d1"
const INSTALLED = "2.2.7-prime.f0f0f0f0.d2d2d2d2"
/** Seconds without input before a move, in the scratch TUI's config (default 10). */
const IDLE_SECONDS = 1
/** How long each held phase is watched for a move it must not start: the idle wait, the 3 s notice and a margin. */
const HELD_MS = 8_000
const MOVED = `OpenCode moved onto ${INSTALLED}`
const READY = "say ready"
const FIRST = "the first hold"
const QUEUED = "then the second hold"
const DRAFT = "draft kept across the move"
const LOOK_MS = 250
const LOOK = Schedule.spaced(`${LOOK_MS} millis`)

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** As much of the fork's client as the test uses; the fork is found at run time, so it is typed here. */
interface Client {
  readonly session: {
    readonly create: (input: { location: { directory: string }; title: string }) => Promise<{ readonly id: string }>
    readonly prompt: (input: { sessionID: string; text: string }) => Promise<object>
  }
}
interface ClientModule {
  readonly OpenCode: { readonly make: (options: { baseUrl: string; headers: { readonly authorization: string } }) => Client }
}

class TimedOut extends Data.TaggedError("TimedOut")<{ readonly message: string }> {}
class NotYet<A> extends Data.TaggedError("NotYet")<{ readonly last: A }> {}

/** Reads `read` until `done` holds, every 250 ms for `ms`; past it, fails with `label` of the last read. */
const until = <A, R>(read: Effect.Effect<A, never, R>, done: (value: A) => boolean, label: (last: A) => string, ms: number) =>
  read.pipe(
    Effect.filterOrFail(done, (seen) => new NotYet({ last: seen })),
    Effect.retry({ schedule: LOOK.pipe(Schedule.upTo({ duration: `${ms} millis` })), times: Math.ceil(ms / LOOK_MS) + 1 }),
    Effect.mapError((error) => new TimedOut({ message: label(error.last) })),
  )

/** Runs `check` every 250 ms for `ms`: a state that must hold all along, not just at the end. */
const throughout = <E>(check: Effect.Effect<void, E>, ms: number) => check.pipe(Effect.repeat(LOOK.pipe(Schedule.upTo({ duration: `${ms} millis` }))), Effect.asVoid)

/** A message's content as the scripted model reads it: its text, or its parts' texts. */
const decodeText = Schema.decodeUnknownOption(Schema.String)
const decodeParts = Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })))
const ChatBody = Schema.Struct({ messages: Schema.optionalKey(Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.optionalKey(Schema.Unknown) }))) })
type Message = NonNullable<(typeof ChatBody.Type)["messages"]>[number]
const decodeBody = Schema.decodeUnknownOption(ChatBody)
const textOf = (message: Message) =>
  Option.getOrElse(
    Option.orElse(decodeText(message.content), () => Option.map(decodeParts(message.content), (parts) => parts.flatMap((part) => Option.toArray(Option.fromUndefinedOr(part.text))).join(""))),
    () => "",
  )

const EVENT_STREAM = { contentType: "text/event-stream", headers: { "cache-control": "no-cache" } }
interface Delta {
  readonly role?: string
  readonly content?: string
}
const chunk = (delta: Delta, finish: Option.Option<"stop">) => ({ id: "sim", object: "chat.completion.chunk", created: 0, model: "sim", choices: [{ index: 0, delta, finish_reason: Option.getOrNull(finish) }] })
const USAGE = { id: "sim", object: "chat.completion.chunk", created: 0, model: "sim", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }
const event = (value: ReturnType<typeof chunk> | typeof USAGE) => `data: ${toJson(value)}\n\n`
const encoder = new TextEncoder()
const STOP = [event(chunk({}, Option.some("stop"))), event(USAGE), "data: [DONE]\n\n"]

/**
 * The scripted model: a title request gets a title; a turn whose last message says `hold` streams until
 * `release` ends every held turn; anything else answers `ok`. `prompts` gets each turn's last message.
 */
const simModel = Effect.gen(function* () {
  const prompts: Array<string> = []
  const gates: Array<Deferred.Deferred<void>> = []
  const answers = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) return HttpServerResponse.text("not found", { status: 404 })
    const body = decodeBody(yield* request.json.pipe(Effect.orElseSucceed(() => ({}))))
    const messages = Option.getOrElse(Option.flatMap(body, (decoded) => Option.fromUndefinedOr(decoded.messages)), () => [])
    const titling = messages.some((message) => message.role === "system" && textOf(message).includes("You name conversations"))
    const last = messages.slice(-1).map(textOf).join("")
    if (titling) return HttpServerResponse.text([event(chunk({ role: "assistant", content: "Move" }, Option.none())), ...STOP].join(""), EVENT_STREAM)
    prompts.push(last)
    if (!last.includes("hold")) return HttpServerResponse.text([event(chunk({ role: "assistant", content: "ok" }, Option.none())), ...STOP].join(""), EVENT_STREAM)
    const gate = yield* Deferred.make<void>()
    gates.push(gate)
    const head = Stream.make(encoder.encode(event(chunk({ role: "assistant", content: "holding" }, Option.none()))))
    const tail = Stream.fromEffect(Deferred.await(gate)).pipe(Stream.flatMap(() => Stream.make(encoder.encode(STOP.join("")))))
    return HttpServerResponse.stream(Stream.concat(head, tail), EVENT_STREAM)
  })
  const server = yield* Effect.acquireRelease(listen(0, answers), (listener) => listener.stop)
  /** Ends every turn held now. */
  const release = Effect.suspend(() => Effect.forEach(gates.splice(0), (gate) => Deferred.succeed(gate, void 0), { discard: true }))
  return { port: server.port, prompts, release }
})

const authorization = (service: Service) => ({ authorization: `Basic ${Base64.encode(`opencode:${service.password}`)}` })
const Info = Schema.Struct({ version: Schema.String, command: Schema.NonEmptyArray(Schema.String) })
const decodeInfo = Schema.decodeUnknownEffect(Info)

describe.skipIf(!forkRuns)("an open TUI moves onto a build that differs only in its dotfiles half, at its quiet moment", () => {
  const kept = keptScratch(forkRuns, "update-move-")
  it.scopedLive.layer(Platform)(
    "no move while a root turn runs or a prompt waits queued behind it; then the move, with the draft",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { fork, path } = yield* ENV
        // A short folder name: the terminal host's socket lives in it, and a socket path has at most 104 bytes on macOS.
        const root = kept.dir("m")
        const home = `${root}/home`
        const state = `${home}/.local/state`
        for (const dir of ["work", "home", "home/.config", "home/.config/opencode", "home/.local", "home/.local/state", "home/.local/state/opencode"]) yield* fs.makeDirectory(`${root}/${dir}`)
        const work = yield* fs.realPath(`${root}/work`)
        const launch = forkLaunch(fork, process.execPath)
        const env = {
          PATH: path,
          HOME: home,
          TERM: "xterm-256color",
          HERDR_ENV: "1",
          XDG_CONFIG_HOME: `${home}/.config`,
          XDG_DATA_HOME: `${home}/.local/share`,
          XDG_STATE_HOME: state,
          XDG_CACHE_HOME: `${home}/.cache`,
          OPENCODE_DB: `${root}/opencode.db`,
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_FILEWATCHER: "1",
          ...launch.env,
          // Every process the environment starts is build B; the transpiler cache off, so no file compiled under one define serves the other.
          BUN_OPTIONS: `${launch.env.BUN_OPTIONS} --define=OPENCODE_VERSION:"${INSTALLED}"`,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        }
        const serviceFile = `${state}/opencode/service-local.json`
        const opencode = (...args: ReadonlyArray<string>) => run([...launch.base, ...args], work, env)

        const sim = yield* simModel
        yield* fs.writeFileString(
          `${home}/.config/opencode/opencode.json`,
          toJson({
            model: "sim/sim-model",
            providers: {
              sim: {
                name: "Sim",
                package: "@opencode/ai/providers/openai-compatible",
                settings: { baseURL: `http://127.0.0.1:${sim.port}/v1`, apiKey: "sim-key" },
                models: { "sim-model": { name: "Sim", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128_000, output: 16_000 } } },
              },
            },
          }),
        )
        yield* fs.writeFileString(`${home}/.config/opencode/cli.json`, toJson({ session: { sidebar: "hide" }, update: { idle: IDLE_SECONDS } }))
        expect(yield* opencode("service", "set", "port", String(freePort()))).toMatchObject({ code: 0 })
        const registered = fs.exists(serviceFile).pipe(Effect.orElseSucceed(() => false))
        const started = yield* Effect.acquireRelease(opencode("service", "start"), () => Effect.asVoid(Effect.when(opencode("service", "stop"), registered)))
        expect(started).toMatchObject({ code: 0 })
        const service = yield* Effect.promise(() => ready(serviceFile, () => `the service (${started.err.slice(-500)})`))

        // The install, as a stage and its handoff leave it: the service runs B, the record names B by the
        // service's own command and lists A (and an older build of the old format) as builds B superseded.
        const info = yield* HttpClient.get(new URL("/api/info", service.url), { headers: authorization(service) }).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(decodeInfo),
          Effect.orDie,
        )
        expect(info.version).toBe(INSTALLED)
        yield* fs.writeFileString(`${state}/opencode/installed.json`, toJson({ version: INSTALLED, command: info.command, previous: ["2.2.7-prime.f0f0f0f0", OWN] }))

        const module = yield* Effect.promise((): Promise<ClientModule> => import(`${fork}/packages/client/src/promise/index.ts`))
        const client = module.OpenCode.make({ baseUrl: service.url, headers: authorization(service) })
        const session = yield* Effect.promise(() => client.session.create({ location: { directory: work }, title: "Move session" }))
        yield* Effect.promise(() => client.session.prompt({ sessionID: session.id, text: READY }))
        const asked = (text: string) => Effect.sync(() => sim.prompts.some((prompt) => prompt.includes(text)))
        yield* until(asked(READY), Boolean, () => "the first prompt never reached the model", 30_000)

        // The TUI on A: its own define, on its command line, wins over the environment's B.
        const socket = `${root}/tui.sock`
        const [bun = "", entry = ""] = launch.base
        yield* Effect.acquireRelease(
          Effect.sync(() => serve({ socket, cwd: work, command: [bun, `--define=OPENCODE_VERSION:"${OWN}"`, entry, "-s", session.id], env: { ...env, OPENCODE_PASSWORD: service.password }, cols: 140, rows: 40 })),
          (served) => Effect.promise(() => served.stop()),
        )
        yield* until(fs.exists(socket).pipe(Effect.orElseSucceed(() => false)), Boolean, () => "the terminal host", 10_000)
        const screen = Effect.promise(() => hostCall(socket, { op: "read", scope: "screen" })).pipe(Effect.map((read) => read.rows.join("\n")))
        yield* until(screen, (text) => text.includes(READY), (last) => `the TUI never showed the session:\n${last}`, 60_000)

        // A root turn runs; a prompt waits in the queue behind it (leader, then Enter); a draft sits in the composer.
        yield* Effect.promise(() => client.session.prompt({ sessionID: session.id, text: FIRST }))
        yield* until(asked(FIRST), Boolean, () => "the first turn never reached the model", 30_000)
        yield* Effect.promise(() => hostCall(socket, { op: "type", text: QUEUED }))
        yield* Effect.promise(() => hostCall(socket, { op: "keys", names: ["ctrl+x", "enter"] }))
        yield* until(screen, (text) => text.includes(QUEUED), (last) => `the queued prompt never showed:\n${last}`, 15_000)
        yield* Effect.promise(() => hostCall(socket, { op: "type", text: DRAFT }))
        yield* until(screen, (text) => text.includes(DRAFT), (last) => `the draft never showed:\n${last}`, 15_000)

        // B shows on this screen only in the move's notice and the arrival's (no plugin draws the service's build
        // here); a toast wraps its text, so the build's name alone is matched.
        const stays = (when: string) => screen.pipe(Effect.map((text) => expect(text.includes(INSTALLED), `the TUI moved while ${when}:\n${text}`).toBe(false)))
        yield* throughout(stays("a root turn ran"), HELD_MS)
        expect(yield* asked(QUEUED)).toBe(false)

        // The first turn ends: the queued prompt is delivered and its own turn holds. Still no move.
        yield* sim.release
        yield* until(asked(QUEUED), Boolean, () => "the queued prompt never reached the model", 30_000)
        yield* throughout(stays("the queued prompt's turn ran"), HELD_MS)

        // That turn ends: the TUI moves onto B, on the same session, the draft in the new process's composer.
        yield* sim.release
        const arrived = yield* until(screen, (text) => text.includes(MOVED), (last) => `the TUI never arrived on ${INSTALLED}:\n${last}`, 90_000)
        expect(arrived).toContain(`from ${OWN})`)
        yield* until(screen, (text) => text.includes(READY) && text.includes(DRAFT), (last) => `the new process lost the session or the draft:\n${last}`, 30_000)
      }),
    hangGuard("generated-schedule"),
  )
})
