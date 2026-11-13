// Session mail between two real OpenCode servers on this machine, standing in
// for the Mac and the workbox: each is the fork's own `serve --service` in its
// own scratch HOME, with the mail plugin listening on its own loopback port
// (where a host listens on its Tailscale address), on one scripted model.
//
// What only real servers show stays here: the workbox invites with the pair
// command run as its own process and the Mac joins, over Bun's server and
// fetch; then a message by id crosses from one service to the other, and
// neither service's password reaches a model. The listing, the letter's
// header, the answer coming back and the unpaired host's refusal are
// cmd/mail/mail-peer.sim.test.ts's (tests/parity/mail.json).
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { owned } from "./owned.ts"
import { ready, type Service } from "./service.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/mail-peer.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const ROOT = join(import.meta.dir, "..")
const TIMEOUT_MS = 150_000

interface Host {
  readonly name: string
  readonly base: string
  readonly env: Record<string, string>
  readonly service: Service
  readonly pairs: string
  readonly stderr: () => string
  readonly stop: () => Promise<void>
}

/** As much of the fork's client as the test uses; the fork is found at run time, so it is typed here. */
interface Client {
  readonly session: {
    readonly create: (input: { location: { directory: string }; title?: string }) => Promise<{ readonly id: string }>
    readonly prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
  }
  readonly experimental: { readonly session: { readonly wait: (input: { sessionID: string }) => Promise<void> } }
}
interface ClientModule {
  readonly OpenCode: { readonly make: (options: { baseUrl: string; headers: Record<string, string> }) => Client }
}

interface ChatMessage {
  readonly role: string
  readonly content?: unknown
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: unknown) => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "")).join("")
      : ""

type Reply = { readonly text: string } | { readonly tool: string; readonly input: Record<string, unknown> }

/**
 * The scripted model both hosts use, by the conversation's last message: `mail-send <id> <text>` messages that id,
 * and anything else (a tool's result, a letter) closes the turn.
 */
const reply = (messages: ReadonlyArray<ChatMessage>): Reply => {
  const system = messages.filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n")
  if (system.includes("You name conversations")) return { text: "Mail" }
  const last = messages.at(-1)
  const text = textOf(last?.content)
  if (last?.role === "tool") return { text: "done" }
  const send = /mail-send (ses_[A-Za-z0-9]+) (\S+)/.exec(text)
  if (send !== null) return { tool: "message", input: { to: send[1], text: send[2] } }
  return { text: "ok" }
}

const events = (answer: Reply, id: string): string => {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({ id, object: "chat.completion.chunk", created: 0, model: "sim", choices: [{ index: 0, delta, finish_reason: finish }] })
  const list: Array<unknown> = [chunk({ role: "assistant", content: "" }, null)]
  if ("text" in answer) list.push(chunk({ content: answer.text }, null), chunk({}, "stop"))
  else
    list.push(
      chunk({ tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: answer.tool, arguments: JSON.stringify(answer.input) } }] }, null),
      chunk({}, "tool_calls"),
    )
  list.push({ id, object: "chat.completion.chunk", created: 0, model: "sim", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })
  return [...list.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join("")
}

/** Every request the model got, whole, as JSON text. */
const seen: Array<string> = []
const sim = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const body = (await request.json()) as { readonly messages?: ReadonlyArray<ChatMessage> }
    seen.push(JSON.stringify(body.messages ?? []))
    return new Response(events(reply(body.messages ?? []), `sim${seen.length}`), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },
})

const until = async <A>(read: () => Promise<A> | A, done: (value: A) => boolean, label: () => string, ms = 60_000): Promise<A> => {
  const deadline = Date.now() + ms
  let last = await read()
  while (!done(last)) {
    if (Date.now() > deadline) return expect.unreachable(`${label()}: still ${JSON.stringify(last)}`)
    await Bun.sleep(250)
    last = await read()
  }
  return last
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

describe.skipIf(!fork)("session mail between two paired OpenCode servers (real pair command, scripted model)", () => {
  const kept = keptScratch(Boolean(fork), "mail-peer-", true)
  const hosts: Array<Host> = []
  afterAll(async () => {
    await Promise.all(hosts.map((host) => host.stop()))
    sim.stop(true)
    kept.done()
  })

  /** Start the fork's service in a scratch HOME with the mail plugin listening on a loopback port, and wait for its service file and its listener. */
  const start = async (name: string): Promise<Host> => {
    const base = kept.dir(`${name}-`)
    const home = join(base, "home")
    for (const dir of ["work", "home", "home/.config", "home/.config/opencode", "home/.local", "home/.local/state"]) mkdirSync(join(base, dir))
    writeFileSync(
      join(home, ".config/opencode/opencode.json"),
      JSON.stringify({
        model: "sim/sim-model",
        providers: {
          sim: {
            name: "Sim",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${sim.port}/v1`, apiKey: "sim-key" },
            models: { "sim-model": { name: "Sim", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128_000, output: 16_000 } } },
          },
        },
        plugins: [{ package: join(ROOT, "cmd/mail"), options: { listen: { hostname: "127.0.0.1", port: 0 } } }],
      }),
    )
    const launch = forkLaunch(fork ?? "", process.execPath)
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OPENCODE_DB: join(base, "opencode.db"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    }
    const child = owned([...launch.base, "serve", "--service", "--port", "0"], { cwd: join(base, "work"), env: { ...env, ...launch.env }, stdout: "ignore", stderr: "pipe" })
    let stderr = ""
    void (async () => {
      for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk)
    })()
    // A build from source is the "local" channel: its service file is service-local.json. The file is written
    // when the service listens, before it boots, and it answers 503 until then: wait until it can serve.
    const service = await ready(join(home, ".local/state/opencode/service-local.json"), () => `${name}'s service (${stderr.slice(-500)})`)
    const pairs = join(home, ".local/state/opencode-mail/pairs.json")
    const host: Host = {
      name,
      base,
      env,
      service,
      pairs,
      stderr: () => stderr,
      stop: async () => {
        child.kill()
        await child.exited
      },
    }
    hosts.push(host)
    return host
  }

  /** The plugin loads with the server's first instance (a session made in a directory); its listener records its address once bound. */
  const listening = (host: Host) =>
    until(
      () => (readJson(host.pairs) as { url?: string } | undefined)?.url,
      (value) => typeof value === "string",
      () => `${host.name}'s mail listener (${host.stderr().slice(-500)})`,
    )

  const pairCommand = async (host: Host, ...args: ReadonlyArray<string>) => {
    const child = owned([process.execPath, join(ROOT, "cmd/mail/pair.ts"), ...args, "--name", host.name], { cwd: ROOT, env: host.env, stdout: "pipe", stderr: "pipe" })
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, out, err }
  }

  // Real only: two `serve --service` processes, the pair command as its own process, Bun's server and fetch.
  test(
    "two real services pair with the pair command run as its own process, and a message by id crosses between them",
    kept.test(async () => {
      const [mac, workbox] = await Promise.all([start("mac"), start("workbox")])
      const { OpenCode } = (await import(join(fork ?? "", "packages/client/src/promise/index.ts"))) as ClientModule
      const client = (host: Host) => OpenCode.make({ baseUrl: host.service.url, headers: { authorization: `Basic ${btoa(`opencode:${host.service.password}`)}` } })
      const [macClient, workboxClient] = [client(mac), client(workbox)]
      const target = await workboxClient.session.create({ location: { directory: join(workbox.base, "work") }, title: "Workbox PR" })
      const sender = await macClient.session.create({ location: { directory: join(mac.base, "work") }, title: "Mac main" })
      // A first turn on each loads the plugins.
      await Promise.all([
        macClient.session.prompt({ sessionID: sender.id, text: "warm-up" }).then(() => macClient.experimental.session.wait({ sessionID: sender.id })),
        workboxClient.session.prompt({ sessionID: target.id, text: "warm-up" }).then(() => workboxClient.experimental.session.wait({ sessionID: target.id })),
      ])
      await Promise.all([listening(mac), listening(workbox)])

      const invite = await pairCommand(workbox, "invite")
      expect(invite.code).toBe(0)
      const join_ = /pair\.ts join (\S+) (\S+)/.exec(invite.out)
      expect(join_).not.toBeNull()
      const joined = await pairCommand(mac, "join", join_?.[1] ?? "", join_?.[2] ?? "")
      expect([joined.code, joined.out.trim()]).toEqual([0, `Paired: this host is mac; workbox is at ${join_?.[1]}.`])

      // The Mac messages the workbox session by id; it crosses to the other service and wakes it.
      await macClient.session.prompt({ sessionID: sender.id, text: `mail-send ${target.id} ping-from-mac` })
      await macClient.experimental.session.wait({ sessionID: sender.id })
      expect(seen.some((request) => request.includes(`Delivered to session \\"Workbox PR\\" (${target.id}) on host workbox.`))).toBe(true)
      const letter = await until(
        () => seen.find((request) => request.includes("ping-from-mac") && request.includes("✉ Message from session")),
        (value) => value !== undefined,
        () => `the workbox's letter (${workbox.stderr().slice(-500)})`,
      )
      expect(letter).toContain(`(${sender.id}) on host mac`)

      // Neither host's secret or server password shows in what the models read.
      const secret = (readJson(mac.pairs) as { peers: Record<string, { secret: string }> }).peers.workbox?.secret ?? ""
      expect(secret.length).toBeGreaterThan(20)
      for (const hidden of [secret, mac.service.password, workbox.service.password]) expect(seen.join("\n")).not.toContain(hidden)
    }),
    TIMEOUT_MS,
  )
})
