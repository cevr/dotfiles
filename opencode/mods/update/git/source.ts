import { file } from "bun"
import { Effect, Layer, Option } from "effect"
import { run, spawned, type Place } from "../process/run.ts"
import { Source, UpdateFailed } from "../service.ts"
import { targetOfTag, VERIFIED_REF } from "../target.ts"

/**
 * How a host moves its checkout: `ff` fast-forwards (the Mac, where the checkout is the owner's
 * own), `reset` follows the commit whatever the tree holds (the workbox, whose files Syncthing keeps
 * in step with the Mac's, so a merge can refuse files it already has).
 */
export type Mode = "ff" | "reset"

/** The files a host keeps its own under Syncthing: a reset never takes them from the commit. */
export const KEPT = ["codex/config.toml", "skills/.system/", "workbox/herdr-config.toml"] as const

/** The advance step's install: the dependencies exactly as the lockfile pins them. */
export const INSTALL = ["install", "--frozen-lockfile"] as const

/** The checkout and how this host moves it. */
export interface Checkout {
  /** The dotfiles checkout's root. */
  readonly root: string
  readonly mode: Mode
  /** The bun that installs, by its full path. */
  readonly bun: string
  /** The fork checkout the plugins' tooling links its modules from (`scripts/link-fork.ts`). */
  readonly fork: string
  /** Variables every command gets (PATH with bun's directory first). */
  readonly env: Readonly<globalThis.Record<string, string>>
}

/** Whether `path` is a file a reset leaves as the host has it. */
export const kept = (path: string): boolean => KEPT.some((each) => path === each || (each.endsWith("/") && path.startsWith(each)))

/** The Source contract over git and bun in the checkout. */
export const layer = (checkout: Checkout) => {
  const here: Place = { cwd: checkout.root, env: checkout.env }
  const opencode: Place = { cwd: `${checkout.root}/opencode`, env: { ...checkout.env, OPENCODE_DEV: checkout.fork } }
  const git = (step: string, ...args: ReadonlyArray<string>) => run(step, ["git", ...args], here)
  const lines = (text: string) => text.split("\n").filter((line) => line !== "")

  const verified = Effect.gen(function* () {
    const fetched = yield* spawned("fetch the verified target", ["git", "fetch", "--quiet", "origin", `+${VERIFIED_REF}:${VERIFIED_REF}`], here)
    if (fetched.code !== 0 && fetched.stderr.includes("couldn't find remote ref")) return Option.none()
    if (fetched.code !== 0) return yield* new UpdateFailed({ step: "fetch the verified target", message: fetched.stderr.trim() })
    return targetOfTag(yield* git("read the verified target", "cat-file", "tag", VERIFIED_REF))
  })

  const head = git("read the checkout's commit", "rev-parse", "HEAD").pipe(Effect.map((out) => out.trim()))

  const move = Effect.fn("Source.move")(function* (commit: string) {
    const back = yield* spawned("compare commits", ["git", "merge-base", "--is-ancestor", commit, "HEAD"], here)
    if (checkout.mode === "ff" && back.code === 0) return yield* git("move the checkout back", "reset", "--quiet", "--keep", commit)
    if (checkout.mode === "ff") return yield* git("fast-forward the checkout", "merge", "--quiet", "--ff-only", commit)
    yield* git("move the checkout", "reset", "--quiet", commit)
    const differing = lines(yield* git("list the files that differ", "diff", "--name-only")).filter((path) => !kept(path))
    if (differing.length > 0) yield* git("take the commit's files", "checkout", "--quiet", "--", ...differing)
    const conflicts = lines(yield* git("list Syncthing's conflict copies", "ls-files", "--others", "--exclude-standard")).filter((path) => path.includes(".sync-conflict-"))
    yield* Effect.forEach(conflicts, (path) => Effect.tryPromise({ try: () => file(`${checkout.root}/${path}`).delete(), catch: (cause) => new UpdateFailed({ step: "delete Syncthing's conflict copies", message: String(cause) }) }), { discard: true })
    return ""
  })

  const install = run("install the dependencies", [checkout.bun, ...INSTALL], opencode).pipe(
    Effect.andThen(run("link the fork's modules", [checkout.bun, "scripts/link-fork.ts"], opencode)),
    Effect.asVoid,
  )

  const advance = Effect.fn("Source.advance")(function* (commit: string) {
    const prior = yield* head
    yield* move(commit)
    yield* install.pipe(
      Effect.catchTag("UpdateFailed", (failed) =>
        move(prior).pipe(
          Effect.andThen(install),
          Effect.ignore,
          Effect.andThen(Effect.fail(new UpdateFailed({ step: failed.step, message: `${failed.message}\nthe checkout moved back to ${prior.slice(0, 10)}` }))),
        ),
      ),
    )
  })

  return Layer.succeed(Source, Source.of({ verified, head, advance, reinstall: install }))
}
