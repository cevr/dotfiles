// accept: deep (16.3 s alone on a quiet host: 1-minute load 7–13 on 12 cores; it installs a tree and starts a service and a TUI from source with every plugin)
// A build's plugin tree, loaded by real OpenCode: every plugin its overlay configures runs, from the tree alone.
//
// The tree is made as a make makes it (mods/update/filestore/trees.ts): this checkout's HEAD `opencode/`
// from git's object store, installed with `--frozen-lockfile` and no link into the fork, and its entries
// and overlay written by its own `scripts/daily.ts --tree`, for a host outside the fleet (so the pool and
// mail join no peer) and a live checkout that is not a git repository. The fork runs from source, so it
// binds no overlay beside its executable (packages/cli/src/adjacent-config.ts): the test sets the two
// variables that binding sets, as it would. The service then lists every configured plugin as active,
// each from inside the tree and none with a TUI part (each server entry is the plugin's server alone);
// the TUI's own plugins dialog shows its plugins, from the tree, with none failed.
import { describe } from "bun:test"
import { Data, Effect, FileSystem, Match, Option, Schedule, Schema } from "effect"
import { expect, it } from "effect-bun-test"
import { Base64 } from "effect/encoding"
import { HttpClient, HttpClientRequest } from "effect/http"
import { buildName } from "../mods/update/builds.ts"
import { treeOf } from "../mods/update/trees.ts"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { hostCall, serve } from "../testbeds/gamut/pty-host.ts"
import { ENV, Platform, run } from "./reconnect/host.ts"
import { forkRuns, keptScratch } from "./scratch.ts"
import { freePort, ready, type Service } from "./service.ts"

const TIMEOUT_MS = 240_000
const VERSION = "2.2.7-prime.f0f0f0f0.d0d0d0d0"
/** A host outside the fleet: the overlay gives it no peers and no Tailscale listener. */
const HOST = "plugin-tree-test"

class NotYet extends Data.TaggedError("NotYet")<{ readonly message: string }> {}

/** A plugin entry of the overlay: a path, or a path with options; a `-name` turns a built-in off. */
const Entry = Schema.Union([Schema.String, Schema.Struct({ package: Schema.String })])
const Overlay = Schema.Struct({ plugins: Schema.Array(Entry) })
const decodeOverlay = Schema.decodeUnknownEffect(Schema.fromJsonString(Overlay))
const pathOf = (entry: typeof Entry.Type) => Match.value(entry).pipe(Match.when(Match.string, (path) => path), Match.orElse((options) => options.package))

/** A plugin as `/api/plugin` lists it: where it loads from, whether it runs, and whether it has a TUI part. */
const Listed = Schema.Struct({
  source: Schema.Struct({ path: Schema.optionalKey(Schema.String) }),
  state: Schema.Struct({ status: Schema.String, error: Schema.optionalKey(Schema.Unknown) }),
  features: Schema.Struct({ tui: Schema.optionalKey(Schema.Boolean) }),
})
const decodeListed = Schema.decodeUnknownEffect(Schema.Struct({ data: Schema.Array(Listed) }))

const authorization = (service: Service) => ({ authorization: `Basic ${Base64.encode(`opencode:${service.password}`)}` })

describe.skipIf(!forkRuns)("a build's plugin tree, loaded by real OpenCode", () => {
  const kept = keptScratch(forkRuns, "plugin-tree-")
  it.scopedLive.layer(Platform)(
    "the service runs every plugin the tree's overlay configures, from the tree, none with a TUI part; the TUI's plugins load from it too",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { fork, path } = yield* ENV
        // A short folder name: the terminal host's socket lives in it, and a socket path has at most 104 bytes on macOS.
        const root = yield* fs.realPath(kept.dir("t"))
        const home = `${root}/home`
        const state = `${home}/.local/state`
        for (const dir of ["work", "live", "share", "home", "home/.config", "home/.config/opencode", "home/.local", "home/.local/state", "home/.local/state/opencode"]) yield* fs.makeDirectory(`${root}/${dir}`)
        const work = `${root}/work`
        const base = { PATH: path, HOME: home }
        const ok = (argv: ReadonlyArray<string>, cwd: string, env: { readonly [name: string]: string } = base) =>
          run(argv, cwd, env).pipe(Effect.tap((ran) => Effect.sync(() => expect({ argv, code: ran.code, err: ran.err.slice(-1500) }).toMatchObject({ code: 0 }))))

        // The tree, as a make makes it: HEAD's opencode/, its own install, its own daily's entries and overlay.
        const checkout = (yield* ok(["git", "rev-parse", "--show-toplevel"], ".")).out.trim()
        const tree = `${root}/share/${treeOf(buildName(VERSION))}`
        yield* fs.makeDirectory(tree)
        yield* ok(["git", "-C", checkout, "archive", "--format=tar", `--output=${root}/opencode.tar`, "HEAD", "opencode"], root)
        yield* ok(["tar", "-xf", `${root}/opencode.tar`, "-C", tree], root)
        yield* ok([process.execPath, "install", "--frozen-lockfile"], `${tree}/opencode`)
        yield* ok([process.execPath, `${tree}/opencode/scripts/daily.ts`, "--tree", tree, "--at", tree, "--checkout", `${root}/live`, "--host", HOST], `${tree}/opencode`, { ...base, OPENCODE_DEV: fork })
        const links = (yield* ok(["find", tree, "-type", "l"], tree)).out.split("\n").filter((line) => line !== "")
        const outside = (yield* ok(["realpath", ...links], tree)).out.split("\n").filter((line) => line !== "" && !line.startsWith(`${tree}/`))
        expect(outside).toEqual([])

        const server = yield* decodeOverlay(yield* fs.readFileString(`${tree}/config/opencode.json`))
        const configured = server.plugins.map(pathOf).filter((entry) => !entry.startsWith("-"))
        expect(configured.length).toBeGreaterThan(20)
        expect(configured.every((entry) => entry.startsWith(`${tree}/entries/server/`))).toBe(true)
        const cli = yield* fs.readFileString(`${tree}/config/cli.json`)
        const tui = (yield* decodeOverlay(cli)).plugins.map(pathOf).filter((entry) => !entry.startsWith("-"))
        expect(tui.every((entry) => entry.startsWith(`${tree}/opencode/cmd/`))).toBe(true)
        // Beside the entries, the settings the build carries (scripts/daily.ts `treeSettings`; tests/settings-follow.test.ts folds them).
        const settings = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ agents: Schema.Record(Schema.String, Schema.Struct({ model: Schema.String })), providers: Schema.Unknown })))(yield* fs.readFileString(`${tree}/config/opencode.json`))
        expect(Object.keys(settings.agents).toSorted()).toEqual(["implementor", "planner", "verifier", "worker"])
        expect(settings.providers).toEqual({ anthropic: { settings: { cache: { ttl: "1h" } } } })
        // The TUI overlay lists plugins alone: the theme and the tab scope are the owner's, picked in the TUI.
        expect(Object.keys(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(cli))).toEqual(["plugins"])

        // The service and the TUI from source, bound to the tree's overlay as the binary binds its own.
        const launch = forkLaunch(fork, process.execPath)
        const env = {
          ...base,
          TERM: "xterm-256color",
          HERDR_ENV: "1",
          XDG_CONFIG_HOME: `${home}/.config`,
          XDG_DATA_HOME: `${home}/.local/share`,
          XDG_STATE_HOME: state,
          XDG_CACHE_HOME: `${home}/.cache`,
          OPENCODE_DB: `${root}/opencode.db`,
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_FILEWATCHER: "1",
          OPENCODE_CONFIG: `${tree}/config/opencode.json`,
          OPENCODE_CLI_CONFIG_CONTENT: cli,
          ...launch.env,
        }
        const serviceFile = `${state}/opencode/service-local.json`
        const opencode = (...args: ReadonlyArray<string>) => run([...launch.base, ...args], work, env)
        expect(yield* opencode("service", "set", "port", String(freePort()))).toMatchObject({ code: 0 })
        const registered = fs.exists(serviceFile).pipe(Effect.orElseSucceed(() => false))
        const started = yield* Effect.acquireRelease(opencode("service", "start"), () => Effect.asVoid(Effect.when(opencode("service", "stop"), registered)))
        expect(started).toMatchObject({ code: 0 })
        const service = yield* Effect.promise(() => ready(serviceFile, () => `the service (${started.err.slice(-500)})`))

        // Every configured plugin listed, settled, and running from inside the tree.
        const list = HttpClient.execute(
          HttpClientRequest.get(new URL("/api/plugin", service.url)).pipe(HttpClientRequest.setHeaders({ ...authorization(service), "x-opencode-directory": encodeURIComponent(work) })),
        ).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(decodeListed),
          Effect.map((body) => body.data.filter((plugin) => Option.isSome(Option.filter(Option.fromUndefinedOr(plugin.source.path), (at) => at.startsWith(`${tree}/`))))),
        )
        const settled = yield* list.pipe(
          Effect.filterOrFail((ours) => ours.length >= configured.length && ours.every((plugin) => plugin.state.status !== "loading" && plugin.state.status !== "pending")),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 120 }),
          Effect.orDie,
        )
        expect(settled.filter((plugin) => plugin.state.status !== "active").map((plugin) => ({ path: plugin.source.path, state: plugin.state }))).toEqual([])
        expect(configured.filter((entry) => !settled.some((plugin) => Option.isSome(Option.filter(Option.fromUndefinedOr(plugin.source.path), (at) => at.startsWith(entry)))))).toEqual([])
        expect(settled.filter((plugin) => plugin.features.tui === true).map((plugin) => plugin.source.path)).toEqual([])

        // The TUI's plugins dialog: its plugins from the tree's overlay, none failed.
        const socket = `${root}/tui.sock`
        yield* Effect.acquireRelease(
          Effect.sync(() => serve({ socket, cwd: work, command: [...launch.base], env: { ...env, OPENCODE_PASSWORD: service.password }, cols: 160, rows: 80 })),
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
        // The home screen's status bar names the service once the TUI is connected.
        yield* until((seen) => seen.some((row) => row.includes("✓ Server")), "the TUI never connected")
        yield* Effect.promise(() => hostCall(socket, { op: "type", text: "/plugins" }))
        // Enter only once the composer's command list has caught up with the text: under load an earlier one is swallowed.
        yield* until((seen) => seen.filter((row) => row.includes("/plugins")).length >= 2 && !seen.some((row) => row.includes("No results found")), "the composer never listed /plugins")
        yield* Effect.promise(() => hostCall(socket, { op: "keys", names: ["enter"] }))
        const shown = yield* until((seen) => seen.includes("TUI") && seen.includes("Server"), "the plugins dialog never showed")
        // One row per plugin of the TUI's overlay, each loaded from its local path: a failed one shows its error instead.
        const section = shown.slice(shown.indexOf("TUI") + 1, shown.indexOf("Server")).filter((row) => row !== "")
        expect(section.length).toBe(tui.length)
        expect(section.filter((row) => !/^(┃\s+)?dotfiles-opencode\.\S+\s+local$/.test(row))).toEqual([])
      }),
    TIMEOUT_MS,
  )
})
