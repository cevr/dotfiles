// The runs of a real git repository in a scratch directory, read through a
// stand-in for the orchestrate skill's status script: it prints the
// `table.md` each run holds, and fails with a message on stderr for a run
// holding `broken`.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { runTablesLaws } from "../laws.ts"
import * as RunScript from "./run-tables.ts"

const scratch = Effect.acquireRelease(
  Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), "status-run-tables-")))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.sync(() => Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode).pipe(
    Effect.flatMap((code) => (code === 0 ? Effect.void : Effect.die(new Error(`git ${args.join(" ")} exited ${code}`)))),
  )

const STATUS_SCRIPT = `
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
const dir = process.argv[2]
if (existsSync(join(dir, "broken"))) { console.error("cannot read " + dir); process.exit(1) }
process.stdout.write(readFileSync(join(dir, "table.md"), "utf8"))
`

runTablesLaws("the status script's RunTables", (tables) =>
  Effect.gen(function* () {
    const dir = yield* scratch
    const repository = join(dir, "repo")
    const outside = join(dir, "outside")
    mkdirSync(repository)
    mkdirSync(outside)
    yield* git(repository, "init", "-q")
    const runs = join(repository, "tmp/orchestrate")
    for (const { name, table } of tables) {
      mkdirSync(join(runs, name), { recursive: true })
      writeFileSync(join(runs, name, "table.md"), table)
    }
    const script = join(dir, "status.ts")
    writeFileSync(script, STATUS_SCRIPT)
    return {
      layer: RunScript.layer(script),
      repository,
      outside,
      spoil: Effect.sync(() => {
        for (const { name } of tables) writeFileSync(join(runs, name, "broken"), "")
      }),
    }
  }),
)
