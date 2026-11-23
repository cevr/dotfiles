// scripts/agents.ts's orchestrator entry: its section carries SKILL.md's no-block rule word for word, and `--check`
// fails once that line changes in the skill without `bun run agents` writing agents.json again.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcessSpawner } from "effect/process"
import { scratchInput } from "../tests/read-path.ts"
import { checkoutAgents } from "../tests/agent-fixture.ts"
import { checkoutBunCommand } from "../tests/scratch-child.ts"
import { NO_BLOCK, orchestratorSection } from "./agents.ts"

const live = it.live.layer(BunServices.layer)

/** The written file's orchestrator entry. */
const Written = Schema.fromJsonString(Schema.Struct({ orchestrator: Schema.Struct({ description: Schema.String, section: Schema.String }) }))

/** SKILL.md and its no-block rule line. */
const skill = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString("../skills/orchestrate/SKILL.md")
  const rule = yield* Effect.fromOption(Option.fromNullishOr(text.split("\n").find((line) => line.startsWith(NO_BLOCK))))
  return { text, rule }
})

/** `bun scripts/agents.ts --check`, with the skill at `source`: its exit code and stderr. */
const check = (dir: string, ...source: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const request = scratchInput(path.join(dir, "args.json"))
      yield* fs.writeFileString(request, JSON.stringify(["--check", ...source]))
      const handle = yield* spawner.spawn(
        checkoutBunCommand("scripts/fixtures/agents-check.ts", {
          scratchArgs: [request],
          scratch: { HOME: dir, TMPDIR: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir },
          external: {},
          values: {},
        }),
      )
      const [code, stderr] = yield* Effect.all([handle.exitCode, handle.stderr.pipe(Stream.decodeText(), Stream.mkString)], { concurrency: 2 })
      return { code: Number(code), stderr }
    }),
  )

/** The skill, protocol, safety rules and worker source, copied under `dir`. The compiler itself stays canonical. */
const copySkill = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const source = path.join(dir, "skills/orchestrate")
    yield* fs.makeDirectory(source, { recursive: true })
    yield* fs.copyFile("../skills/orchestrate/SKILL.md", path.join(source, "SKILL.md"))
    yield* fs.copyFile("../skills/orchestrate/protocol.md", path.join(source, "protocol.md"))
    yield* fs.makeDirectory(path.join(dir, "skills/loop"), { recursive: true })
    yield* fs.copyFile("../skills/loop/safety.md", path.join(dir, "skills/loop/safety.md"))
    yield* fs.makeDirectory(path.join(dir, "agents"))
    yield* fs.copyFile("../agents/worker.md", path.join(dir, "agents/worker.md"))
    return source
  })

describe("the orchestrator entry", () => {
  live("its section ends with SKILL.md's no-block rule, word for word", () =>
    Effect.gen(function* () {
      const { rule } = yield* skill
      const built = checkoutAgents()
      const written = yield* Schema.decodeUnknownEffect(Written)(built.text)
      expect(written.orchestrator.section.endsWith(rule.slice(2))).toBe(true)
      expect(written.orchestrator.section).toContain("Load the `orchestrate` skill before you coordinate")
      expect(written.orchestrator.section).toContain("A plain question or a small edit needs no run")
    }),
  )

  live("--check is green on the written file, and fails once the skill's rule line is edited without regenerating", () =>
    Effect.scoped(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { text, rule } = yield* skill
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "agents-check-" })
      expect(yield* check(dir)).toMatchObject({ code: 0 })
      const source = yield* copySkill(dir)
      // The copy as it is matches the written file.
      expect(yield* check(dir, "--source", source)).toMatchObject({ code: 0 })
      yield* fs.writeFileString(path.join(source, "SKILL.md"), text.replace(rule, rule.replace("about 10 seconds", "about 30 seconds")))
      const edited = yield* check(dir, "--source", source)
      expect(edited.code).toBe(1)
      expect(edited.stderr).toContain("stale:")
    })),
  )

  live("a skill that lost the rule fails the build, naming it", () =>
    Effect.gen(function* () {
      const { text, rule } = yield* skill
      expect(() => orchestratorSection(text.replace(rule, ""))).toThrow(NO_BLOCK)
    }),
  )
})
