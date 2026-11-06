// Landing over Git and the shell, run as child processes. The repository's
// commands come from its warm source's Git config (`rift.gate`,
// `rift.accept`, `rift.generated`, `rift.regenerate`, the default branch from
// `workrift.main` else origin's HEAD) and run through `sh -c`, their output
// kept in a log under `logs`. A lock file is installed again with its package
// manager (frozen first, then free, as a merged lock file may need) and
// committed when the install rewrote it.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { Effect, Layer } from "effect"
import { INTEGRATION, type LandConfig, type Merged, type Ran, type Started, type Unit } from "../land.ts"
import { Landing, RiftFailed } from "../service.ts"
import { commands, lines } from "./command.ts"

export interface Options {
  /** Where each check's log is written, `<rift name>.<gate|accept>.log`. */
  readonly logs: string
  /** Variables added to every command's environment (a test's scratch HOME). */
  readonly env?: Readonly<Record<string, string>>
}

/** Each lock file, by name, to its installs: the frozen one, then the one that may rewrite it. */
export const INSTALLS: Readonly<Record<string, readonly [string, string]>> = {
  "bun.lock": ["bun install --frozen-lockfile", "bun install"],
  "bun.lockb": ["bun install --frozen-lockfile", "bun install"],
  "pnpm-lock.yaml": ["pnpm install --frozen-lockfile", "pnpm install"],
  "yarn.lock": ["yarn install --immutable", "yarn install"],
  "package-lock.json": ["npm ci", "npm install"],
}

const isLock = (file: string): boolean => Object.hasOwn(INSTALLS, basename(file))

/** The entries of `git status --porcelain=v1 -z`: `XY path`, a rename's old path dropped. */
export const statusEntries = (output: string): ReadonlyArray<{ readonly line: string; readonly file: string }> => {
  const fields = output.split("\0").filter((field) => field !== "")
  const entries: Array<{ line: string; file: string }> = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    const file = field.slice(3)
    entries.push({ line: field, file })
    if (field[0] === "R" || field[0] === "C") index++
  }
  return entries
}

/** Whether `file` reads the same under both roots: missing in both, or the same bytes. */
const same = (left: string, right: string): boolean => {
  const [a, b] = [existsSync(left), existsSync(right)]
  if (!a || !b) return a === b
  try {
    return readFileSync(left).equals(readFileSync(right))
  } catch {
    return false
  }
}

export const layer = (options: Options) => {
  const { spawn, run } = commands(options.env)
  const git = (path: string, ...args: ReadonlyArray<string>) => run(["git", "-C", path, ...args], path)
  const trimmed = (path: string, ...args: ReadonlyArray<string>) => git(path, ...args).pipe(Effect.map((out) => out.trim()))
  /** A Git config value, or undefined when unset. */
  const setting = (path: string, key: string) =>
    spawn(["git", "-C", path, "config", "--get", key], path).pipe(Effect.map((ran) => (ran.code === 0 && ran.stdout.trim() !== "" ? ran.stdout.trim() : undefined)))

  const config = Effect.fn("Landing.config")(function* (source: string) {
    const named = yield* setting(source, "workrift.main")
    const head = yield* spawn(["git", "-C", source, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], source)
    const main = named ?? (head.code === 0 ? head.stdout.trim().replace(/^origin\//, "") : "main")
    const generated = yield* spawn(["git", "-C", source, "config", "--get-all", "rift.generated"], source)
    return {
      main,
      gate: yield* setting(source, "rift.gate"),
      accept: yield* setting(source, "rift.accept"),
      generated: generated.code === 0 ? lines(generated.stdout) : [],
      regenerate: yield* setting(source, "rift.regenerate"),
    } satisfies LandConfig
  })

  const ownChanges = Effect.fn("Landing.ownChanges")(function* (path: string, source: string) {
    const status = yield* git(path, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ":(exclude).rift")
    return statusEntries(status)
      .filter((entry) => !same(join(path, entry.file), join(source, entry.file)))
      .map((entry) => entry.line)
  })

  const start = Effect.fn("Landing.start")(function* (integration: string, main: string) {
    // A copy-on-write copy can carry a multi-pack index its packs no longer match; Git then fails to read objects.
    const midx = join(integration, (yield* trimmed(integration, "rev-parse", "--git-path", "objects/pack/multi-pack-index")))
    if (existsSync(midx) && (yield* spawn(["git", "-C", integration, "multi-pack-index", "verify"], integration)).code !== 0) {
      rmSync(midx, { force: true })
      yield* spawn(["git", "-C", integration, "multi-pack-index", "write"], integration)
    }
    const previous = yield* trimmed(integration, "rev-parse", "HEAD")
    yield* spawn(["git", "-C", integration, "merge", "--abort"], integration)
    yield* git(integration, "fetch", "-q", "origin")
    yield* git(integration, "checkout", "-q", "-B", INTEGRATION, `origin/${main}`)
    return { base: yield* trimmed(integration, "rev-parse", "HEAD"), previous } satisfies Started
  })

  const merge = Effect.fn("Landing.merge")(function* (integration: string, from: Unit, settings: LandConfig) {
    yield* git(integration, "fetch", "-q", from.path, from.branch)
    const merged = yield* spawn(["git", "-C", integration, "merge", "--no-edit", "-m", `Merge ${from.branch}`, "FETCH_HEAD"], integration)
    if (merged.code === 0) return { _tag: "Merged" as const, regenerated: [] } satisfies Merged
    const files = lines(yield* git(integration, "diff", "--name-only", "--diff-filter=U"))
    if (files.length === 0) {
      yield* spawn(["git", "-C", integration, "merge", "--abort"], integration)
      return yield* new RiftFailed({ operation: "git merge", message: (merged.stderr.trim() || merged.stdout.trim()).split("\n").slice(-20).join("\n") })
    }
    if (!files.every((file) => isLock(file) || settings.generated.includes(file))) {
      yield* git(integration, "merge", "--abort")
      return { _tag: "Conflict" as const, files } satisfies Merged
    }
    // Only written files conflict: take the Rift's side and write them again for the merged sources.
    yield* git(integration, "checkout", "-q", "--theirs", "--", ...files)
    for (const lock of files.filter(isLock)) yield* run(["sh", "-c", INSTALLS[basename(lock)]![1]], join(integration, dirname(lock)))
    if (settings.regenerate !== undefined) yield* run(["sh", "-c", settings.regenerate], integration)
    yield* git(integration, "add", "--", ...files)
    yield* git(integration, "commit", "-q", "--no-edit")
    return { _tag: "Merged" as const, regenerated: files } satisfies Merged
  })

  const install = Effect.fn("Landing.install")(function* (integration: string, previous: string) {
    const changed = lines(yield* git(integration, "diff", "--name-only", previous, "HEAD")).filter(isLock)
    const committed: Array<string> = []
    for (const lock of changed) {
      const [frozen, free] = INSTALLS[basename(lock)]!
      const where = join(integration, dirname(lock))
      if ((yield* spawn(["sh", "-c", frozen], where)).code !== 0) yield* run(["sh", "-c", free], where)
      if ((yield* git(integration, "status", "--porcelain", "--", lock)).trim() !== "") {
        yield* git(integration, "add", "--", lock)
        yield* git(integration, "commit", "-q", "-m", `chore: ${lock} after landing`, "--", lock)
        committed.push(lock)
      }
    }
    return committed
  })

  const check = Effect.fn("Landing.check")(function* (path: string, label: "gate" | "accept", command: string, env: Readonly<Record<string, string>>) {
    mkdirSync(options.logs, { recursive: true })
    const log = join(options.logs, `${basename(path)}.${label}.log`)
    const started = Date.now()
    // One file for both streams, in the order they were written.
    const ran = yield* spawn(["sh", "-c", 'sh -c "$1" >"$2" 2>&1', "rift-land", command, log], path, env)
    const output = existsSync(log) ? readFileSync(log, "utf8") : ran.stderr
    return { code: ran.code, seconds: Math.round((Date.now() - started) / 1000), log, output } satisfies Ran
  })

  const push = Effect.fn("Landing.push")(function* (path: string, main: string) {
    yield* git(path, "fetch", "-q", "origin")
    const holds = yield* spawn(["git", "-C", path, "merge-base", "--is-ancestor", `origin/${main}`, "HEAD"], path)
    if (holds.code !== 0)
      return yield* new RiftFailed({ operation: "git push", message: `origin/${main} moved while the gate ran; land the batch again to merge it first.` })
    yield* git(path, "push", "-q", "origin", `HEAD:${main}`)
    return yield* trimmed(path, "log", "-1", "--format=%h %s")
  })

  const sync = Effect.fn("Landing.sync")(function* (path: string) {
    yield* git(path, "fetch", "-q", "origin")
  })

  return Layer.succeed(Landing, Landing.of({ config, ownChanges, start, merge, install, check, push, sync }))
}
