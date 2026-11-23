// The settings follow an update: each build's tree carries the role models and Claude's cache lifetime
// (scripts/daily.ts `treeSettings`), so a new model release reaches the role agents with the next build and no
// update writes the owner's files. The theme's name and the tab scope are the owner's choices, made in the TUI:
// by-hand daily sets each only when his `cli.json` lacks it (`hostCli`), and a pick lasts.
//
// Real OpenCode from source on a scratch HOME, as plugin-tree.test.ts runs it: two trees whose catalogs
// differ in the newest Opus, each an overlay `config/opencode.json` and `config/cli.json` with the settings
// `--tree` writes there (the plugin entries beside them are plugin-tree.test.ts's; these trees list none, and
// their `cli.json` holds nothing else).
// The fork from source binds no overlay beside its executable (packages/cli/src/adjacent-config.ts), so the
// test sets the two variables that binding sets. The owner's global `opencode.json` sets a role's model and
// other fields by hand, and another agent; he has no `cli.json` yet, so the by-hand run writes Prime and the
// window scope there. A service on tree A reports A's model for each role and the owner's other fields; on
// tree B, B's; a new TUI on B shows the Prime theme and the window tab scope. The owner then picks another
// theme and tab scope in that TUI: a second TUI shows his picks, and a later by-hand run writes nothing over
// them. His `opencode.json` is byte-identical throughout, and his `cli.json` changes only by his picks.
// No model is called.
import { describe } from "bun:test"
import { Data, Effect, FileSystem, Option, Schedule, Schema } from "effect"
import { expect, it } from "effect-bun-test"
import { Base64 } from "effect/encoding"
import { HttpClient, HttpClientRequest } from "effect/http"
import { jsonText, treeSettings, writeSettings } from "../scripts/daily.ts"
import { type Catalog, forkLaunch } from "../testbeds/gamut/gamut.ts"
import { hostCall, serve } from "../testbeds/gamut/pty-host.ts"
import { ENV, Platform, run } from "./reconnect/host.ts"
import { forkRuns, keptScratch } from "./scratch.ts"
import { freePort, ready, type Service } from "./service.ts"

const TIMEOUT_MS = 180_000
const ROLES = ["planner", "implementor", "verifier", "worker"]

class NotYet extends Data.TaggedError("NotYet")<{ readonly message: string }> {}

/** A catalog whose newest Opus is `newest`. */
const catalogWith = (newest: string) =>
  ({ anthropic: { models: { "claude-opus-5-0": { family: "claude-opus", release_date: "2026-03-01" }, [newest]: { family: "claude-opus", release_date: "2026-11-01" } } } }) satisfies Catalog

/** The owner's global server config: a role's model and other fields set by hand, another agent of his, an unrelated key. */
const OWNER = {
  agents: {
    worker: { model: "openai/sol-6", description: "the owner's worker", steps: 7, temperature: 0.3 },
    build: { description: "the owner's build" },
  },
  autoupdate: false,
  share: "disabled",
}

/** An agent as `/api/agent` lists it: its id, model, and the fields the owner sets. */
const Agent = Schema.Struct({
  id: Schema.String,
  model: Schema.optionalKey(Schema.Struct({ id: Schema.String, providerID: Schema.String })),
  description: Schema.optionalKey(Schema.String),
  steps: Schema.optionalKey(Schema.Number),
})
const decodeAgents = Schema.decodeUnknownEffect(Schema.Struct({ data: Schema.Array(Agent) }))

const authorization = (service: Service) => ({ authorization: `Basic ${Base64.encode(`opencode:${service.password}`)}` })

describe.skipIf(!forkRuns)("the settings follow an update, from each build's tree", () => {
  const kept = keptScratch(forkRuns, "settings-follow-")
  it.scopedLive.layer(Platform)(
    "a service on tree A has A's role models and the owner's other fields; on tree B, B's; a TUI shows the Prime theme and window scope by-hand daily set, the owner's picks of both last into the next TUI and past a later by-hand run",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { fork, path } = yield* ENV
        // A short folder name: the terminal host's socket lives in it, and a socket path has at most 104 bytes on macOS.
        const root = yield* fs.realPath(kept.dir("s"))
        const home = `${root}/home`
        const config = `${home}/.config/opencode`
        const state = `${home}/.local/state`
        for (const dir of ["work", "a/config", "b/config", "home/.config/opencode", "home/.local/state/opencode"]) yield* fs.makeDirectory(`${root}/${dir}`, { recursive: true })
        const work = `${root}/work`

        // The owner's server config, and what a from-scratch by-hand daily writes beside it: no tree carries these.
        yield* fs.writeFileString(`${config}/opencode.json`, jsonText(OWNER))
        writeSettings(home)
        const owner = Effect.all([fs.readFileString(`${config}/opencode.json`), fs.readFileString(`${config}/cli.json`)])
        const before = yield* owner
        expect(before).toEqual([jsonText(OWNER), jsonText({ theme: { name: "prime" }, tabs: { scope: "window" } })])

        // Two builds' trees, whose catalogs differ in the newest Opus.
        const trees = { a: "claude-opus-5-5", b: "claude-opus-6-0" }
        for (const [tree, newest] of Object.entries(trees)) {
          const settings = treeSettings(catalogWith(newest))
          yield* fs.writeFileString(`${root}/${tree}/config/opencode.json`, jsonText({ ...settings, plugins: [] }))
          yield* fs.writeFileString(`${root}/${tree}/config/cli.json`, jsonText({ plugins: [] }))
        }

        const launch = forkLaunch(fork, process.execPath)
        const envOn = (tree: string) =>
          Effect.map(fs.readFileString(`${root}/${tree}/config/cli.json`), (cli) => ({
            PATH: path,
            HOME: home,
            TERM: "xterm-256color",
            HERDR_ENV: "1",
            XDG_CONFIG_HOME: `${home}/.config`,
            XDG_DATA_HOME: `${home}/.local/share`,
            XDG_STATE_HOME: state,
            XDG_CACHE_HOME: `${home}/.cache`,
            OPENCODE_DB: `${root}/opencode.db`,
            OPENCODE_DISABLE_MODELS_FETCH: "1",
            OPENCODE_DISABLE_FILEWATCHER: "1",
            OPENCODE_CONFIG: `${root}/${tree}/config/opencode.json`,
            OPENCODE_CLI_CONFIG_CONTENT: cli,
            ...launch.env,
          }))
        const serviceFile = `${state}/opencode/service-local.json`
        const registered = fs.exists(serviceFile).pipe(Effect.orElseSucceed(() => false))
        const opencode = (env: { readonly [name: string]: string }, ...args: ReadonlyArray<string>) => run([...launch.base, ...args], work, env)
        const port = String(freePort())

        /** A service on `tree`, stopped when the scope ends; the agents it lists. */
        const serviceOn = (tree: string) =>
          Effect.gen(function* () {
            const env = yield* envOn(tree)
            expect(yield* opencode(env, "service", "set", "port", port)).toMatchObject({ code: 0 })
            const started = yield* opencode(env, "service", "start")
            expect(started).toMatchObject({ code: 0 })
            const service = yield* Effect.promise(() => ready(serviceFile, () => `the service on tree ${tree} (${started.err.slice(-500)})`))
            const agents = yield* HttpClient.execute(
              HttpClientRequest.get(new URL(`/api/agent?location[directory]=${encodeURIComponent(work)}`, service.url)).pipe(HttpClientRequest.setHeaders({ ...authorization(service), "x-opencode-directory": encodeURIComponent(work) })),
            ).pipe(
              Effect.flatMap((response) => response.json),
              Effect.flatMap(decodeAgents),
              Effect.map((body) => body.data),
              // The location's agents list once its config plugins have run.
              Effect.filterOrFail((agents) => ROLES.every((role) => agents.some((agent) => agent.id === role)), () => new NotYet({ message: `the service on tree ${tree} lists no role agents yet` })),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
              Effect.orDie,
            )
            return { env, service, agents }
          })
        const stop = (env: { readonly [name: string]: string }) => Effect.asVoid(Effect.when(opencode(env, "service", "stop"), registered))
        const modelOf = (agents: ReadonlyArray<typeof Agent.Type>, id: string) =>
          Option.map(Option.fromNullishOr(agents.find((agent) => agent.id === id)?.model), (model) => `${model.providerID}/${model.id}`)
        const byId = (agents: ReadonlyArray<typeof Agent.Type>, id: string) => Option.fromNullishOr(agents.find((agent) => agent.id === id))

        // Tree A: A's newest Opus for every role, the owner's hand-set worker model losing to it, his other fields kept.
        const a = yield* Effect.acquireRelease(serviceOn("a"), (on) => stop(on.env))
        expect(ROLES.map((role) => modelOf(a.agents, role))).toEqual(ROLES.map(() => Option.some("anthropic/claude-opus-5-5")))
        expect(Option.map(byId(a.agents, "worker"), (worker) => [worker.description, worker.steps])).toEqual(Option.some(["the owner's worker", 7]))
        expect(Option.map(byId(a.agents, "build"), (build) => build.description)).toEqual(Option.some("the owner's build"))
        yield* stop(a.env)
        expect(yield* owner).toEqual(before)

        // Tree B, the next build: B's newest Opus, the owner's fields as before.
        const b = yield* Effect.acquireRelease(serviceOn("b"), (on) => stop(on.env))
        expect(ROLES.map((role) => modelOf(b.agents, role))).toEqual(ROLES.map(() => Option.some("anthropic/claude-opus-6-0")))
        expect(Option.map(byId(b.agents, "worker"), (worker) => [worker.description, worker.steps])).toEqual(Option.some(["the owner's worker", 7]))
        expect(Option.map(byId(b.agents, "build"), (build) => build.description)).toEqual(Option.some("the owner's build"))

        // A new TUI on tree B: its settings dialog shows the Prime theme and the window tab scope, as by-hand daily set them.
        const socket = `${root}/tui.sock`
        yield* Effect.acquireRelease(
          Effect.sync(() => serve({ socket, cwd: work, command: [...launch.base], env: { ...b.env, OPENCODE_PASSWORD: b.service.password }, cols: 160, rows: 80 })),
          (served) => Effect.promise(() => served.stop()),
        )
        yield* fs.exists(socket).pipe(Effect.filterOrFail(Boolean), Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }), Effect.orDie)
        const rows = Effect.promise(() => hostCall(socket, { op: "read", scope: "screen" })).pipe(Effect.map((read) => read.rows.map((row) => row.trim())))
        const until = (done: (seen: ReadonlyArray<string>) => boolean, what: string) =>
          rows.pipe(
            Effect.filterOrFail(done, (seen) => new NotYet({ message: `${what}:\n${seen.join("\n")}` })),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240 }),
            Effect.orDie,
          )
        const call = (request: Parameters<typeof hostCall>[1]) => Effect.asVoid(Effect.promise(() => hostCall(socket, request)))
        /** A slash command, typed once no dialog is open, entered once the composer's command list has caught up with it. */
        const command = (slash: string) =>
          Effect.gen(function* () {
            yield* until((seen) => !seen.some((row) => /Search (settings|themes)/.test(row)), `a dialog stayed open before ${slash}`)
            yield* call({ op: "type", text: slash })
            yield* until((seen) => seen.filter((row) => row.includes(slash)).length >= 2 && !seen.some((row) => row.includes("No results found")), `the composer never listed ${slash}`)
            yield* call({ op: "keys", names: ["enter"] })
          })
        /** The settings dialog's Theme and Scope rows, once both show `theme` and `scope`. */
        const settingsShow = (theme: string, scope: string) =>
          Effect.gen(function* () {
            yield* until((seen) => seen.some((row) => row.includes("✓ Server")), "the TUI never connected")
            yield* command("/settings")
            const [themeRow, scopeRow] = [new RegExp(`\\bTheme\\b\\s.*\\b${theme}\\b`), new RegExp(`\\bScope\\b\\s.*\\b${scope}\\b`)]
            const shown = yield* until((seen) => seen.some((row) => themeRow.test(row)) && seen.some((row) => scopeRow.test(row)), `the settings dialog never showed the theme ${theme} and the tab scope ${scope}`)
            expect(shown.filter((row) => themeRow.test(row) || scopeRow.test(row)).length).toBe(2)
            yield* call({ op: "keys", names: ["esc"] })
          })
        yield* settingsShow("prime", "this window")

        // The owner picks another theme (/themes) and another tab scope (/settings, Scope, → from "this window" to "current directory").
        yield* command("/themes")
        yield* until((seen) => seen.some((row) => row.includes("Search themes")), "the themes dialog never opened")
        yield* call({ op: "type", text: "classic" })
        // The owner's cli.json, once it holds `theme` and `scope`: the TUI writes a pick there.
        const Picked = Schema.fromJsonString(Schema.Struct({ theme: Schema.Struct({ name: Schema.String }), tabs: Schema.Struct({ scope: Schema.String }) }))
        const saved = (theme: string, scope: string) =>
          fs.readFileString(`${config}/cli.json`).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Picked)),
            Effect.filterOrFail((cli) => cli.theme.name === theme && cli.tabs.scope === scope, (cli) => new NotYet({ message: `cli.json never held the theme ${theme} and the scope ${scope}: ${jsonText(cli)}` })),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
            Effect.orDie,
          )
        // Each key only once the dialog shows what it acts on: under load an earlier one lands elsewhere.
        yield* until((seen) => seen.some((row) => /^┃\s+opencode-classic\b/.test(row)), "the themes dialog never selected opencode-classic")
        yield* call({ op: "keys", names: ["enter"] })
        yield* saved("opencode-classic", "window")
        yield* command("/settings")
        yield* until((seen) => seen.some((row) => row.includes("Search settings")), "the settings dialog never opened")
        yield* call({ op: "type", text: "Scope" })
        yield* until((seen) => seen.filter((row) => /^┃\s+Scope\b\s.*\bthis window\b/.test(row)).length === 1 && !seen.some((row) => /^(┃\s+)?Theme\b/.test(row)), "the settings search never narrowed to the Scope row")
        yield* call({ op: "keys", names: ["right"] })
        yield* until((seen) => seen.some((row) => /^┃\s+Scope\b\s.*\bcurrent directory\b/.test(row)), "the Scope row never moved to current directory")
        expect(yield* saved("opencode-classic", "cwd")).toMatchObject({ theme: { name: "opencode-classic" }, tabs: { scope: "cwd" } })
        yield* call({ op: "keys", names: ["esc"] })

        // A second TUI, as after a restart or the next day: the owner's picks, not Prime and the window scope.
        yield* call({ op: "restart", command: [...launch.base] })
        yield* settingsShow("opencode-classic", "current directory")

        // A later by-hand run writes nothing over the picks, and the owner's server config never changed.
        const afterPicks = yield* owner
        writeSettings(home)
        expect(yield* owner).toEqual(afterPicks)
        expect(afterPicks[0]).toBe(before[0])
      }),
    TIMEOUT_MS,
  )
})
// @reads-indirect themes/** scripts/** tests/** testbeds/** cmd/** mods/**
