// The plugin seam: the composition root on a stand-in host whose skill
// registry works like OpenCode's (one skill per id, transforms applied in
// order, a reload re-runs them and publishes `skill.updated`), over the
// filesystem scan of a scratch layout. It checks what OpenCode sees: the
// registry after the tier edits, the prompt's attachments, the catalog RPC,
// and a rescan on `skill.updated` that reloads only on a change.
// tests/skills.test.ts runs it in OpenCode.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Queue, Schedule, Schema, type Scope, Stream } from "effect"
import { Answer, SKILLS } from "@dotfiles/opencode-skills/catalog"
import SkillsPlugin, { live, make } from "./server.ts"

type Host = Parameters<(typeof SkillsPlugin)["effect"]>[0]
type Handler = (input: unknown) => Effect.Effect<unknown>

interface Info {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly path: string
  readonly content: string
}
interface Editor {
  list(): ReadonlyArray<Info>
  add(skill: Info): void
}
interface Prompt {
  readonly sessionID: string
  readonly messageID: string
  prompt: { text: string; skills?: Array<{ id: string; mention?: { start: number; end: number; text: string } }> }
  delivery: "steer"
}

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

const skillFile = (description: string, body: string) => `---\ndescription: ${description}\n---\n${body}\n`

/** A scratch layout: a project with a parent, a home and OpenCode's config directory in it. */
const layout = Effect.acquireRelease(
  Effect.sync(() => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "skills-seam-")))
    const home = join(dir, "home")
    const project = join(dir, "work", "app")
    mkdirSync(project, { recursive: true })
    const write = (path: string, contents: string) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, contents)
      return path
    }
    return { dir, home, config: join(home, ".config", "opencode"), project, write }
  }),
  (at) => Effect.sync(() => rmSync(at.dir, { recursive: true, force: true })),
)

/**
 * The plugin started on a stand-in host. `host` is what OpenCode loaded before
 * it: here, the global config skill winning over the project's `.claude` one,
 * as OpenCode's own plugin order can; `after` is what a host plugin
 * registered after it adds.
 */
const start = (at: Effect.Success<typeof layout>, before: ReadonlyArray<Info>, after: ReadonlyArray<Info> = []) =>
  Effect.gen(function* () {
    const transforms: Array<(editor: Editor) => void> = [(editor) => before.forEach((skill) => editor.add(skill))]
    let registry = new Map<string, Info>()
    let reloads = 0
    const events = yield* Queue.unbounded<{ readonly type: "skill.updated"; readonly data: object }>()
    const reload = Effect.sync(() => {
      const next = new Map<string, Info>()
      for (const transform of transforms) transform({ list: () => [...next.values()], add: (skill) => void next.set(skill.id, { ...skill }) })
      registry = next
      reloads += 1
    }).pipe(Effect.andThen(Queue.offer(events, { type: "skill.updated", data: {} })))
    const rpc: Record<string, Record<string, Handler>> = {}
    let prompt: ((event: Prompt) => Effect.Effect<void>) | undefined
    const host = {
      options: { home: at.home, config: at.config },
      location: { directory: at.project },
      skill: {
        list: () => Effect.sync(() => ({ location: { directory: at.project }, data: [...registry.values()] })),
        transform: (callback: (editor: Editor) => void) =>
          Effect.sync(() => {
            transforms.push(callback)
            return { dispose: Effect.void }
          }),
        reload: () => reload,
      },
      session: {
        hook: (name: string, callback: (event: Prompt) => Effect.Effect<void>) =>
          Effect.sync(() => {
            if (name === "prompt") prompt = callback
            return { dispose: Effect.void }
          }),
      },
      event: { subscribe: () => Stream.fromQueue(events) },
      rpc: {
        register: (definition: { readonly id: string }, handlers: Record<string, Handler>) =>
          Effect.sync(() => {
            rpc[definition.id] = handlers
            return { dispose: Effect.void, events: { emit: () => Effect.void } }
          }),
      },
    } as unknown as Host
    yield* make(live).effect(host)
    // A host plugin whose transform registered after this one's.
    transforms.push((editor) => after.forEach((skill) => editor.add(skill)))
    yield* reload
    const hook = prompt
    if (hook === undefined) return yield* Effect.die(new Error("the prompt hook was not registered"))
    const catalogHandler = rpc[SKILLS.id]?.catalog
    if (catalogHandler === undefined) return yield* Effect.die(new Error(`not registered: ${SKILLS.id}`))
    return {
      registry: () => registry,
      reload,
      reloads: () => reloads,
      send: (text: string, skills?: Prompt["prompt"]["skills"]) =>
        Effect.gen(function* () {
          const event: Prompt = { sessionID: "ses_1", messageID: "msg_1", prompt: skills ? { text, skills } : { text }, delivery: "steer" }
          yield* hook(event)
          return event.prompt.skills
        }),
      catalog: catalogHandler({}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Answer)), Effect.orDie),
    }
  })

describe("the skills plugin", () => {
  test("a collision: the project's skill holds the id, the user's is loadable as <id>:global, and both are in the catalog", () =>
    scenario(
      Effect.gen(function* () {
        const at = yield* layout
        const local = at.write(join(at.project, ".claude/skills/review/SKILL.md"), skillFile("Project review", "LOCAL BODY"))
        const global = at.write(join(at.config, "skills/review/SKILL.md"), skillFile("User review", "GLOBAL BODY"))
        const only = at.write(join(at.home, ".claude/skills/deploy/SKILL.md"), skillFile("User deploy", "DEPLOY BODY"))
        const plugin = yield* start(at, [
          { id: "deploy", name: "deploy", description: "User deploy", path: only, content: "DEPLOY BODY\n" },
          { id: "review", name: "review", description: "User review", path: global, content: "GLOBAL BODY\n" },
        ])
        const registry = plugin.registry()
        expect(registry.get("review")).toMatchObject({ path: local, content: "LOCAL BODY\n", description: "Project review" })
        expect(registry.get("review:local")).toMatchObject({ path: local, content: "LOCAL BODY\n", name: "review" })
        expect(registry.get("review:global")).toMatchObject({ path: global, content: "GLOBAL BODY\n", name: "review" })
        expect(registry.get("deploy")).toMatchObject({ path: only })
        expect((yield* plugin.catalog).entries).toEqual([
          { token: "deploy", id: "deploy", description: "User deploy", tier: "global", shadowed: false },
          { token: "review", id: "review:local", description: "Project review", tier: "local", shadowed: false },
          { token: "review:global", id: "review:global", description: "User review", tier: "global", shadowed: true },
        ])
      }),
    ))

  test("a host transform after this one keeps the global copy under the plain id: $<id> still reaches the local copy", () =>
    scenario(
      Effect.gen(function* () {
        const at = yield* layout
        const local = at.write(join(at.project, ".claude/skills/review/SKILL.md"), skillFile("Project review", "LOCAL BODY"))
        const global = at.write(join(at.config, "skills/review/SKILL.md"), skillFile("User review", "GLOBAL BODY"))
        const plugin = yield* start(at, [], [{ id: "review", name: "review", description: "User review", path: global, content: "GLOBAL BODY\n" }])
        expect(plugin.registry().get("review")).toMatchObject({ path: global })
        expect(plugin.registry().get("review:local")).toMatchObject({ path: local })
        expect((yield* plugin.catalog).entries.map((entry) => [entry.token, entry.id, entry.tier])).toEqual([
          ["review", "review:local", "local"],
          ["review:global", "review:global", "global"],
        ])
        expect(yield* plugin.send("$review")).toEqual([{ id: "review:local", mention: { start: 0, end: 7, text: "$review" } }])
      }),
    ))

  test("a sent prompt's tokens attach their skills once each; unknown tokens, prices and code stay text", () =>
    scenario(
      Effect.gen(function* () {
        const at = yield* layout
        at.write(join(at.project, ".claude/skills/review/SKILL.md"), skillFile("Project review", "LOCAL BODY"))
        at.write(join(at.config, "skills/review/SKILL.md"), skillFile("User review", "GLOBAL BODY"))
        const plugin = yield* start(at, [])
        expect(yield* plugin.send("$review and $review:global, $nope, $5, `$review`")).toEqual([
          { id: "review:local", mention: { start: 0, end: 7, text: "$review" } },
          { id: "review:global", mention: { start: 12, end: 26, text: "$review:global" } },
        ])
        // What the composer attached already stays, and is not attached twice.
        const picked = { id: "review:local", mention: { start: 0, end: 7, text: "$review" } }
        expect(yield* plugin.send("$review now", [picked])).toEqual([picked])
        // Nothing named: the prompt is left as it came.
        expect(yield* plugin.send("costs $5")).toBeUndefined()
      }),
    ))

  test("skill.updated scans again and reloads only when the files changed", () =>
    scenario(
      Effect.gen(function* () {
        const at = yield* layout
        at.write(join(at.project, ".claude/skills/review/SKILL.md"), skillFile("Project review", "LOCAL BODY"))
        const plugin = yield* start(at, [])
        // The start's reload published skill.updated; the scan had not changed, so no reload followed.
        yield* Effect.sleep("100 millis")
        expect(plugin.reloads()).toBe(1)
        expect(plugin.registry().has("review:global")).toBe(false)

        // A new global copy appears; OpenCode's watcher reloads, which publishes skill.updated.
        at.write(join(at.config, "skills/review/SKILL.md"), skillFile("User review", "GLOBAL BODY"))
        yield* plugin.reload
        // The plugin scans, sees the change and reloads once; that reload's event finds nothing new.
        yield* Effect.sync(() => (plugin.registry().has("review:global") ? Effect.void : Effect.fail("pending"))).pipe(
          Effect.flatten,
          Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }),
        )
        yield* Effect.sleep("100 millis")
        expect(plugin.reloads()).toBe(3)
      }),
    ))
})
