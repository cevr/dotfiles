import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { describeHealth, Health, healthOf } from "../health.ts"
import { Service } from "../service.ts"
import type { Settings } from "../settings.ts"
import * as ServiceLayer from "./service.ts"

/** What the fake launcher answers: the service's plugin list, the pool's status, the integration list. */
interface Answers {
  readonly config: unknown
  readonly pool: unknown
  readonly integrations: ReadonlyArray<{ readonly id: string; readonly connections: ReadonlyArray<unknown> }>
}

const POOL = "/d/opencode/cmd/pool"

/**
 * A host whose launcher (`opencode api …`) is a shell script answering from files, and whose
 * server config is `answers.config`: the real service layer reads them as it reads a service.
 */
const onHost = <A>(answers: Answers, body: Effect.Effect<A, unknown, Service>): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "update-service-"))
  const at = (name: string, value: unknown) => {
    writeFileSync(join(dir, name), JSON.stringify(value))
    return join(dir, name)
  }
  at("plugin.json", { location: { directory: dir }, data: [{ source: { type: "local", path: POOL }, state: { status: "active" } }] })
  at("pool.json", { output: answers.pool })
  at("integration.json", { location: { directory: dir }, data: answers.integrations.map((each) => ({ ...each, name: each.id, methods: [] })) })
  const config = at("opencode.json", answers.config)
  const launcher = join(dir, "opencode")
  writeFileSync(
    launcher,
    [
      "#!/bin/sh",
      `case "$3" in`,
      `  /api/plugin) cat '${dir}/plugin.json' ;;`,
      `  /api/rpc/dotfiles-opencode.pool/status) cat '${dir}/pool.json' ;;`,
      `  /api/integration) cat '${dir}/integration.json' ;;`,
      `  *) echo "unknown $3" >&2; exit 1 ;;`,
      "esac",
      "",
    ].join("\n"),
  )
  chmodSync(launcher, 0o755)
  const settings: Settings = {
    host: "test",
    checkout: dir,
    mode: "ff",
    fork: dir,
    bun: process.execPath,
    launcher,
    resident: dir,
    record: join(dir, "installed.json"),
    config: [config],
    notice: join(dir, "upstream.json"),
    state: dir,
  }
  return Effect.runPromise(body.pipe(Effect.provide(ServiceLayer.layer(settings, {})))).finally(() => rmSync(dir, { recursive: true, force: true }))
}

const read = Service.use((service) => service.read)
const logins = Service.use((service) => service.logins)

const account = { credentialID: "c" }
const credential = { type: "credential", id: "x", label: "l", method: "oauth" }

describe("the service layer's reading of a host's logins (a fake launcher, the real layer)", () => {
  test("M1: a provider named only by the default model is configured, so an OpenAI-only pool after losing it is sick", async () => {
    const reading = await onHost(
      { config: { model: "anthropic/claude-opus-5-5#medium", agents: { worker: { model: "openai/sol-6" } }, plugins: [POOL] }, pool: { openai: { accounts: [account] } }, integrations: [] },
      read,
    )
    expect(reading.providers).toContain("anthropic")
    expect(reading.logins).toEqual(["openai"])
    const health = healthOf(reading, ["anthropic", "openai"])
    expect(Health.$is("Sick")(health)).toBe(true)
    expect(describeHealth(health)).toContain("no anthropic login")
  })

  test("M2: a provider logged in by a stored credential alone, with no pool account, has a login, read and before", async () => {
    const answers: Answers = {
      config: { model: "anthropic/claude-opus-5-5", plugins: [POOL] },
      pool: { anthropic: { accounts: [] }, openai: { accounts: [account] } },
      integrations: [
        { id: "anthropic", connections: [credential] },
        { id: "groq", connections: [] },
      ],
    }
    const reading = await onHost(answers, read)
    expect([...reading.logins].sort()).toEqual(["anthropic", "openai"])
    expect(healthOf(reading, ["anthropic"])).toEqual(Health.Healthy())
    expect([...(await onHost(answers, logins))].sort()).toEqual(["anthropic", "openai"])
  })

  test("a provider with neither a pool account nor a stored credential has no login", async () => {
    const reading = await onHost(
      { config: { model: "anthropic/claude-opus-5-5", plugins: [POOL] }, pool: { openai: { accounts: [account] } }, integrations: [{ id: "anthropic", connections: [] }] },
      read,
    )
    expect(reading.logins).toEqual(["openai"])
    expect(reading.accounts).toEqual(Option.some(1))
    expect(healthOf(reading, [])).toEqual(Health.Unsigned({ providers: ["anthropic"] }))
  })
})
