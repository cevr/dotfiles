import { file } from "bun"
import { Effect, Layer, Option } from "effect"
import { run, spawned, type Place } from "../process/run.ts"
import { CheckoutStuck, Source, UpdateFailed } from "../service.ts"
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
  /** The script that puts this host's commands into `~/.local/bin` after each move (`binScript`). */
  readonly bin: Option.Option<BinScript>
}

/** A script of the checkout, with its arguments, run through `sh` after the dependencies install. */
export interface BinScript {
  /** Its path from the checkout's root. */
  readonly path: string
  readonly args: ReadonlyArray<string>
}

/**
 * The workbox's script install, as bootstrap runs it, then the fresh `apply-agent-settings`. Without
 * it, `~/.local/bin` kept the copies bootstrap made, missing what the checkout added since (a link
 * apply-agent-settings had gained, 2026-11-15).
 */
export const WORKBOX_BIN: BinScript = { path: "workbox/install-bin.sh", args: ["--apply"] }

/**
 * The Mac's command links, as install.sh makes them. Without it, a link added since the last
 * install.sh never came (rex-show, 2026-11-15).
 */
export const MAC_BIN: BinScript = { path: "local-bin.sh", args: [] }

/**
 * The script a host runs after each move: the workbox's on Linux, the Mac's on macOS. A commit
 * older than its script has none, and its move installs nothing there.
 */
export const binScript = (platform: string): Option.Option<BinScript> => {
  if (platform === "linux") return Option.some(WORKBOX_BIN)
  if (platform === "darwin") return Option.some(MAC_BIN)
  return Option.none()
}

/** Whether `path` is a file a reset leaves as the host has it. */
export const kept = (path: string): boolean => KEPT.some((each) => path === each || (each.endsWith("/") && path.startsWith(each)))

/** The Source contract over git and bun in the checkout. */
export const layer = (checkout: Checkout) => {
  const here: Place = { cwd: checkout.root, env: checkout.env }
  const opencode: Place = { cwd: `${checkout.root}/opencode`, env: { ...checkout.env, OPENCODE_DEV: checkout.fork } }
  const git = (step: string, ...args: ReadonlyArray<string>) => run(step, ["git", ...args], here)
  const lines = (text: string) => text.split("\n").filter((line) => line !== "")
  /** Deletes a file of the checkout; one already gone is no failure. */
  const remove = (step: string, path: string) => {
    const each = file(`${checkout.root}/${path}`)
    const failed = (cause: unknown) => new UpdateFailed({ step, message: String(cause) })
    return Effect.tryPromise({ try: () => each.exists(), catch: failed }).pipe(
      Effect.flatMap((exists) => Effect.when(Effect.tryPromise({ try: () => each.delete(), catch: failed }), Effect.succeed(exists))),
      Effect.asVoid,
    )
  }

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
    const left = yield* head
    yield* git("move the checkout", "reset", "--quiet", commit)
    const differing = lines(yield* git("list the files that differ", "diff", "--name-only")).filter((path) => !kept(path))
    if (differing.length > 0) yield* git("take the commit's files", "checkout", "--quiet", "--", ...differing)
    // A mixed reset leaves on disk, untracked, each file the commit left tracks and this one does
    // not. Moving back past a commit that added a workspace package (cmd/stall, 2026-11-12) left
    // its package.json, so bun's workspaces found a package the lockfile lacks and the frozen
    // install of the rollback failed. Those files go, as a fast-forward's `reset --keep` drops them.
    const dropped = lines(yield* git("list the files the commit does not have", "diff", "--name-only", "--no-renames", "--diff-filter=D", left, commit)).filter((path) => !kept(path))
    yield* Effect.forEach(dropped, (path) => remove("drop the files the commit does not have", path), { discard: true })
    const conflicts = lines(yield* git("list Syncthing's conflict copies", "ls-files", "--others", "--exclude-standard")).filter((path) => path.includes(".sync-conflict-"))
    yield* Effect.forEach(conflicts, (path) => remove("delete Syncthing's conflict copies", path), { discard: true })
    return ""
  })

  const install = run("install the dependencies", [checkout.bun, ...INSTALL], opencode).pipe(
    Effect.andThen(run("link the fork's modules", [checkout.bun, "scripts/link-fork.ts"], opencode)),
    Effect.asVoid,
  )

  const scripts = Effect.gen(function* () {
    if (Option.isNone(checkout.bin)) return
    const script = `${checkout.root}/${checkout.bin.value.path}`
    const exists = yield* Effect.tryPromise({ try: () => file(script).exists(), catch: (cause) => new UpdateFailed({ step: "find the host's commands script", message: String(cause) }) })
    if (exists) yield* run("install the host's commands", ["sh", script, ...checkout.bin.value.args], here)
  })

  /** The dependencies, then the host's commands: what a move of the checkout installs. */
  const installMoved = install.pipe(Effect.andThen(scripts))

  /**
   * The untracked files `commit` tracks: one with the commit's content is the commit's own file (a
   * copy that came ahead of it, by hand or by Syncthing) and goes, so git does not refuse the move
   * over it; one with other content stays, and is answered for the refusal's message.
   */
  const untrackedAhead = (commit: string) =>
    Effect.gen(function* () {
      const untracked = lines(yield* git("list the untracked files", "ls-files", "--others", "--exclude-standard")).filter((path) => !kept(path))
      if (untracked.length === 0) return []
      const tracked = new Set(lines(yield* git("list the commit's files", "ls-tree", "-r", "--name-only", commit)))
      const ahead = untracked.filter((path) => tracked.has(path))
      const same = yield* Effect.filter(ahead, (path) =>
        Effect.all([git("hash an untracked file", "hash-object", "--", path), git("read the commit's file", "rev-parse", `${commit}:${path}`)]).pipe(
          Effect.map(([here, there]) => here.trim() === there.trim()),
        ),
      )
      yield* Effect.forEach(same, (path) => remove("delete an untracked copy of the commit's file", path), { discard: true })
      return ahead.filter((path) => !same.includes(path))
    })

  /** The move to `commit`, its refusal `CheckoutStuck`, naming each untracked file in the way. */
  const moveForward = (commit: string) =>
    untrackedAhead(commit).pipe(
      Effect.mapError((failed) => new CheckoutStuck({ step: failed.step, message: failed.message })),
      Effect.flatMap((differing) =>
        move(commit).pipe(
          Effect.mapError((failed) =>
            new CheckoutStuck({
              step: failed.step,
              message: [failed.message, ...(differing.length > 0 ? [`untracked files the target tracks with other content: ${differing.join(", ")}`] : [])].join("\n"),
            }),
          ),
        ),
      ),
    )

  const advance = Effect.fn("Source.advance")(function* (commit: string) {
    const prior = yield* head
    yield* moveForward(commit)
    yield* installMoved.pipe(
      Effect.catchTag("UpdateFailed", (failed) =>
        move(prior).pipe(
          Effect.andThen(installMoved),
          Effect.ignore,
          Effect.andThen(Effect.fail(new UpdateFailed({ step: failed.step, message: `${failed.message}\nthe checkout moved back to ${prior.slice(0, 10)}` }))),
        ),
      ),
    )
  })

  return Layer.succeed(Source, Source.of({ verified, head, advance, reinstall: install }))
}
