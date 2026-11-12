import { Array as Arr, Data, Option } from "effect"
import { describePlacement, Placement } from "./placement.ts"

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
  /** The providers the configured models use (the default model, each agent's, the planner's), by id. */
  readonly providers: ReadonlyArray<string>
  /** The providers with a usable login: an account in the pool, or a stored credential or key. */
  readonly logins: ReadonlyArray<string>
  /**
   * Where the service runs, as the update plugin in it answers (`placement.ts`); none when it does
   * not answer, as a build from before the placement does not.
   */
  readonly placement: Option.Option<Placement>
}

/** The restarted service's health. */
export type Health = Data.TaggedEnum<{
  /** Every configured plugin runs, the pool answers with accounts, and each configured model's provider has a login. */
  Healthy: {}
  /**
   * Healthy, but providers the configured models use have no login, and had none before the
   * restart either: a rollback cannot bring a login back, so it is reported, never rolled back.
   */
  Unsigned: { readonly providers: ReadonlyArray<string> }
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
 * RPC answering with at least one account (a call that spends nothing), then a login for each
 * provider the configured models use. A plugin not listed yet is reported as not loaded; the caller
 * reads again until its deadline before it believes that. A provider with no login that had one
 * before the restart (`before`, the providers the old service had a login for) is sick, as a
 * failed plugin is; one that had none before is `Unsigned`. Where a user systemd manages the
 * service and it answers that it runs outside its own scope (`placement.ts`), it is sick for good:
 * it shares its CPU weight with every TUI and job again.
 */
export const healthOf = (reading: Reading, before: ReadonlyArray<string>): Health => {
  for (const path of reading.configured) {
    const listed = Option.fromNullishOr(reading.listed.find((plugin) => Option.contains(plugin.path, path)))
    if (Option.isNone(listed)) return Health.Sick({ plugin: nameOf(path), cause: "not loaded", final: false })
    const failure = listed.value.failed
    if (Option.isSome(failure)) return Health.Sick({ plugin: nameOf(path), cause: failure.value, final: true })
  }
  const unplaced = Option.filter(reading.placement, Placement.guards.Unplaced)
  if (Option.isSome(unplaced)) return Health.Sick({ plugin: "placement", cause: `the service runs ${describePlacement(unplaced.value)}`, final: true })
  if (!Option.exists(reading.accounts, (count) => count > 0))
    return Health.Sick({ plugin: "pool", final: false, cause: Option.match(reading.accounts, { onNone: () => "the status RPC did not answer", onSome: () => "the status RPC answered with no accounts" }) })
  const missing = [...new Set(reading.providers)].filter((provider) => !reading.logins.includes(provider))
  const lost = Arr.findFirst(missing, (provider) => before.includes(provider))
  if (Option.isSome(lost))
    return Health.Sick({ plugin: "login", final: false, cause: `no ${lost.value} login after the restart, which had one before it: the pool lists no ${lost.value} account and no credential is stored` })
  if (missing.length > 0) return Health.Unsigned({ providers: missing })
  return Health.Healthy()
}

/** Whether the build is good to keep: healthy, or healthy with logins missing that no rollback brings back. */
export const usable = (health: Health): boolean => !Health.$is("Sick")(health)

/**
 * Whether reading again cannot change the health: it is usable, or a plugin failed to load. A
 * missing login that was there before reads again (the pool may load it late); one that was not is
 * final.
 */
export const final = (health: Health): boolean => Health.$match(health, { Healthy: () => true, Unsigned: () => true, Sick: (sick) => sick.final })

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
  const healthy = usable(health)
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

/** The providers with no login, as the owner reads it: what is missing and how to fix it. */
const unsigned = (providers: ReadonlyArray<string>): string => `${providers.map((provider) => `no ${provider} login`).join(", ")}: sign in with opencode auth login`

/** The health in a log line. */
export const describeHealth = (health: Health): string =>
  Health.$match(health, {
    Healthy: () => "healthy: every plugin loaded, the pool answers with accounts, every configured model's provider has a login",
    Unsigned: ({ providers }) => `healthy, but ${unsigned(providers)}`,
    Sick: ({ plugin, cause }) => `${plugin}: ${cause}`,
  })

/** What the owner's corner says once a build is proven: the logins it lacks, or nothing (cleared). */
export const provenNotice = (health: Health): Option.Option<string> => Option.map(Option.liftPredicate(health, Health.$is("Unsigned")), describeHealth)
