// @reads all
// @reads-reason computed read at scripts/agents.ts: const protocol = readFileSync(join(sourceDir, "protocol.md"), "utf8")
// scripts/agents.ts's orchestrator entry: its section carries SKILL.md's no-block rule word for word, and `--check`
// fails once that line changes in the skill without `bun run agents` writing agents.json again.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { matchingInput } from "../tests/read-path.ts"
import { build, NO_BLOCK, orchestratorSection, ROOT } from "./agents.ts"

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
const check = (...source: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const path = yield* Path.Path
      const handle = yield* spawner.spawn(
        ChildProcess.make("bun", [path.join(ROOT, "scripts/agents.ts"), "--check", ...source], { extendEnv: true, stdin: "ignore", forceKillAfter: "3 seconds" }),
      )
      const [code, stderr] = yield* Effect.all([handle.exitCode, handle.stderr.pipe(Stream.decodeText(), Stream.mkString)], { concurrency: 2 })
      return { code: Number(code), stderr }
    }),
  )

/** The orchestrate skill and what its agents script reads beside it (loop/safety.md, the agents dir, the canonical round policy), under `dir`. */
const copySkill = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const source = path.join(dir, "skills/orchestrate")
    yield* fs.makeDirectory(path.join(source, "scripts"), { recursive: true })
    yield* Effect.forEach(["SKILL.md", "protocol.md", "scripts/agents.ts", "scripts/round-policy.ts"], (file) =>
      fs.copyFile(matchingInput("../skills/orchestrate/{SKILL.md,protocol.md,scripts/agents.ts,scripts/round-policy.ts}", `../skills/orchestrate/${file}`), path.join(source, file)))
    // The skill's round-policy.ts places the canonical policy, which ships with the plugin: it stands at the same place relative to the skill.
    const leaf = path.join(dir, "opencode/mods/orchestrate")
    yield* fs.makeDirectory(leaf, { recursive: true })
    yield* Effect.forEach(["round-policy.ts", "immutable.ts"], (file) =>
      fs.copyFile(matchingInput("mods/orchestrate/{round-policy.ts,immutable.ts}", `mods/orchestrate/${file}`), path.join(leaf, file)))
    yield* fs.makeDirectory(path.join(dir, "skills/loop"), { recursive: true })
    yield* fs.copyFile("../skills/loop/safety.md", path.join(dir, "skills/loop/safety.md"))
    yield* fs.copy("../agents", path.join(dir, "agents"))
    return source
  })

describe("the orchestrator entry", () => {
  live("its section ends with SKILL.md's no-block rule, word for word", () =>
    Effect.gen(function* () {
      const { rule } = yield* skill
      const built = yield* Effect.promise(() => build())
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
      expect(yield* check()).toMatchObject({ code: 0 })
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "agents-check-" })
      const source = yield* copySkill(dir)
      // The copy as it is matches the written file.
      expect(yield* check("--source", source)).toMatchObject({ code: 0 })
      yield* fs.writeFileString(path.join(source, "SKILL.md"), text.replace(rule, rule.replace("about 10 seconds", "about 30 seconds")))
      const edited = yield* check("--source", source)
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
