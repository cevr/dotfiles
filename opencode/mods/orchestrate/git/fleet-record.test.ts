import { describe, expect, test } from "bun:test"
import { tagObject, targetOfTag, VERIFIED_REF } from "@dotfiles/opencode-update/target"
import { spawnSync, write } from "bun"
import { Effect, Option } from "effect"
import { gitClone, gitInit } from "../../../tests/git-repo.ts"
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
  gitInit(`${root}/${name}.git`, ["-q", "--bare", "-b", "main"], GIT_ENV)
  gitInit(`${root}/${name}`, ["-q", "-b", "main"], GIT_ENV)
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

const record = (root: string, batch: string, header: string, program = "git") =>
  Effect.gen(function* () {
    yield* Effect.promise(() => write(`${root}/run/${batch}.md`, `# ${batch}\n\n${header}\n\nVerify the units below.\n`, { createPath: true }))
    return yield* recordOnce({ dotfiles: `${root}/dotfiles`, fork: `${root}/fork` }, `${root}/run/${batch}-findings.md`, batch, program)
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

/** The git this test runs, as the wrapper below calls it. */
const REAL_GIT = spawnSync(["sh", "-c", "command -v git"]).stdout.toString().trim()

/**
 * A git for this host under which another host, `root/other` (a clone of the dotfiles origin),
 * publishes `targets` over the verified ref, one each time this host builds its tag object: after
 * this host read the ref and checked the target, before it pushes, the window two hosts accepting
 * batches at once share (the verifier's race probe). It answers the wrapper's path; the wrapper runs
 * the real git for every call.
 */
const otherHostPublishes = (root: string, targets: ReadonlyArray<{ readonly dotfiles: string; readonly fork: string; readonly batch: string }>) =>
  Effect.gen(function* () {
    gitClone(`${root}/dotfiles.git`, `${root}/other`, ["-q"], GIT_ENV)
    const tags = yield* Effect.forEach(targets, (target, at) =>
      Effect.promise(() => write(`${root}/other/.git/tag-${at}`, tagObject(target, { name: "other", email: "other@example.invalid", at: 1_794_416_400 + at }))).pipe(
        Effect.map(() => sh(`${root}/other`, ["git", "hash-object", "-t", "tag", "-w", `${root}/other/.git/tag-${at}`])),
      ),
    )
    yield* Effect.promise(() => write(`${root}/tags`, tags.map((oid) => `${oid}\n`).join("")))
    yield* Effect.promise(() =>
      write(
        `${root}/bin/git`,
        [
          "#!/bin/sh",
          `if [ "$1" = "-C" ] && [ "$2" = '${root}/dotfiles' ] && [ "$3" = "hash-object" ]; then`,
          `  n=$(cat '${root}/pushes' 2>/dev/null || echo 0)`,
          `  echo $((n + 1)) > '${root}/pushes'`,
          `  oid=$(sed -n "$((n + 1))p" '${root}/tags')`,
          `  if [ -n "$oid" ]; then '${REAL_GIT}' -C '${root}/other' push --quiet origin "+$oid:${VERIFIED_REF}"; fi`,
          "fi",
          `exec '${REAL_GIT}' "$@"`,
          "",
        ].join("\n"),
        { createPath: true },
      ),
    )
    sh(root, ["chmod", "755", `${root}/bin/git`])
    return `${root}/bin/git`
  })

/** A tag object for `target` as another host wrote it, stored in `root/<name>.tag`. */
const tagFile = (root: string, name: string, target: { readonly dotfiles: string; readonly fork: string; readonly batch: string }) =>
  Effect.promise(() => write(`${root}/${name}.tag`, tagObject(target, { name: "other", email: "other@example.invalid", at: 1_794_416_400 }))).pipe(Effect.as(`${root}/${name}.tag`))

/** Another host, a clone of the dotfiles origin, publishes `target` now. */
const otherHostPublishesNow = (root: string, target: { readonly dotfiles: string; readonly fork: string; readonly batch: string }) =>
  Effect.gen(function* () {
    gitClone(`${root}/dotfiles.git`, `${root}/other`, ["-q"], GIT_ENV)
    const oid = sh(`${root}/other`, ["git", "hash-object", "-t", "tag", "-w", yield* tagFile(root, "now", target)])
    sh(`${root}/other`, ["git", "push", "--quiet", "origin", `+${oid}:${VERIFIED_REF}`])
  })

describe("the tag object a record pushes", () => {
  test(
    "the verifier's probe: a stale tag file left unwritable in the git directory is never what is pushed; the record publishes its own target",
    () =>
      onRepositories(3, (root, [d1, d2, d3], [f1]) =>
        Effect.gen(function* () {
          yield* record(root, "batch-x", both(d1, f1))
          const stale = `${root}/dotfiles/.git/fleet-verified.tag`
          yield* Effect.promise(() => write(stale, tagObject({ dotfiles: d1, fork: f1, batch: "batch-x" }, { name: "t", email: "t@example.invalid", at: 1_794_416_400 })))
          sh(root, ["chmod", "444", stale])
          yield* otherHostPublishesNow(root, { dotfiles: d2, fork: f1, batch: "batch-n" })
          expect(yield* record(root, "batch-y", both(d3, f1))).toEqual(FleetOutcome.Recorded({ target: { dotfiles: d3, fork: f1, batch: "batch-y" } }))
          expect(recorded(root)).toEqual(Option.some({ dotfiles: d3, fork: f1, batch: "batch-y" }))
        }),
      ),
    60_000,
  )

  test(
    "a stored tag object that does not name the batch's commits is refused, saying so, and nothing is pushed",
    () =>
      onRepositories(3, (root, [d1, d2, d3], [f1]) =>
        Effect.gen(function* () {
          yield* record(root, "batch-x", both(d1, f1))
          yield* otherHostPublishesNow(root, { dotfiles: d2, fork: f1, batch: "batch-n" })
          const wrong = yield* tagFile(root, "wrong", { dotfiles: d1, fork: f1, batch: "batch-x" })
          yield* Effect.promise(() =>
            write(
              `${root}/bin/git`,
              [
                "#!/bin/sh",
                `if [ "$1" = "-C" ] && [ "$2" = '${root}/dotfiles' ] && [ "$3" = "hash-object" ]; then exec '${REAL_GIT}' -C "$2" hash-object -t tag -w '${wrong}'; fi`,
                `exec '${REAL_GIT}' "$@"`,
                "",
              ].join("\n"),
              { createPath: true },
            ),
          )
          sh(root, ["chmod", "755", `${root}/bin/git`])
          expect(refused(yield* record(root, "batch-y", both(d3, f1), `${root}/bin/git`))).toContain(`does not name dotfiles ${d3.slice(0, 10)}, fork ${f1.slice(0, 10)} (batch-y): nothing pushed`)
          expect(recorded(root)).toEqual(Option.some({ dotfiles: d2, fork: f1, batch: "batch-n" }))
        }),
      ),
    60_000,
  )
})

describe("two hosts recording at once (the lease)", () => {
  test(
    "a host whose read target another host replaced before its push re-reads it: a batch behind the new target is refused, and the fleet never moves back",
    () =>
      onRepositories(3, (root, [d1, d2, d3], [f1]) =>
        Effect.gen(function* () {
          yield* record(root, "batch-x", both(d1, f1))
          const said = refused(yield* record(root, "batch-o", both(d2, f1), yield* otherHostPublishes(root, [{ dotfiles: d3, fork: f1, batch: "batch-n" }])))
          expect(said).toContain(`do not both descend from the current target (dotfiles ${d3.slice(0, 10)}, fork ${f1.slice(0, 10)}, batch-n)`)
          expect(recorded(root)).toEqual(Option.some({ dotfiles: d3, fork: f1, batch: "batch-n" }))
        }),
      ),
    60_000,
  )

  test(
    "a batch ahead of the target another host published meanwhile is published on the second push",
    () =>
      onRepositories(3, (root, [d1, d2, d3], [f1]) =>
        Effect.gen(function* () {
          yield* record(root, "batch-x", both(d1, f1))
          expect(yield* record(root, "batch-n", both(d3, f1), yield* otherHostPublishes(root, [{ dotfiles: d2, fork: f1, batch: "batch-o" }]))).toEqual(FleetOutcome.Recorded({ target: { dotfiles: d3, fork: f1, batch: "batch-n" } }))
          expect(recorded(root)).toEqual(Option.some({ dotfiles: d3, fork: f1, batch: "batch-n" }))
        }),
      ),
    60_000,
  )

  test(
    "a target that moves under both pushes is refused, saying so, and the other host's stands",
    () =>
      onRepositories(3, (root, [d1, d2, d3], [f1]) =>
        Effect.gen(function* () {
          yield* record(root, "batch-x", both(d1, f1))
          const twice = [
            { dotfiles: d2, fork: f1, batch: "batch-p" },
            { dotfiles: d2, fork: f1, batch: "batch-q" },
          ]
          expect(refused(yield* record(root, "batch-n", both(d3, f1), yield* otherHostPublishes(root, twice)))).toBe(
            `pushing ${VERIFIED_REF} was refused 2 times: another host published a target while this one recorded, or origin refused the push`,
          )
          expect(recorded(root)).toEqual(Option.some({ dotfiles: d2, fork: f1, batch: "batch-q" }))
        }),
      ),
    60_000,
  )
})
