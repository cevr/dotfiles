import { describe, expect, test } from "bun:test"
import { serve, spawnSync, write } from "bun"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { readText } from "../filestore/files.ts"
import { describeHealth, Health, healthOf } from "../health.ts"
import { Placement } from "../placement.ts"
import { Resident, Service } from "../service.ts"
import type { Settings } from "../settings.ts"
import * as ResidentLayer from "./resident.ts"
import * as ServiceLayer from "./service.ts"

/** What the fake service answers from: the server config, the pool's status, the integration list. */
interface Answers {
  readonly config: unknown
  readonly pool: unknown
  readonly integrations: ReadonlyArray<{ readonly id: string; readonly connections: ReadonlyArray<unknown> }>
  /** The update plugin's `placement` answer; with none, that RPC fails, as a build from before it does. */
  readonly placement?: unknown
  /** Whether the resident location's plugins are still activating: `/api/model` answers 503 and the plugin list is empty. */
  readonly activating?: boolean
}

const POOL = "/d/opencode/cmd/pool"

/** A fixture's JSON text. */
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** The settings of a host whose checkout, state and launcher are all in `dir`. */
const settingsIn = (dir: string): Settings => ({
  host: "test",
  checkout: dir,
  mode: "ff",
  fork: dir,
  bun: "bun",
  launcher: `${dir}/opencode`,
  resident: dir,
  record: `${dir}/installed.json`,
  config: [`${dir}/opencode.json`],
  notice: `${dir}/upstream.json`,
  state: dir,
})

/** The fake service's password: a fixture, no secret. */
const PASSWORD = "fixture-password"

/** A launcher that only records that it ran: a read must never go through `opencode api`. */
const recordingLauncher = (dir: string) => ["#!/bin/sh", `printf '%s\\n' "$*" >> '${dir}/launched'`, "exit 1", ""].join("\n")

/** Writes the host's files: its server config and the launcher. */
const lay = (dir: string, answers: Answers) =>
  Effect.forEach(
    [
      ["opencode.json", json(answers.config)],
      ["opencode", recordingLauncher(dir)],
    ] as const,
    ([name, text]) => Effect.promise(() => write(`${dir}/${name}`, text)),
    { discard: true },
  ).pipe(Effect.andThen(Effect.sync(() => void spawnSync(["chmod", "755", `${dir}/opencode`]))))

/** The fake service's answer to `path`, from `answers`, in the resident location `dir`. */
const answerOf = (dir: string, answers: Answers, path: string, method: string): Response => {
  const activating = answers.activating === true
  if (path === "/api/location") return Response.json({ directory: dir })
  if (path === "/api/model" && activating) return Response.json({ message: "Location plugins did not finish activating" }, { status: 503 })
  if (path === "/api/model") return Response.json({ data: [] })
  if (path === "/api/plugin") return Response.json({ location: { directory: dir }, data: [{ source: { type: "local", path: POOL }, state: { status: "active" } }].filter(() => !activating) })
  if (path === "/api/integration") return Response.json({ location: { directory: dir }, data: answers.integrations.map((each) => ({ ...each, name: each.id, methods: [] })) })
  if (method === "POST" && path === "/api/rpc/dotfiles-opencode.pool/status") return Response.json({ output: answers.pool })
  const placement = Option.fromUndefinedOr(answers.placement).pipe(Option.filter(() => method === "POST" && path === "/api/rpc/dotfiles-opencode.update/placement"))
  return Option.match(placement, { onSome: (output) => Response.json({ output }), onNone: () => Response.json({ code: "rpc.unavailable" }, { status: 400 }) })
}

/**
 * A stand-in for the registered service: it answers from `answers` in the resident location `dir`
 * only, and only with the registration's password, as the service does. It notes each path asked.
 */
const fakeService = (dir: string, answers: Answers, asked: Array<string>) =>
  serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname
      asked.push(path)
      if (request.headers.get("authorization") !== `Basic ${Base64.encode(`opencode:${PASSWORD}`)}`) return new Response("unauthorized", { status: 401 })
      if (request.headers.get("x-opencode-directory") !== encodeURIComponent(dir)) return new Response("another location", { status: 400 })
      return answerOf(dir, answers, path, request.method)
    },
  })

/** What a host's service and launcher were asked. */
interface Seen {
  /** The paths the service was asked, in order. */
  readonly asked: ReadonlyArray<string>
  /** What the launcher was asked; none when it never ran. */
  readonly launched: Option.Option<string>
}

/**
 * `body` on a scratch host whose registered service answers from `answers`: the real service layer
 * reads it as it reads the service. It answers how `body` ended and what the host saw; the service
 * and the directory go after.
 */
const onHostSeen = <A, E>(answers: Answers, body: Effect.Effect<A, E, Service | Resident>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const dir = spawnSync(["mktemp", "-d", "-t", "update-service"]).stdout.toString().trim()
      const asked: Array<string> = []
      return { dir, asked, server: fakeService(dir, answers, asked) }
    }),
    ({ dir, asked, server }) =>
      lay(dir, answers).pipe(
        Effect.andThen(Effect.promise(() => write(`${dir}/service.json`, json({ url: server.url.href, password: PASSWORD, pid: 1, id: "x", version: "test" })))),
        Effect.andThen(body.pipe(Effect.exit, Effect.provide(Layer.mergeAll(ServiceLayer.layer(settingsIn(dir), {}, `${dir}/service.json`), ResidentLayer.layer(dir, `${dir}/service.json`))))),
        Effect.flatMap((exit) => readText(`${dir}/launched`).pipe(Effect.map((launched) => ({ exit, seen: { asked: [...asked], launched } satisfies Seen })))),
      ),
    ({ dir, server }) => Effect.promise(() => server.stop(true)).pipe(Effect.andThen(Effect.sync(() => void spawnSync(["rm", "-rf", dir])))),
  )

/** `body` on a scratch host (`onHostSeen`), failing as `body` fails. */
const onHost = <A, E>(answers: Answers, body: Effect.Effect<A, E, Service | Resident>) => Effect.runPromise(onHostSeen(answers, body).pipe(Effect.flatMap(({ exit }) => exit)))

/** One case on a scratch host: `check` on how `body` ended and what the host saw. */
const seeing = <A, E>(answers: Answers, body: Effect.Effect<A, E, Service | Resident>, check: (exit: Exit.Exit<A, E>, seen: Seen) => void) =>
  Effect.runPromise(onHostSeen(answers, body).pipe(Effect.map(({ exit, seen }) => check(exit, seen))))

const read = Service.use((service) => service.read)
const logins = Service.use((service) => service.logins)

const account = { credentialID: "c" }
const credential = { type: "credential", id: "x", label: "l", method: "oauth" }

describe("the service layer's reading of a host's logins (a fake launcher, the real layer)", () => {
  test("M1: a provider named only by the default model is configured, so an OpenAI-only pool after losing it is sick", () =>
    onHost(
      { config: { model: "anthropic/claude-opus-5-5#medium", agents: { worker: { model: "openai/sol-6" } }, plugins: [POOL] }, pool: { openai: { accounts: [account] } }, integrations: [] },
      read.pipe(
        Effect.map((reading) => {
          expect(reading.providers).toContain("anthropic")
          expect(reading.logins).toEqual(["openai"])
          const health = healthOf(reading, ["anthropic", "openai"])
          expect(Health.$is("Sick")(health)).toBe(true)
          expect(describeHealth(health)).toContain("no anthropic login")
        }),
      ),
    ))

  test("M2: a provider logged in by a stored credential alone, with no pool account, has a login, after the restart and before it", () =>
    onHost(
      {
        config: { model: "anthropic/claude-opus-5-5", plugins: [POOL] },
        pool: { anthropic: { accounts: [] }, openai: { accounts: [account] } },
        integrations: [
          { id: "anthropic", connections: [credential] },
          { id: "groq", connections: [] },
        ],
      },
      Effect.all([read, logins]).pipe(
        Effect.map(([reading, before]) => {
          expect([...reading.logins].sort()).toEqual(["anthropic", "openai"])
          expect(healthOf(reading, ["anthropic"])).toEqual(Health.Healthy())
          expect([...before].sort()).toEqual(["anthropic", "openai"])
        }),
      ),
    ))

  test("a provider with neither a pool account nor a stored credential has no login", () =>
    onHost(
      { config: { model: "anthropic/claude-opus-5-5", plugins: [POOL] }, pool: { openai: { accounts: [account] } }, integrations: [{ id: "anthropic", connections: [] }] },
      read.pipe(
        Effect.map((reading) => {
          expect(reading.logins).toEqual(["openai"])
          expect(reading.accounts).toEqual(Option.some(1))
          expect(healthOf(reading, [])).toEqual(Health.Unsigned({ providers: ["anthropic"] }))
        }),
      ),
    ))
})

describe("the service layer's reads of a restarted service (install-health, workbox 2026-11-12)", () => {
  const host: Answers = { config: { model: "openai/sol-6", plugins: [POOL] }, pool: { openai: { accounts: [account] } }, integrations: [{ id: "openai", connections: [credential] }] }

  test("H1: every read goes to the registered service, never through `opencode api`, whose ensure stops a service that is slow to answer", () =>
    seeing(host, Effect.all([read, logins]), (exit, seen) => {
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(seen.launched).toEqual(Option.none())
      expect(seen.asked).toContain("/api/plugin")
    }))

  test("H2: a read boots the resident location and waits for its plugins before it lists them", () =>
    seeing(host, read, (exit, seen) => {
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(seen.asked.slice(0, 3)).toEqual(["/api/location", "/api/model", "/api/plugin"])
    }))

  test("H3: while the resident location's plugins activate, a read says so, and never reads as a plugin that did not load", () =>
    seeing({ ...host, activating: true }, read, (exit, seen) => {
      const failure = Exit.findErrorOption(exit)
      expect(Option.map(failure, (failed) => [failed.step, failed.message])).toEqual(Option.some(["wait for the resident location's plugins", "its plugins are still activating"]))
      expect(seen.asked).not.toContain("/api/plugin")
      expect(Exit.isFailure(exit) && !Cause.hasDies(exit.cause)).toBe(true)
    }))

  test("H4: with no service registered, a read is a failed step, which the health check reads again", () =>
    Effect.runPromise(
      read.pipe(
        Effect.provide(ServiceLayer.layer(settingsIn("/nonexistent/loop-probe-x"), {}, "/nonexistent/loop-probe-x/service.json")),
        Effect.exit,
        Effect.map((exit) => expect(Option.map(Exit.findErrorOption(exit), (failed) => failed.message)).toEqual(Option.some("no service is registered in /nonexistent/loop-probe-x/service.json"))),
      ),
    ))
})

describe("the service layer's reading of where the service runs (the update plugin's placement RPC)", () => {
  const host = { config: { model: "openai/sol-6", plugins: [POOL] }, pool: { openai: { accounts: [account] } }, integrations: [] }
  const herdr = "/user.slice/user-1000.slice/user@1000.service/app.slice/herdr-bite.service"

  test("in its own scope it is healthy", () =>
    onHost(
      { ...host, placement: Placement.cases.Placed.make({ unit: "opencode-service-4242.scope" }) },
      read.pipe(
        Effect.map((reading) => {
          expect(reading.placement).toEqual(Option.some(Placement.cases.Placed.make({ unit: "opencode-service-4242.scope" })))
          expect(healthOf(reading, [])).toEqual(Health.Healthy())
        }),
      ),
    ))

  test("outside its scope under a user manager it is sick for good", () =>
    onHost(
      { ...host, placement: Placement.cases.Unplaced.make({ cgroup: herdr, cause: "it was not placed" }) },
      read.pipe(Effect.map((reading) => expect(healthOf(reading, [])).toEqual(Health.Sick({ plugin: "placement", cause: `the service runs outside its scope, in ${herdr}: it was not placed`, final: true })))),
    ))

  test("a service whose plugin does not answer (a build from before the placement) reads none, and is healthy", () =>
    onHost(
      host,
      read.pipe(
        Effect.map((reading) => {
          expect(reading.placement).toEqual(Option.none())
          expect(healthOf(reading, [])).toEqual(Health.Healthy())
        }),
      ),
    ))
})

const loadResident = Resident.use((resident) => resident.load)

describe("the watchdog's ask for the resident location (the plugin's Resident layer)", () => {
  const host: Answers = { config: { model: "openai/sol-6", plugins: [POOL] }, pool: { openai: { accounts: [account] } }, integrations: [] }

  test("asks the registered service over HTTP, with its password, in the resident location, and never spawns `opencode api`", () =>
    seeing(host, loadResident, (exit, seen) => {
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(seen.asked).toEqual(["/api/location"])
      expect(seen.launched).toEqual(Option.none())
    }))

  test("with no service registered, the ask is a failed step, which the watchdog logs", () =>
    Effect.runPromise(
      loadResident.pipe(
        Effect.provide(ResidentLayer.layer("/nonexistent/loop-probe-x", "/nonexistent/loop-probe-x/service.json")),
        Effect.exit,
        Effect.map((exit) => expect(Option.map(Exit.findErrorOption(exit), (failed) => [failed.step, failed.message])).toEqual(Option.some(["load the resident location", "no service is registered in /nonexistent/loop-probe-x/service.json"]))),
      ),
    ))
})
