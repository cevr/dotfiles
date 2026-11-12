import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Health, healthOf, recover, Recovery, type Listed, type Stage } from "./health.ts"

const POOL = "/d/opencode/cmd/pool"
const GUARD = "/d/opencode/cmd/guard"

const running = (path: string): Listed => ({ path: Option.some(path), failed: Option.none() })
const builtin: Listed = { path: Option.none(), failed: Option.none() }

describe("the health check after a restart", () => {
  test("is healthy when every configured plugin runs and the pool answers with accounts", () => {
    expect(healthOf({ configured: [POOL, GUARD], listed: [builtin, running(POOL), running(GUARD)], accounts: Option.some(3) })).toEqual(Health.Healthy())
  })

  test("names a configured plugin that failed to load, with its error", () => {
    const failed: Listed = { path: Option.some(POOL), failed: Option.some("Cannot find package '@dotfiles/opencode-status'") }
    expect(healthOf({ configured: [POOL, GUARD], listed: [failed, running(GUARD)], accounts: Option.none() })).toEqual(
      Health.Sick({ plugin: "pool", cause: "Cannot find package '@dotfiles/opencode-status'", final: true }),
    )
  })

  test("names a configured plugin the service does not list", () => {
    expect(healthOf({ configured: [POOL, GUARD], listed: [running(POOL)], accounts: Option.some(1) })).toEqual(Health.Sick({ plugin: "guard", cause: "not loaded", final: false }))
  })

  test("is sick when the pool's status RPC does not answer, or answers with no accounts", () => {
    expect(healthOf({ configured: [POOL], listed: [running(POOL)], accounts: Option.none() })).toEqual(Health.Sick({ plugin: "pool", cause: "the status RPC did not answer", final: false }))
    expect(healthOf({ configured: [POOL], listed: [running(POOL)], accounts: Option.some(0) })).toEqual(Health.Sick({ plugin: "pool", cause: "the status RPC answered with no accounts", final: false }))
  })
})

describe("the recovery after a health check", () => {
  const sick = Health.Sick({ plugin: "pool", cause: "not loaded", final: false })
  const steps = (healths: ReadonlyArray<Health>, canRollBack: boolean): ReadonlyArray<Recovery["_tag"]> => {
    const stages: ReadonlyArray<Stage> = ["first", "reinstalled", "rolled-back"]
    return healths.map((health, index) => recover(stages[index] ?? "rolled-back", health, canRollBack)._tag)
  }

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
