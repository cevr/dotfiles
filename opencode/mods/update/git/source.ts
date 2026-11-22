import { file } from "bun"
import { Effect, Layer, Option } from "effect"
import { run, spawned, type Place } from "../process/run.ts"
import { Source, UpdateFailed } from "../service.ts"
import { targetOfTag, VERIFIED_REF } from "../target.ts"

/** The live checkout: an object store the updater fetches into, and the host's commands script. No update moves it. */
export interface Checkout {
  /** The dotfiles checkout's root. */
  readonly root: string
  /** Variables every command gets (PATH with bun's directory first). */
  readonly env: Readonly<globalThis.Record<string, string>>
  /** The script that puts this host's commands into `~/.local/bin` once a build is proven (`binScript`). */
  readonly bin: Option.Option<BinScript>
  /** The installed build's plugin tree, `<share>/current.plugins` (`filestore/stage.ts` `CURRENT_TREE`). */
  readonly tree: string
}

/** A script, with its arguments, run through `sh` from the root it lives in. */
export interface BinScript {
  /** Its path from that root. */
  readonly path: string
  readonly args: ReadonlyArray<string>
  /**
   * Where it runs from: the installed build's tree (`tree`), which holds the verified commit's files, or
   * the live checkout as it stands (`checkout`). A tree without the script fails the commands, so a
   * missing delivery is logged; a checkout without it runs nothing.
   */
  readonly from: "tree" | "checkout"
}

/**
 * The workbox's commands and shell files (`~/.zshenv`, `~/.zshrc`), as bootstrap installs them, then
 * the fresh `apply-agent-settings`, from the installed tree's `workbox/`. Without it, `~/.local/bin`
 * kept the copies bootstrap made (a link apply-agent-settings had gained, 2026-11-15); run from the
 * live checkout, it installed whatever that checkout held, which Syncthing fills from the Mac's base
 * and no update moves (`~/.zshenv` was two days behind the verified install, 2026-11-22).
 */
export const WORKBOX_BIN: BinScript = { path: "workbox/install-bin.sh", args: ["--apply"], from: "tree" }

/**
 * The Mac's command links, as install.sh makes them. Without it, a link added since the last
 * install.sh never came (rex-show, 2026-11-15). Its links point into the checkout, so it runs there.
 */
export const MAC_BIN: BinScript = { path: "local-bin.sh", args: [], from: "checkout" }

/** The script a host runs once a build is proven: the workbox's on Linux, the Mac's on macOS. A checkout without it runs nothing. */
export const binScript = (platform: string): Option.Option<BinScript> => {
  if (platform === "linux") return Option.some(WORKBOX_BIN)
  if (platform === "darwin") return Option.some(MAC_BIN)
  return Option.none()
}

/** The Source contract over git in the checkout. */
export const layer = (checkout: Checkout) => {
  const here: Place = { cwd: checkout.root, env: checkout.env }
  const git = (step: string, ...args: ReadonlyArray<string>) => run(step, ["git", ...args], here)

  const verified = Effect.gen(function* () {
    const fetched = yield* spawned("fetch the verified target", ["git", "fetch", "--quiet", "origin", `+${VERIFIED_REF}:${VERIFIED_REF}`], here)
    if (fetched.code !== 0 && fetched.stderr.includes("couldn't find remote ref")) return Option.none()
    if (fetched.code !== 0) return yield* new UpdateFailed({ step: "fetch the verified target", message: fetched.stderr.trim() })
    return targetOfTag(yield* git("read the verified target", "cat-file", "tag", VERIFIED_REF))
  })

  /** Whether the object store holds `commit` as a commit. */
  const holds = (commit: string) => spawned("look for the commit", ["git", "cat-file", "-e", `${commit}^{commit}`], here).pipe(Effect.map((ran) => ran.code === 0))

  /**
   * Brings `commit` into the checkout's object store from its origin, when it lacks it (the verified
   * tag's fetch usually brought it already). Only objects and remote refs change: the branch, the
   * index and the files stay as they are.
   */
  const fetch = Effect.fn("Source.fetch")(function* (commit: string) {
    if (yield* holds(commit)) return
    yield* git("fetch the target's dotfiles commit", "fetch", "--quiet", "origin")
    if (!(yield* holds(commit))) return yield* new UpdateFailed({ step: "fetch the target's dotfiles commit", message: `the origin has no commit ${commit.slice(0, 10)}` })
  })

  const scripts = Effect.gen(function* () {
    if (Option.isNone(checkout.bin)) return
    const bin = checkout.bin.value
    const root = bin.from === "tree" ? checkout.tree : checkout.root
    const script = `${root}/${bin.path}`
    const exists = yield* Effect.tryPromise({ try: () => file(script).exists(), catch: (cause) => new UpdateFailed({ step: "find the host's commands script", message: String(cause) }) })
    if (!exists && bin.from === "tree") return yield* new UpdateFailed({ step: "find the host's commands script", message: `${script} is not in the installed tree` })
    if (exists) yield* run("install the host's commands", ["sh", script, ...bin.args], { cwd: root, env: checkout.env })
  })

  return Layer.succeed(Source, Source.of({ verified, fetch, commands: scripts }))
}
