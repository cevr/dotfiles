import { describe, expect, test } from "bun:test"
import { targetOfTag, VERIFIED_REF } from "@dotfiles/opencode-update/target"
import { spawnSync, write } from "bun"
import { Effect, Option } from "effect"
import { FleetOutcome } from "../fleet.ts"
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

/** A batch header naming both heads, short, as the orchestrator writes it. */
const both = (dotfiles: string, fork: string) => `Dotfiles: base 1111111a, head ${dotfiles.slice(0, 8)}; Rift detached at it. Fork prime-look: base 2222222b, head ${fork.slice(0, 10)}.`

/** Runs `body` on a scratch root with a dotfiles and a fork repository of `count` commits each, removed after. */
const onRepositories = <A>(count: number, body: (root: string, dotfiles: ReadonlyArray<string>, fork: ReadonlyArray<string>) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(() => sh(".", ["mktemp", "-d", "-t", "fleet-record"])),
      (root) => body(root, repository(root, "dotfiles", count).commits, repository(root, "fork", count).commits),
      (root) => Effect.sync(() => void spawnSync(["rm", "-rf", root])),
    ),
  )

const refused = (outcome: FleetOutcome) => FleetOutcome.$match(outcome, { Refused: ({ reason }) => reason, Off: () => "", Recorded: () => "", Unchanged: () => "" })

describe("the fleet's record over real git", () => {
  test(
    "B3: an accepted batch records the heads its batch file names, never the checkouts' HEADs, which stand at older commits",
    () =>
      onRepositories(3, (root, [d1, d2], [f1, f2]) =>
        Effect.gen(function* () {
          sh(`${root}/dotfiles`, ["git", "checkout", "-q", "--detach", d1])
          sh(`${root}/fork`, ["git", "checkout", "-q", "--detach", f1])
          expect(yield* record(root, "batch-7", both(d2, f2))).toEqual(FleetOutcome.Recorded({ target: { dotfiles: d2, fork: f2, batch: "batch-7" } }))
          expect(recorded(root)).toEqual(Option.some({ dotfiles: d2, fork: f2, batch: "batch-7" }))
          expect(yield* record(root, "batch-8", both(d2, f2))).toEqual(FleetOutcome.Unchanged({ target: { dotfiles: d2, fork: f2, batch: "batch-8" } }))
          expect(sh(`${root}/dotfiles`, ["git", "rev-parse", "HEAD"])).toBe(d1)
        }),
      ),
    60_000,
  )

  test(
    "M1: a batch file that names one head, a head nobody knows or no commit at all publishes nothing, and says what it lacks; no kept fork stands in",
    () =>
      onRepositories(3, (root, [, d2, d3], [, f2]) =>
        Effect.gen(function* () {
          expect(yield* record(root, "batch-1", `Dotfiles: base 1111111a, head ${d2.slice(0, 8)}.`)).toEqual(
            FleetOutcome.Refused({ reason: `the batch file ${root}/run/batch-1.md lacks the fork head (\`Fork prime-look: base X, head Y\` or \`Fork unchanged (Y)\`)` }),
          )
          expect(recorded(root)).toEqual(Option.none())
          yield* record(root, "batch-2", both(d2, f2))
          expect(refused(yield* record(root, "batch-3", `Dotfiles: base ${d2.slice(0, 8)}, head ${d3.slice(0, 8)}.`))).toContain("lacks the fork head")
          expect(refused(yield* record(root, "batch-4", "Fork unchanged (2222222b).\n"))).toContain("lacks the dotfiles head")
          expect(refused(yield* record(root, "batch-5", both("9999999a", f2)))).toContain("a head the checkouts do not know")
          expect(refused(yield* record(root, "batch-6", "Dotfiles: base 1111111a, head origin/main."))).toContain("lacks the dotfiles head (`Dotfiles: base X, head Y`) and the fork head")
          expect(recorded(root)).toEqual(Option.some({ dotfiles: d2, fork: f2, batch: "batch-2" }))
        }),
      ),
    60_000,
  )

  test(
    "M2: an accepted batch behind the current target, in either repository, never moves the fleet back; one ahead in both does",
    () =>
      onRepositories(3, (root, [d1, d2, d3], [f1, f2, f3]) =>
        Effect.gen(function* () {
          yield* record(root, "batch-y", both(d3, f2))
          expect(recorded(root)).toEqual(Option.some({ dotfiles: d3, fork: f2, batch: "batch-y" }))
          const older = refused(yield* record(root, "batch-x", both(d2, f2)))
          expect(older).toContain(`do not both descend from the current target (dotfiles ${d3.slice(0, 10)}, fork ${f2.slice(0, 10)}, batch-y)`)
          expect(refused(yield* record(root, "batch-w", both(d3, f1)))).toContain("do not both descend")
          expect(refused(yield* record(root, "batch-v", both(d1, f3)))).toContain("do not both descend")
          expect(recorded(root)).toEqual(Option.some({ dotfiles: d3, fork: f2, batch: "batch-y" }))
          expect(yield* record(root, "batch-z", both(d3, f3))).toEqual(FleetOutcome.Recorded({ target: { dotfiles: d3, fork: f3, batch: "batch-z" } }))
        }),
      ),
    60_000,
  )
})
