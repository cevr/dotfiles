import { describe, expect, test } from "bun:test"
import { spawnSync, write } from "bun"
import { Effect, Option, Schema } from "effect"
import { describeHealth, Health, healthOf } from "../health.ts"
import { Service } from "../service.ts"
import type { Settings } from "../settings.ts"
import * as ServiceLayer from "./service.ts"

/** What the fake launcher answers from: the server config, the pool's status, the integration list. */
interface Answers {
  readonly config: unknown
  readonly pool: unknown
  readonly integrations: ReadonlyArray<{ readonly id: string; readonly connections: ReadonlyArray<unknown> }>
}

const POOL = "/d/opencode/cmd/pool"

/** A fixture's JSON text. */
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** The launcher (`opencode api <method> <path> …`): a shell script that answers each path from a file in `dir`. */
const launcherScript = (dir: string) =>
  [
    "#!/bin/sh",
    `case "$3" in`,
    `  /api/plugin) cat '${dir}/plugin.json' ;;`,
    `  /api/rpc/dotfiles-opencode.pool/status) cat '${dir}/pool.json' ;;`,
    `  /api/integration) cat '${dir}/integration.json' ;;`,
    `  *) echo "unknown $3" >&2; exit 1 ;;`,
    "esac",
    "",
  ].join("\n")

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

/** Writes the host's files: the answers, its server config and the launcher. */
const lay = (dir: string, answers: Answers) =>
  Effect.forEach(
    [
      ["plugin.json", json({ location: { directory: dir }, data: [{ source: { type: "local", path: POOL }, state: { status: "active" } }] })],
      ["pool.json", json({ output: answers.pool })],
      ["integration.json", json({ location: { directory: dir }, data: answers.integrations.map((each) => ({ ...each, name: each.id, methods: [] })) })],
      ["opencode.json", json(answers.config)],
      ["opencode", launcherScript(dir)],
    ] as const,
    ([name, text]) => Effect.promise(() => write(`${dir}/${name}`, text)),
    { discard: true },
  ).pipe(Effect.andThen(Effect.sync(() => void spawnSync(["chmod", "755", `${dir}/opencode`]))))

/**
 * `body` on a scratch host whose launcher answers from `answers`: the real service layer reads it
 * as it reads a service. The directory goes after.
 */
const onHost = <A, E>(answers: Answers, body: Effect.Effect<A, E, Service>) =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(() => spawnSync(["mktemp", "-d", "-t", "update-service"]).stdout.toString().trim()),
      (dir) => lay(dir, answers).pipe(Effect.andThen(body), Effect.provide(ServiceLayer.layer(settingsIn(dir), {}))),
      (dir) => Effect.sync(() => void spawnSync(["rm", "-rf", dir])),
    ),
  )

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
