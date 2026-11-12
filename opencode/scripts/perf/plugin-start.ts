// How long our server plugins take to start, per plugin and per location, on a
// scratch service: the owner's installed OpenCode binary (or the fork from source with
// `--fork`) in a scratch HOME with this checkout's server plugins, configured as
// `bun run daily` configures them; never the owner's running service.
//
//   bun scripts/perf/plugin-start.ts [--locations 4] [--alone 0] [--binary <path> | --fork <checkout>]
//     [--only kernel,memory] [--data] [--json out.json] [--cpu-prof <dir>]
//
// The service exports its Effect spans over OTLP to a receiver here, so the times are
// the host's own: per plugin `PluginModule.load` (resolving, watching, importing and
// evaluating its module graph, one plugin after another in each location) and
// `Plugin.load` (the plugin's own setup), per location `PluginSupervisor.resolve` (all
// its module loads) and `Plugin.activate` (every setup, built-ins included). Locations
// open together, as the owner's TUIs reconnect together after a restart. The wall times
// are from the spawn: `/api/info` 200 (until then the service answers 503) and, per
// location, the first answer of a plugin RPC (`dotfiles-opencode.skills/catalog`).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { anthropicAuthPlugin } from "../../testbeds/anthropic-auth.ts"
import { forkLaunch } from "../../testbeds/gamut/gamut.ts"
import { pluginDir } from "../daily.ts"
import { Data, Effect, Option, Schedule } from "effect"

/** Fewer locations set up than opened, after 90 s of looking. */
class SetupsPending extends Data.TaggedError("SetupsPending")<{ readonly count: number }> {}

type Entry = string | { readonly package: string; readonly options: Record<string, unknown> }

/** daily's server plugins, in its order, with the options that start work (no credentials, no listener, no peers). */
export const SERVER_PLUGINS: ReadonlyArray<Entry> = [
  anthropicAuthPlugin,
  { package: pluginDir("pool"), options: { cacheLifeMs: 3_600_000, paced: { openai: "openai" }, fleet: { host: "scratch", peers: [] } } },
  { package: pluginDir("orchestrate"), options: { codex: { pool: true } } },
  ...["guard", "kernel", "status", "queue", "git", "idle-compact", "mail", "questions", "wake", "skills", "rift", "tool-names", "cache", "web", "memory"].map(pluginDir),
]
export const nameOf = (entry: Entry): string => (typeof entry === "string" ? entry : entry.package).split("/").at(-1) ?? ""

export interface Span {
  readonly name: string
  readonly id: string
  readonly parent: string | undefined
  /** Epoch ms. */
  readonly start: number
  readonly end: number
  readonly attributes: Record<string, string>
}

export interface Options {
  /** The command that runs OpenCode: the installed binary, or the fork's CLI from source. */
  readonly launch: { readonly base: ReadonlyArray<string>; readonly env: Record<string, string> }
  readonly locations: number
  /**
   * Locations opened one at a time once the others answer, each after the last
   * answers. Their setups run on a service no other location holds busy, so they
   * time each plugin's own setup; the ones opened together share one JS thread,
   * and a setup that awaits once spans the other locations' work meanwhile.
   */
  readonly alone?: number
  readonly plugins?: ReadonlyArray<Entry>
  /** Copies of the owner's plugin data in the scratch HOME (see `copyData`). */
  readonly data?: boolean
  readonly cpuProfile?: string
}

export interface Location {
  readonly directory: string
  /** Ms from the spawn. */
  readonly asked: number
  readonly served: number
  /** The skills RPC's first answer, NaN without the skills plugin. */
  readonly live: number
  /** Opened on its own (`Options.alone`), not with the others. */
  readonly alone: boolean
}

export interface Measure {
  /** Ms from the spawn to the service file, and to `/api/info` 200. */
  readonly listening: number
  readonly ready: number
  readonly locations: ReadonlyArray<Location>
  /** Epoch ms of the spawn. */
  readonly t0: number
  readonly spans: ReadonlyArray<Span>
  readonly plugins: ReadonlyArray<string>
}

/** The owner's installed binary: the one `~/.local/bin/opencode` execs. */
export const installedBinary = (): string => {
  const launcher = readFileSync(join(homedir(), ".local/bin/opencode"), "utf8")
  const binary = /^exec '([^']+)'/m.exec(launcher)?.[1]
  if (binary === undefined) throw new Error("no binary in ~/.local/bin/opencode; pass --binary")
  return binary
}

/**
 * Copies of the owner's plugin data the plugins read at start (the cache ledger,
 * orchestrate's call log, memory, queues) and a link to the skills. Never wakes or
 * jobs: their entries register OS jobs. The copies live in the scratch HOME.
 */
const copyData = (home: string) => {
  const real = homedir()
  for (const item of [".cache/opencode-cache-ledger", ".cache/orchestrate", ".local/state/opencode-memory", ".local/state/opencode-queue"]) {
    if (!existsSync(join(real, item))) continue
    mkdirSync(dirname(join(home, item)), { recursive: true })
    Bun.spawnSync(["/bin/cp", "-R", join(real, item), join(home, item)])
  }
  mkdirSync(join(home, ".claude"), { recursive: true })
  if (existsSync(join(real, ".claude/skills"))) symlinkSync(join(real, ".claude/skills"), join(home, ".claude/skills"))
}

interface OtlpSpan {
  readonly name: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly startTimeUnixNano: string
  readonly endTimeUnixNano: string
  readonly attributes?: ReadonlyArray<{ readonly key: string; readonly value: { readonly stringValue?: string; readonly intValue?: string | number; readonly boolValue?: boolean } }>
}
type OtlpTraces = { readonly resourceSpans?: ReadonlyArray<{ readonly scopeSpans?: ReadonlyArray<{ readonly spans?: ReadonlyArray<OtlpSpan> }> }> }
const ms = (nanos: string) => Number(BigInt(nanos) / 1000n) / 1000

export const measure = async (options: Options): Promise<Measure> => {
  const plugins = options.plugins ?? SERVER_PLUGINS
  const root = mkdtempSync(join(tmpdir(), "plugin-start-"))
  const home = join(root, "home")
  const state = join(home, ".local/state")
  const write = (file: string, value: unknown) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value, null, 2))
  }
  write(join(home, ".config/opencode/opencode.json"), { autoupdate: false, plugins: [...plugins, "-opencode.tool.schedule"] })
  // The service's port is its channel's, the owner's service's too: the scratch one gets a free one.
  const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  write(join(home, ".config/opencode/service.json"), { port: free.port })
  free.stop(true)
  if (options.data) copyData(home)

  const spans: Array<Span> = []
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname !== "/v1/traces") await request.body?.cancel()
      else
        for (const resource of ((await request.json()) as OtlpTraces).resourceSpans ?? [])
          for (const scope of resource.scopeSpans ?? [])
            for (const span of scope.spans ?? [])
              spans.push({
                name: span.name,
                id: span.spanId,
                parent: span.parentSpanId || undefined,
                start: ms(span.startTimeUnixNano),
                end: ms(span.endTimeUnixNano),
                attributes: Object.fromEntries((span.attributes ?? []).map((item) => [item.key, String(item.value.stringValue ?? item.value.intValue ?? item.value.boolValue ?? "")])),
              })
      return Response.json({})
    },
  })

  const { alone: aloneCount = 0 } = options
  const directories = Array.from({ length: options.locations + aloneCount }, (_, index) => {
    const directory = join(root, "work", `location-${index}`)
    mkdirSync(directory, { recursive: true })
    Bun.spawnSync(["git", "init", "-q", directory])
    return directory
  })
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: join(home, ".cache"),
    OPENCODE_DB: join(root, "opencode.db"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${receiver.port}`,
    ...options.launch.env,
  }
  if (options.cpuProfile) env.BUN_OPTIONS = `${env.BUN_OPTIONS ?? ""} --cpu-prof --cpu-prof-dir=${resolve(options.cpuProfile)}`.trim()
  mkdirSync(join(root, "tmp"), { recursive: true })

  const logFile = join(root, "service.log")
  const started = performance.now()
  const t0 = Date.now()
  // Its own process group, stopped below whatever happens.
  const child = Bun.spawn([...options.launch.base, "serve", "--service"], { cwd: directories[0], env, stdout: Bun.file(logFile), stderr: Bun.file(logFile), detached: true })
  const since = () => performance.now() - started
  const deadline = Date.now() + 90_000
  const until = async <A>(read: () => Promise<A | undefined>, label: () => string): Promise<A> => {
    for (;;) {
      const value = await read()
      if (value !== undefined) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label()}: ${existsSync(logFile) ? readFileSync(logFile, "utf8").slice(-2000) : ""}`)
      await Bun.sleep(20)
    }
  }

  try {
    const serviceFile = () => {
      const dir = join(state, "opencode")
      for (const name of existsSync(dir) ? readdirSync(dir).filter((file) => /^service.*\.json$/.test(file)) : []) {
        try {
          const value = JSON.parse(readFileSync(join(dir, name), "utf8")) as { url?: unknown; password?: unknown }
          if (typeof value.url === "string" && typeof value.password === "string") return { url: value.url, password: value.password }
        } catch {}
      }
      return undefined
    }
    const service = await until(async () => serviceFile(), () => "the service file")
    const listening = since()
    const auth = { authorization: `Basic ${btoa(`opencode:${service.password}`)}` }
    let seen = "no answer"
    await until(
      async () => {
        const response = await fetch(new URL("/api/info", service.url), { headers: auth }).catch(() => undefined)
        if (response) seen = `${response.status} ${await response.text()}`
        return response?.ok ? true : undefined
      },
      () => `/api/info 200 (last: ${seen})`,
    )
    const ready = since()
    const headers = (directory: string) => ({ ...auth, "x-opencode-directory": encodeURIComponent(directory), "content-type": "application/json" })
    const skills = plugins.some((entry) => nameOf(entry) === "skills")
    const open = async (directory: string, alone: boolean): Promise<Location> => {
      const asked = since()
      await (await fetch(new URL("/api/location", service.url), { headers: headers(directory) })).body?.cancel()
      const served = since()
      if (!skills) return { directory, asked, served, live: Number.NaN, alone }
      await until(
        async () => {
          const response = await fetch(new URL("/api/rpc/dotfiles-opencode.skills/catalog", service.url), { method: "POST", headers: headers(directory), body: JSON.stringify({ input: {} }) }).catch(() => undefined)
          await response?.body?.cancel()
          return response?.ok ? true : undefined
        },
        () => `the skills RPC in ${directory}`,
      )
      return { directory, asked, served, live: since(), alone }
    }
    /** A location answers before the host's own plugins end its setups: the next opens once every `Plugin.activate` span is in. */
    const activated = (count: number) =>
      Effect.sync(() => spans.filter((span) => span.name === "Plugin.activate").length).pipe(
        Effect.filterOrFail(
          (seen) => seen >= count,
          () => new SetupsPending({ count }),
        ),
        Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 4_500 }),
      )
    const locations = await Effect.runPromise(
      Effect.gen(function* () {
        const together = yield* Effect.promise(() => Promise.all(directories.slice(0, options.locations).map((directory) => open(directory, false))))
        const alone = yield* Effect.forEach(directories.slice(options.locations), (directory, index) =>
          activated(options.locations + index).pipe(Effect.andThen(Effect.promise(() => open(directory, true)))),
        )
        return [...together, ...alone]
      }),
    )
    // The batch span processor flushes every few seconds: wait until two flushes bring nothing new.
    for (let last = -1; last !== spans.length; ) {
      last = spans.length
      await Bun.sleep(6_000)
    }
    return { listening, ready, locations, t0, spans, plugins: plugins.map(nameOf) }
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {}
    await child.exited
    receiver.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}

export interface PluginRow {
  readonly plugin: string
  /** Per location, in the order the locations resolved. */
  readonly load: ReadonlyArray<number>
  /** In the locations opened together. */
  readonly setup: ReadonlyArray<number>
  /** In the locations opened one at a time (`Options.alone`). */
  readonly alone: ReadonlyArray<number>
}

/** Per plugin of ours: its module load and its setup in each location. */
export const rows = (result: Measure): ReadonlyArray<PluginRow> => {
  const children = new Map<string, Array<Span>>()
  for (const span of result.spans) if (span.parent) children.set(span.parent, [...(children.get(span.parent) ?? []), span])
  const byStart = (a: Span, b: Span) => a.start - b.start
  // A location loads its configured plugins in config order, one `PluginModule.load` each.
  const loads = result.spans
    .filter((span) => span.name === "PluginSupervisor.resolve")
    .sort(byStart)
    .map((resolved) => (children.get(resolved.id) ?? []).filter((span) => span.name === "PluginModule.load").sort(byStart))
  /** The locations opened alone start after every other location's setups ended. */
  const aloneFrom = Math.min(...result.locations.filter((location) => location.alone).map((location) => result.t0 + location.asked))
  return result.plugins.map((plugin, index) => {
    // `dotfiles-opencode.<name>`, and the vendored auth plugin's `ex-machina.anthropic-auth`.
    const setups = result.spans
      .filter((span) => span.name === "Plugin.load" && [`dotfiles-opencode.${plugin}`, `ex-machina.${plugin}`].includes(span.attributes["plugin.id"] ?? ""))
      .sort(byStart)
    const took = (span: Span) => span.end - span.start
    return {
      plugin,
      load: loads.flatMap((location) => (location[index] ? [location[index].end - location[index].start] : [])),
      setup: setups.filter((span) => span.start < aloneFrom).map(took),
      alone: setups.filter((span) => span.start >= aloneFrom).map(took),
    }
  })
}

/** Each location's span of a name (`PluginSupervisor.resolve`, `Plugin.activate`), as ms. */
export const perLocation = (result: Measure, name: string): ReadonlyArray<number> =>
  result.spans
    .filter((span) => span.name === name)
    .sort((a, b) => a.start - b.start)
    .map((span) => span.end - span.start)

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (import.meta.main) {
  const fork = arg("fork")
  const only = arg("only")?.split(",")
  const result = await measure({
    launch: fork ? forkLaunch(resolve(fork), process.execPath) : { base: [arg("binary") ?? installedBinary()], env: {} },
    locations: Number(arg("locations") ?? 4),
    alone: Number(Option.getOrElse(Option.fromNullishOr(arg("alone")), () => "0")),
    plugins: SERVER_PLUGINS.filter((entry) => only === undefined || only.includes(nameOf(entry))),
    data: process.argv.includes("--data"),
    cpuProfile: arg("cpu-prof"),
  })
  const s = (value: number) => `${(value / 1000).toFixed(2)}s`
  const list = (values: ReadonlyArray<number>) => values.map((value) => value.toFixed(0)).join(" ")
  console.log(`service: listening ${s(result.listening)}, /api/info 200 at ${s(result.ready)} (503 before)`)
  const name = (location: Location) => location.directory.split("/").at(-1)
  for (const location of result.locations) console.log(`${name(location)}: asked ${s(location.asked)}, served ${s(location.served)}, plugins live ${s(location.live)}`)
  console.log(`per location, ms: module loads (PluginSupervisor.resolve) ${list(perLocation(result, "PluginSupervisor.resolve"))}; setups (Plugin.activate) ${list(perLocation(result, "Plugin.activate"))}`)
  console.log(`\nplugin          module load ms per location     setup ms per location (together | alone: ${result.locations.filter((location) => location.alone).map(name).join(" ")})`)
  for (const row of rows(result)) console.log(`${row.plugin.padEnd(16)}${list(row.load).padEnd(32)}${list(row.setup)} | ${list(row.alone)}`)
  const out = arg("json")
  if (out) writeFileSync(out, JSON.stringify(result))
}
