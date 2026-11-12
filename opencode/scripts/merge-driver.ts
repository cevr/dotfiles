/**
 * The git merge driver `effect-debt` (opencode/.gitattributes), registered in a dotfiles checkout's
 * git config from its one definition, opencode/merge-drivers.gitconfig, which install.sh reads too.
 * `bun run daily` registers it here, since the update plugin, which runs `daily --stage`, never runs
 * install.sh. This module imports git and nothing of the lint tool (scripts/effect-debt.ts and its
 * parser): daily, and every scenario that imports daily, load it at runtime
 * (scripts/runtime-imports.test.ts).
 */
import { Console, Data, Effect } from "effect"

/** The merge drivers' one definition, from the dotfiles checkout's root: install.sh reads it too. */
export const MERGE_DRIVERS = "opencode/merge-drivers.gitconfig"

/** The files `.gitattributes` routes to the driver, from the dotfiles checkout's root. */
const ROUTED = ["opencode/effect-debt.json", "opencode/.oxlintrc.effect-debt.json"]

const KEYS = ["name", "driver"]

/** A git command that did not run, or failed where it must succeed. */
export class MergeDriverError extends Data.TaggedError("MergeDriverError")<{ readonly message: string }> {}

/** One git command in `checkout`: its exit code and trimmed output. */
const gitIn = (checkout: string, ...argv: ReadonlyArray<string>) =>
  Effect.try({
    try: () => Bun.spawnSync(["git", "-C", checkout, ...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
    catch: () => new MergeDriverError({ message: `cannot run git ${argv.join(" ")} in ${checkout}` }),
  }).pipe(Effect.map((ran) => ({ code: ran.exitCode, stdout: ran.stdout.toString().trim(), stderr: ran.stderr.toString().trim() })))

/** A git command that must succeed: its output, or a MergeDriverError naming it. */
const gitOk = (checkout: string, ...argv: ReadonlyArray<string>) =>
  gitIn(checkout, ...argv).pipe(
    Effect.filterOrFail(
      (answer) => answer.code === 0,
      (answer) => new MergeDriverError({ message: `git ${argv.join(" ")} in ${checkout} exited ${answer.code}: ${answer.stderr}` }),
    ),
    Effect.map((answer) => answer.stdout),
  )

/**
 * Registers the merge driver `effect-debt` in the dotfiles `checkout`'s git config, as install.sh
 * does, when its `.gitattributes` routes a file to it and the config names no such driver; a
 * checkout without the driver merges the policy by line. A driver the config already names stays.
 */
export const registerMergeDriver = Effect.fn("MergeDriver.register")(function* (checkout: string) {
  const attributes = yield* gitOk(checkout, "check-attr", "merge", "--", ...ROUTED)
  if (!attributes.split("\n").some((line) => line.endsWith(": merge: effect-debt"))) return "unrouted" as const
  const named = yield* Effect.forEach(KEYS, (key) => gitIn(checkout, "config", "--get", `merge.effect-debt.${key}`))
  if (named.every((answer) => answer.code === 0)) return "present" as const
  for (const key of KEYS) yield* gitOk(checkout, "config", `merge.effect-debt.${key}`, yield* gitOk(checkout, "config", "-f", MERGE_DRIVERS, "--get", `merge.effect-debt.${key}`))
  yield* Console.log(`merge-driver: registered the merge driver effect-debt in ${checkout}`)
  return "registered" as const
})
