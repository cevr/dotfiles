import { describe, expect, test } from "bun:test"
import { targetOfTag, VERIFIED_REF } from "@dotfiles/opencode-update/target"
import { spawnSync, write } from "bun"
import { Effect, Option } from "effect"
import { recordOnce } from "./fleet.ts"

/** Git with no config of the owner's: no signing, no hooks, a fixed identity. */
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
}

const sh = (cwd: string, command: ReadonlyArray<string>) => spawnSync([...command], { cwd, env: GIT_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()

/** A checkout at `root/name` whose origin is the bare `root/name.git`, with `count` commits pushed to main; answers the commits, oldest first. */
const repository = (root: string, name: string, count: number) => {
  sh(root, ["git", "init", "-q", "--bare", "-b", "main", `${name}.git`])
  sh(root, ["git", "init", "-q", "-b", "main", name])
  const dir = `${root}/${name}`
  sh(dir, ["git", "remote", "add", "origin", `${root}/${name}.git`])
  const commits = Array.from({ length: count }, (_, at) => {
    sh(dir, ["git", "commit", "-q", "--allow-empty", "-m", `${name} ${at}`])
    return sh(dir, ["git", "rev-parse", "HEAD"])
  })
  sh(dir, ["git", "push", "-q", "origin", "main"])
  return { dir, commits }
}

/** The target the dotfiles origin's verified ref names. */
const recorded = (root: string) => targetOfTag(sh(root, ["git", "--git-dir", `${root}/dotfiles.git`, "cat-file", "tag", VERIFIED_REF]))

const record = (root: string, batch: string, header: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => write(`${root}/run/${batch}.md`, `# ${batch}\n\n${header}\n\nVerify the units below.\n`, { createPath: true }))
    return yield* recordOnce({ dotfiles: `${root}/dotfiles`, fork: `${root}/fork` }, `${root}/run/${batch}-findings.md`, batch)
  })

describe("the fleet's record over real git", () => {
  test(
    "B3: an accepted batch records the heads its batch file names, never the checkouts' HEADs, which stand at older commits",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const root = sh(".", ["mktemp", "-d", "-t", "fleet-record"])
          const dotfiles = repository(root, "dotfiles", 3)
          const fork = repository(root, "fork", 3)
          const [d1, d2, d3] = dotfiles.commits
          const [f1, f2] = fork.commits
          sh(dotfiles.dir, ["git", "checkout", "-q", "--detach", d1])
          sh(fork.dir, ["git", "checkout", "-q", "--detach", f1])

          const first = yield* record(root, "batch-7", `Dotfiles: base ${d1.slice(0, 8)}, head ${d2.slice(0, 8)}; Rift detached at it. Fork prime-look: base ${f1.slice(0, 10)}, head ${f2.slice(0, 10)}.`)
          expect(first).toBe(`recorded the verified target: dotfiles ${d2.slice(0, 10)}, fork ${f2.slice(0, 10)} (batch-7)`)
          expect(recorded(root)).toEqual(Option.some({ dotfiles: d2, fork: f2, batch: "batch-7" }))

          const second = yield* record(root, "batch-8", `Dotfiles: base ${d2.slice(0, 8)}, head ${d3.slice(0, 8)}; Rift detached at it.`)
          expect(second).toBe(`recorded the verified target: dotfiles ${d3.slice(0, 10)}, fork ${f2.slice(0, 10)} (batch-8)`)
          expect(recorded(root)).toEqual(Option.some({ dotfiles: d3, fork: f2, batch: "batch-8" }))

          const unknown = yield* record(root, "batch-9", `Dotfiles: base ${d3.slice(0, 8)}, head 9999999a.`)
          expect(unknown).toContain("nothing recorded")
          const none = yield* record(root, "batch-10", "Dotfiles: base 1111111a, head origin/main.")
          expect(none).toContain("names no head")
          expect(recorded(root)).toEqual(Option.some({ dotfiles: d3, fork: f2, batch: "batch-8" }))
          expect(sh(dotfiles.dir, ["git", "rev-parse", "HEAD"])).toBe(d1)
          spawnSync(["rm", "-rf", root])
        }),
      ),
    60_000,
  )

  test(
    "the first record, from a batch that names one repository only, records nothing: no checkout's HEAD stands in",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const root = sh(".", ["mktemp", "-d", "-t", "fleet-record"])
          const dotfiles = repository(root, "dotfiles", 2)
          repository(root, "fork", 1)
          const said = yield* record(root, "batch-1", `Dotfiles: base ${dotfiles.commits[0].slice(0, 8)}, head ${dotfiles.commits[1].slice(0, 8)}.`)
          expect(said).toContain("no target is recorded yet")
          expect(recorded(root)).toEqual(Option.none())
          spawnSync(["rm", "-rf", root])
        }),
      ),
    60_000,
  )
})
