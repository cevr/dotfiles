import { Data, Option } from "effect"

/** A plugin as the service lists it (`/api/plugin`): where it loads from, and whether it runs. */
export interface Listed {
  /** A local plugin's directory; none for a builtin or a package. */
  readonly path: Option.Option<string>
  /** The load error of a plugin that failed; none for one that runs. */
  readonly failed: Option.Option<string>
}

/** What the restarted service says of itself. */
export interface Reading {
  /** The local server plugins the config names, by directory. */
  readonly configured: ReadonlyArray<string>
  readonly listed: ReadonlyArray<Listed>
  /** How many accounts the pool's status RPC answered with; none when it did not answer. */
  readonly accounts: Option.Option<number>
}

/** The restarted service's health. */
export type Health = Data.TaggedEnum<{
  /** Every configured plugin runs and the pool answers with accounts. */
  Healthy: {}
  /**
   * The first thing found wrong: the plugin, and why. `final` when reading again cannot change it (the
   * plugin failed to load); a plugin not listed yet, or a pool that has not answered yet, may still come.
   */
  Sick: { readonly plugin: string; readonly cause: string; readonly final: boolean }
}>
export const Health = Data.taggedEnum<Health>()

const nameOf = (path: string): string => path.split("/").filter((part) => part !== "").at(-1) ?? path

/**
 * The health a reading shows: each configured plugin listed and running, then the pool's status
 * RPC answering with at least one account (a call that spends nothing). A plugin not listed yet is
 * reported as not loaded; the caller reads again until its deadline before it believes that.
 */
export const healthOf = (reading: Reading): Health => {
  for (const path of reading.configured) {
    const listed = Option.fromNullishOr(reading.listed.find((plugin) => Option.contains(plugin.path, path)))
    if (Option.isNone(listed)) return Health.Sick({ plugin: nameOf(path), cause: "not loaded", final: false })
    const failure = listed.value.failed
    if (Option.isSome(failure)) return Health.Sick({ plugin: nameOf(path), cause: failure.value, final: true })
  }
  if (!Option.exists(reading.accounts, (count) => count > 0))
    return Health.Sick({ plugin: "pool", final: false, cause: Option.match(reading.accounts, { onNone: () => "the status RPC did not answer", onSome: () => "the status RPC answered with no accounts" }) })
  return Health.Healthy()
}

/** Whether reading again cannot change the health: it is healthy, or a plugin failed to load. */
export const final = (health: Health): boolean => Health.$match(health, { Healthy: () => true, Sick: (sick) => sick.final })

/** Where the recovery after a restart stands. */
export type Stage = "first" | "reinstalled" | "rolled-back"

/** What follows a health check. */
export type Recovery = Data.TaggedEnum<{
  /** The build is healthy: record it as the good build. */
  Proven: {}
  /** Install the dependencies again and restart once more. */
  Reinstall: {}
  /** Go back to the last good build and dotfiles commit, and restart onto it. */
  RollBack: {}
  /** The rollback is healthy; the failed build stays recorded as superseded. */
  RolledBack: {}
  /** Nothing more to try: the owner has to look. */
  GaveUp: {}
}>
export const Recovery = Data.taggedEnum<Recovery>()

/**
 * The recovery after a restart's health check. A sick first restart reinstalls the dependencies and
 * restarts once; still sick, it rolls back to the last good build (when there is one other than
 * this); a sick rollback gives up.
 */
export const recover = (stage: Stage, health: Health, canRollBack: boolean): Recovery => {
  const healthy = Health.$is("Healthy")(health)
  if (stage === "first") {
    if (healthy) return Recovery.Proven()
    return Recovery.Reinstall()
  }
  if (stage === "reinstalled") {
    if (healthy) return Recovery.Proven()
    if (canRollBack) return Recovery.RollBack()
    return Recovery.GaveUp()
  }
  if (healthy) return Recovery.RolledBack()
  return Recovery.GaveUp()
}

/** The health in a log line. */
export const describeHealth = (health: Health): string =>
  Health.$match(health, {
    Healthy: () => "healthy: every plugin loaded, the pool answers with accounts",
    Sick: ({ plugin, cause }) => `${plugin}: ${cause}`,
  })
