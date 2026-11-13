// Checkouts over real git, df and mount in a scratch directory this test makes
// and removes: a checkout with an origin and a directory in it, one with no
// origin, a plain directory and a missing path; the warm sources from a
// stand-in `workrift` that lists two of them, one that fails, and none. git
// runs with no global or system config, so the owner's own settings (an
// `insteadOf`) change nothing.
import { describe, expect, test } from "bun:test"
import { env as processEnv, spawnSync, write } from "bun"
import { Effect, Option } from "effect"
import { gitInit } from "../../../tests/git-repo.ts"
import { scratch } from "../../../tests/scratch.ts"
import { checkoutsLaws } from "../laws.ts"
import * as ProcessCheckouts from "./checkouts.ts"

const ORIGIN = "git@github.com:owner/app.git"

/** A command's stdout, trimmed; a test step that must work. */
const sh = (argv: ReadonlyArray<string>, env: Readonly<Record<string, string>>) => spawnSync([...argv], { env: { ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()

/** The type `mount` names for the file system `path` sits on, read another way: macOS's scratch is APFS; Linux asks findmnt. */
const filesystemAt = (path: string, env: Readonly<Record<string, string>>) => {
  if (sh(["uname", "-s"], env) === "Darwin") return "apfs"
  return sh(["findmnt", "-no", "FSTYPE", "-T", path], env)
}

/** An executable script at `path`. */
const script = (path: string, text: string, env: Readonly<Record<string, string>>) =>
  Effect.promise(() => write(path, text, { createPath: true })).pipe(Effect.map(() => sh(["chmod", "755", path], env)))

/** The scratch layout, its `workrift` listing `app` and `bare` (or failing, or absent), and the layer over it. */
const bench = (sources: "listed" | "failing" | "absent") =>
  Effect.gen(function* () {
    const held = yield* Effect.acquireRelease(
      Effect.sync(() => scratch("guard-checkouts-")),
      (dir) => Effect.sync(() => dir[Symbol.dispose]()),
    )
    const env = { PATH: processEnv["PATH"] ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
    const dir = sh(["realpath", held.path], env)
    const withCeiling = { ...env, GIT_CEILING_DIRECTORIES: dir }
    const [repo, bare, plain] = [`${dir}/app`, `${dir}/bare`, `${dir}/plain`]
    yield* Effect.forEach([`${repo}/src/.keep`, `${bare}/.keep`, `${plain}/.keep`], (path) => Effect.promise(() => write(path, "", { createPath: true })), { discard: true })
    gitInit(repo, ["-q"], withCeiling)
    gitInit(bare, ["-q"], withCeiling)
    sh(["git", "-C", repo, "remote", "add", "origin", ORIGIN], withCeiling)
    const workrift = `${dir}/bin/workrift`
    if (sources === "listed") yield* script(workrift, `#!/bin/sh\n[ "$1" = sources ] || exit 2\nprintf '%s\\n' '${repo}' '${bare}'\n`, env)
    if (sources === "failing") yield* script(workrift, "#!/bin/sh\necho 'registry locked' >&2\nexit 3\n", env)
    const listed = [
      { path: repo, origin: Option.some(ORIGIN) },
      { path: bare, origin: Option.none<string>() },
    ]
    const expected = { listed, failing: "unreadable" as const, absent: [] }
    return {
      layer: ProcessCheckouts.layer({ workrift, env: withCeiling }),
      repo,
      origin: ORIGIN,
      filesystem: filesystemAt(repo, env),
      inside: `${repo}/src`,
      bare,
      plain,
      missing: `${dir}/nowhere`,
      sources: expected[sources],
    }
  })

checkoutsLaws("the process Checkouts beside a workrift listing two warm sources", () => bench("listed"))
checkoutsLaws("the process Checkouts beside a workrift that fails", () => bench("failing"))
checkoutsLaws("the process Checkouts with no workrift", () => bench("absent"))

describe("reading df and mount", () => {
  test("the mount point is df's last line from its sixth field on", () => {
    expect(ProcessCheckouts.mountPointOf("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/loop0 409600000 147000000 262600000 36% /workspaces\n")).toEqual(
      Option.some("/workspaces"),
    )
    expect(ProcessCheckouts.mountPointOf("Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s5 965595304 1 2 99% /Volumes/My Disk")).toEqual(
      Option.some("/Volumes/My Disk"),
    )
    expect(ProcessCheckouts.mountPointOf("Filesystem")).toEqual(Option.none())
  })

  test("the type is mount's for that point, in Linux's and macOS's forms, the last mount over it winning", () => {
    const linux = [
      "/dev/vda on / type ext4 (rw,relatime)",
      "/dev/loop0 on /workspaces type btrfs (rw,relatime,compress=zstd:3,discard=async)",
      "tmpfs on /workspaces/tmp type tmpfs (rw)",
    ].join("\n")
    expect(ProcessCheckouts.filesystemOf(linux, "/")).toEqual(Option.some("ext4"))
    expect(ProcessCheckouts.filesystemOf(linux, "/workspaces")).toEqual(Option.some("btrfs"))
    expect(ProcessCheckouts.filesystemOf(linux, "/home")).toEqual(Option.none())
    const mac = [
      "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
      "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)",
      "/dev/disk5s1 on /Volumes/My Disk (msdos, local, nodev)",
    ].join("\n")
    expect(ProcessCheckouts.filesystemOf(mac, "/System/Volumes/Data")).toEqual(Option.some("apfs"))
    expect(ProcessCheckouts.filesystemOf(mac, "/Volumes/My Disk")).toEqual(Option.some("msdos"))
    expect(ProcessCheckouts.filesystemOf(`${linux}\n/dev/vdb on / type xfs (rw)`, "/")).toEqual(Option.some("xfs"))
  })
})
