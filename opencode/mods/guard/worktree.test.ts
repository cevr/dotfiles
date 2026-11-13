// The worktree rule on its own: which lines add a worktree and where git runs
// them, whatever the spelling; which checkouts Rift serves; and the words.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { Checkout } from "./service.ts"
import { Clones, HasWarmSource, normalizedOrigin, riftHome, worktreeAdds, worktreeReason } from "./worktree.ts"

const HOME = "/home/owner"
const CWD = "/home/owner/work"
const place = { cwd: CWD, home: HOME }
const adds = (line: string) => worktreeAdds(line, place).map((add) => add.directory)

describe("a worktree add is found", () => {
  test("in every spelling, with the directory git runs in", () => {
    for (const [line, directory] of [
      ["git worktree add ../x", CWD],
      ["git worktree add -b feature ../x main", CWD],
      ["git worktree add --detach ../x", CWD],
      ["git -C repo worktree add ../x", `${CWD}/repo`],
      ["git -C repo -C sub worktree add ../x", `${CWD}/repo/sub`],
      ["git -C ~/ergo worktree add ../x", `${HOME}/ergo`],
      ["git -C=repo worktree add ../x", CWD],
      ["git --no-pager -c core.hooksPath=/dev/null worktree add ../x", CWD],
      ["git --git-dir repo/.git worktree add ../x", `${CWD}/repo`],
      ["git -C repo --git-dir=.git worktree add ../x", `${CWD}/repo`],
      ["git --git-dir=repo/.git --work-tree=wt worktree add ../x", `${CWD}/wt`],
      ["/usr/bin/git worktree add ../x", CWD],
      ["env GIT_DIR=.git git worktree add ../x", CWD],
      ["FOO=1 git worktree add ../x", CWD],
      ["sudo -u owner git worktree add ../x", CWD],
      ["nohup git worktree add ../x", CWD],
      ["cd ~/ergo && git worktree add ../x", `${HOME}/ergo`],
      ["echo start; git worktree add ../x", CWD],
      ["true || git worktree add ../x", CWD],
      ["(cd repo; git worktree add ../x)", `${CWD}/repo`],
      ["sh -c 'git worktree add ../x'", CWD],
      ["bash -lc 'cd repo && git worktree add ../x'", `${CWD}/repo`],
      ["cd repo && zsh -c \"git -C sub worktree add ../x\"", `${CWD}/repo/sub`],
      ["eval git worktree add ../x", CWD],
    ] as const)
      expect([line, adds(line)]).toEqual([line, [directory]])
  })

  test("each add of a chained line, in order", () => {
    expect(adds("git worktree add ../a && cd /srv/b && git worktree add ../c")).toEqual([CWD, "/srv/b"])
  })

  test("and nothing else is: list, prune, remove and the rest of git worktree, other git commands, a word that only names one", () => {
    for (const line of [
      "git worktree list",
      "git worktree list --porcelain",
      "git worktree prune",
      "git worktree remove ../old",
      "git worktree remove --force ../old",
      "git worktree move ../a ../b",
      "git worktree lock ../a",
      "git worktree repair",
      "git log --grep 'worktree add'",
      "git status worktree add",
      "echo git worktree add ../x",
      "cat <<EOF\ngit worktree add ../x\nEOF",
      "grep -r 'git worktree add' .",
    ])
      expect([line, adds(line)]).toEqual([line, []])
  })
})

describe("Rift serves a checkout", () => {
  const checkout = (filesystem: string, origin?: string): Checkout => ({ root: "/home/owner/ergo", filesystem, origin: Option.fromNullishOr(origin) })

  test("on a file system it clones: APFS, btrfs, XFS", () => {
    for (const filesystem of ["apfs", "btrfs", "xfs", "APFS"]) expect(riftHome(checkout(filesystem), [])).toEqual(Option.some(Clones.make({ filesystem })))
  })

  test("elsewhere only through a warm source: itself, or one of the same origin in any URL form", () => {
    for (const filesystem of ["ext4", "ext2/ext3", "hfs", "tmpfs", "nfs", "zfs"]) expect(riftHome(checkout(filesystem, "x"), [])).toEqual(Option.none())
    const origin = "git@github.com:cevr/ergo.git"
    for (const url of ["https://github.com/cevr/ergo.git", "https://github.com/cevr/ergo", "ssh://git@github.com/cevr/ergo.git", "git@github.com:cevr/ergo", "https://github.com/cevr/ergo/"])
      expect([url, riftHome(checkout("ext4", origin), [{ path: "/workspaces/ergo", origin: Option.some(url) }])]).toEqual([
        url,
        Option.some(HasWarmSource.make({ source: "/workspaces/ergo" })),
      ])
    expect(riftHome(checkout("ext4"), [{ path: "/home/owner/ergo", origin: Option.none() }])).toEqual(Option.some(HasWarmSource.make({ source: "/home/owner/ergo" })))
  })

  test("and not through a warm source of another origin, or when either has none", () => {
    const sources = [
      { path: "/workspaces/bite", origin: Option.some("https://github.com/biteinc/maitred.git") },
      { path: "/workspaces/scratch", origin: Option.none() },
    ]
    expect(riftHome(checkout("ext4", "git@github.com:cevr/ergo.git"), sources)).toEqual(Option.none())
    expect(riftHome(checkout("ext4"), sources)).toEqual(Option.none())
  })

  test("an origin reads as host and path", () => {
    expect(normalizedOrigin("git@github.com:cevr/ergo.git")).toBe("github.com/cevr/ergo")
    expect(normalizedOrigin("https://token@github.com/cevr/ergo.git\n")).toBe("github.com/cevr/ergo")
    expect(normalizedOrigin("/home/owner/.cache/repo/cevr/effect-machine")).toBe("/home/owner/.cache/repo/cevr/effect-machine")
  })
})

test("the refusal names the copy, why Rift serves the checkout, and what to run instead", () => {
  const ergo: Checkout = { root: "/home/owner/ergo", filesystem: "ext4", origin: Option.none() }
  const add = { command: "git worktree add ../x", directory: "/home/owner/ergo/src" }
  expect(worktreeReason(add, ergo, HasWarmSource.make({ source: "/workspaces/ergo" }))).toBe(
    '`git worktree add ../x` makes a full copy of /home/owner/ergo, and Rift makes a copy-on-write one here (its warm source is /workspaces/ergo): make a Rift instead with the rift tool (`{ action: "create", branch }`), or `workrift create <branch>` on the workbox; `git worktree list`, `remove` and `prune` still run for the old worktrees',
  )
})
