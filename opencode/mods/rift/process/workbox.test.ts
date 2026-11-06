// The process Workbox over stand-in scripts on PATH: a `workrift` that prints
// its arguments, where it ran and WORKRIFT_SOURCE, and fails on `check`, and
// a `workbox-rift-storage` that prints its argument. `df` is the host's own.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { Workbox, type WorkboxCommand } from "../service.ts"
import * as ProcessWorkbox from "./workbox.ts"

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "rift-workbox-")))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const bin = join(scratch, "bin")
mkdirSync(bin)
const script = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
}
script("workrift", '[ "$1" = check ] && { echo "source is dirty" >&2; exit 1; }\necho "workrift $* in $PWD source=${WORKRIFT_SOURCE:-none}"')
script("workbox-rift-storage", 'echo "storage $*"')

const run = (workrift: boolean, command: WorkboxCommand, source?: string) =>
  Effect.runPromise(
    Effect.flatMap(Workbox, (workbox) => Effect.result(workbox.run(command, scratch, source))).pipe(
      Effect.provide(ProcessWorkbox.layer({ workrift, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, WORKBOX_RIFT_MOUNT: scratch } })),
    ),
  )

test("runs workrift as it is, with the source in WORKRIFT_SOURCE, prune only as a dry run", async () => {
  const printed = async (command: WorkboxCommand, source?: string) => {
    const ran = await run(true, command, source)
    return ran._tag === "Success" ? ran.success : `failed: ${String(ran.failure)}`
  }
  expect(await printed({ _tag: "refresh" }, "/code/app")).toBe(`workrift refresh in ${scratch} source=/code/app\n`)
  expect(await printed({ _tag: "prune" })).toBe(`workrift prune --dry-run in ${scratch} source=none\n`)
  expect(await printed({ _tag: "init", repository: "git@github.com:o/r.git", path: "/workspaces/r" })).toBe(`workrift init git@github.com:o/r.git /workspaces/r in ${scratch} source=none\n`)
})

test("storage is the storage check and the file system's use; a failing command fails with what it said", async () => {
  const storage = await run(true, { _tag: "storage" })
  expect(storage._tag === "Success" && storage.success).toStartWith("storage --check\nFilesystem")
  const failed = await run(true, { _tag: "check" }, "/code/app")
  expect(failed._tag === "Failure" && failed.failure).toMatchObject({ _tag: "RiftFailed", operation: "workrift check", message: "source is dirty" })
})

test("without workrift every command is NotOnWorkbox", async () => {
  const refused = await run(false, { _tag: "sources" })
  expect(refused._tag === "Failure" && refused.failure).toMatchObject({ _tag: "NotOnWorkbox", command: "sources" })
})
