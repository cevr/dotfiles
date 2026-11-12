import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { describeHealth, final, Health, healthOf, recover, Recovery, type Listed, type Stage } from "./health.ts"
import { Placement } from "./placement.ts"

const POOL = "/d/opencode/cmd/pool"
const GUARD = "/d/opencode/cmd/guard"

const running = (path: string): Listed => ({ path: Option.some(path), failed: Option.none() })
const builtin: Listed = { path: Option.none(), failed: Option.none() }

describe("the health check after a restart", () => {
  test("is healthy when every configured plugin runs and the pool answers with accounts", () => {
    expect(healthOf({ configured: [POOL, GUARD], listed: [builtin, running(POOL), running(GUARD)], accounts: Option.some(3), providers: [], logins: [], placement: Option.none<Placement>() }, [])).toEqual(Health.Healthy())
  })

  test("names a configured plugin that failed to load, with its error", () => {
    const failed: Listed = { path: Option.some(POOL), failed: Option.some("Cannot find package '@dotfiles/opencode-status'") }
    expect(healthOf({ configured: [POOL, GUARD], listed: [failed, running(GUARD)], accounts: Option.none(), providers: [], logins: [], placement: Option.none<Placement>() }, [])).toEqual(
      Health.Sick({ plugin: "pool", cause: "Cannot find package '@dotfiles/opencode-status'", final: true }),
    )
  })

  test("names a configured plugin the service does not list", () => {
    expect(healthOf({ configured: [POOL, GUARD], listed: [running(POOL)], accounts: Option.some(1), providers: [], logins: [], placement: Option.none<Placement>() }, [])).toEqual(Health.Sick({ plugin: "guard", cause: "not loaded", final: false }))
  })

  test("is sick when the pool's status RPC does not answer, or answers with no accounts", () => {
    expect(healthOf({ configured: [POOL], listed: [running(POOL)], accounts: Option.none(), providers: [], logins: [], placement: Option.none<Placement>() }, [])).toEqual(Health.Sick({ plugin: "pool", cause: "the status RPC did not answer", final: false }))
    expect(healthOf({ configured: [POOL], listed: [running(POOL)], accounts: Option.some(0), providers: [], logins: [], placement: Option.none<Placement>() }, [])).toEqual(Health.Sick({ plugin: "pool", cause: "the status RPC answered with no accounts", final: false }))
  })
})

describe("the logins the configured models need, after a restart", () => {
  /** The workbox on 2026-11-12: every plugin runs, the pool lists OpenAI only, and the models are Anthropic's. */
  const openaiOnly = { configured: [POOL], listed: [running(POOL)], accounts: Option.some(1), providers: ["anthropic", "openai"], logins: ["openai", "opencode-go"], placement: Option.none<Placement>() }

  test("a provider the configured models use that lost its login in the restart is sick, naming the provider, and reads again", () => {
    const health = healthOf(openaiOnly, ["anthropic", "openai"])
    expect(health).toEqual(
      Health.Sick({ plugin: "login", final: false, cause: "no anthropic login after the restart, which had one before it: the pool lists no anthropic account and no credential is stored" }),
    )
    expect(describeHealth(health)).toContain("no anthropic login")
    expect(final(health)).toBe(false)
    expect(steps([health, health], true)).toEqual(["Reinstall", "RollBack"])
  })

  test("a provider that had no login before the restart either is reported, not rolled back", () => {
    const health = healthOf(openaiOnly, ["openai"])
    expect(health).toEqual(Health.Unsigned({ providers: ["anthropic"] }))
    expect(describeHealth(health)).toBe("healthy, but no anthropic login: sign in with opencode auth login")
    expect(final(health)).toBe(true)
    expect(recover("first", health, true)).toEqual(Recovery.Proven())
  })

  test("a login in the pool or a stored credential is enough, and a provider no configured model uses needs none", () => {
    expect(healthOf({ ...openaiOnly, logins: ["anthropic", "openai"] }, ["anthropic", "openai"])).toEqual(Health.Healthy())
    expect(healthOf({ ...openaiOnly, providers: ["openai"] }, ["anthropic", "openai"])).toEqual(Health.Healthy())
  })

  test("a plugin that failed to load is named before any login", () => {
    const failed: Listed = { path: Option.some(POOL), failed: Option.some("boom") }
    expect(healthOf({ ...openaiOnly, listed: [failed] }, ["anthropic"])).toEqual(Health.Sick({ plugin: "pool", cause: "boom", final: true }))
  })
})

describe("where the restarted service runs", () => {
  const ready = { configured: [POOL], listed: [running(POOL)], accounts: Option.some(1), providers: [], logins: [] }
  const herdr = "/user.slice/user-1000.slice/user@1000.service/app.slice/herdr-bite.service"

  test("in its own scope, or where no user systemd manages it, or with no answer (a build from before), it is healthy", () => {
    for (const placement of [
      Option.some(Placement.cases.Placed.make({ unit: "opencode-service-4242.scope" })),
      Option.some(Placement.cases.Unmanaged.make({ reason: "darwin has no user systemd" })),
      Option.none<Placement>(),
    ])
      expect(healthOf({ ...ready, placement }, [])).toEqual(Health.Healthy())
  })

  test("outside its scope under a user manager, it is sick for good, naming where it runs", () => {
    const health = healthOf({ ...ready, placement: Option.some(Placement.cases.Unplaced.make({ cgroup: herdr, cause: "Access denied" })) }, [])
    expect(health).toEqual(Health.Sick({ plugin: "placement", cause: `the service runs outside its scope, in ${herdr}: Access denied`, final: true }))
    expect(final(health)).toBe(true)
    expect(steps([health, health], true)).toEqual(["Reinstall", "RollBack"])
  })
})

const steps = (healths: ReadonlyArray<Health>, canRollBack: boolean): ReadonlyArray<Recovery["_tag"]> => {
  const stages: ReadonlyArray<Stage> = ["first", "reinstalled", "rolled-back"]
  return healths.map((health, index) => recover(stages[index] ?? "rolled-back", health, canRollBack)._tag)
}

describe("the recovery after a health check", () => {
  const sick = Health.Sick({ plugin: "pool", cause: "not loaded", final: false })

  test("a healthy restart proves the build", () => {
    expect(recover("first", Health.Healthy(), true)).toEqual(Recovery.Proven())
  })

  test("a sick restart reinstalls the dependencies and restarts once, and a healthy one then proves the build", () => {
    expect(steps([sick, Health.Healthy()], true)).toEqual(["Reinstall", "Proven"])
  })

  test("still sick after the reinstall, it rolls back to the last good build, and a healthy rollback ends there", () => {
    expect(steps([sick, sick, Health.Healthy()], true)).toEqual(["Reinstall", "RollBack", "RolledBack"])
  })

  test("a sick rollback, or no good build to go back to, gives up", () => {
    expect(steps([sick, sick, sick], true)).toEqual(["Reinstall", "RollBack", "GaveUp"])
    expect(steps([sick, sick], false)).toEqual(["Reinstall", "GaveUp"])
  })
})
