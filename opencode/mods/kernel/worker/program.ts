/**
 * The kernel's worker: one Bun process per session that runs model-written
 * TypeScript at global scope, so top-level bindings persist between calls.
 * Ported from gent's `cell-worker-boundary.ts`, without Effect.
 *
 * - Each cell compiles with `Bun.Transpiler` in replMode and runs through
 *   indirect eval: its declarations become globals, its last expression is
 *   the result, and top-level await works.
 * - `console` writes to the cell's display while it runs; other stdout and
 *   stderr writes reach the host on the output pipe, closed by a marker.
 * - `tools.<id>(input)` asks the host to run tool `<id>` and resolves to its
 *   result. `tools.list()` lists the tools the host offered for this cell.
 * - A binding is any global a cell added or changed. The host takes a
 *   snapshot of them after each cell and restores it into a fresh worker:
 *   top-level functions, classes and imports as their source
 *   (declarations.ts), run again first, then every other value as a clone
 *   (codec.ts).
 *
 * The host launches it as `bun --config=/dev/null --no-env-file program.ts`
 * under a shell that points stderr at stdout, with frames on fd 3 and 4.
 *
 * @module
 */
import { createRequire } from "node:module"
import { types } from "node:util"
import type { Evaluation, Json, Listing, Request, Response, Snapshot, SnapshotBinding } from "../kernel/frame.ts"
import {
  MAX_CALLS_PER_CELL,
  MAX_DISPLAY_CHARS,
  MAX_DISPLAY_HEAD_CHARS,
  MAX_PENDING_CALLS,
  MAX_SNAPSHOT_BYTES,
  MAX_SOURCE_CHARS,
} from "../kernel/limits.ts"
import { makeBoundedOutput } from "../kernel/output.ts"
import { encodeFrame, makeFrameReader, outputMarker, oversized, REQUEST_FD, RESPONSE_FD } from "../kernel/wire.ts"
import { decodeBinding, encodeSnapshot } from "./codec.ts"
import { declarationsOf, decodeDeclaration, makeDeclarations, type Declared } from "./declarations.ts"

/** Uncaught errors kept for the next cell; later ones between two cells are dropped. */
const MAX_STRAY_ERRORS = 20

/** What the evaluator asks of the host. */
export interface Host {
  /** Runs tool `name`; rejects with the host's message. */
  readonly call: (name: string, input: Json) => Promise<Json>
}

// ── tool namespace ──────────────────────────────────────────────────────────

/**
 * Keys JavaScript reads on its own or a function already has: `await` reads
 * `then`, `JSON.stringify` reads `toJSON`. On a `tools` node they keep their
 * JavaScript meaning, so `await tools.read` never calls a tool.
 */
const RESERVED = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  ...Object.getOwnPropertyNames(Function.prototype),
  "prototype",
  "then",
  "toJSON",
  "inspect",
  "asymmetricMatch",
  "$$typeof",
  "nodeType",
])
/** Root keys that are functions of the namespace, not tool ids: `tools.list()`. */
const DISCOVERY = new Set(["list"])

/** The source that reaches `id`: `tools.read`, `tools["x-y"]`, or `tools("list")` for a reserved name. */
export const toolPath = (id: string): string => {
  const segments = id.split(".")
  if (DISCOVERY.has(segments[0] ?? "") || segments.some((segment) => RESERVED.has(segment)))
    return `tools(${JSON.stringify(id)})`
  return segments.reduce(
    (path, segment) => (/^[A-Za-z_$][\w$]*$/.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`),
    "tools",
  )
}

/** A call with no argument sends `{}`; any other value must be JSON. */
const jsonInput = (input: unknown): Json => {
  if (input === undefined) return {}
  const text = JSON.stringify(input)
  if (text === undefined) throw new TypeError("A tool input must be JSON")
  return JSON.parse(text) as Json
}

type ToolNode = (...args: unknown[]) => unknown

/**
 * `tools` inside the cell. Every tool id is a callable path (`tools.read`,
 * `tools.github.issue`); each node is a Proxy that reads the current listing,
 * so a new listing changes the paths without a rebuild. `tools(id)` looks a
 * tool up by string. A name not in the listing throws, naming the tools.
 */
const makeTools = (listing: () => ReadonlyArray<Listing>, call: (id: string, input: unknown) => Promise<Json>): ToolNode => {
  const ids = () => listing().map((tool) => tool.id)
  const nodes = new Map<string, ToolNode>()
  const isPrefix = (path: string) => ids().some((id) => id === path || id.startsWith(`${path}.`))
  const join = (path: string, key: string) => (path === "" ? key : `${path}.${key}`)
  const isPathKey = (path: string, key: string | symbol): key is string =>
    typeof key === "string" && !RESERVED.has(key) && !(path === "" && DISCOVERY.has(key))
  const unknown = (path: string) =>
    new Error(`${toolPath(path)} is not a tool here. Tools: ${ids().map(toolPath).sort().join(", ") || "none"}`)
  const discovery = { list: () => listing().map(({ id, description }) => ({ id, description })) }
  const node = (path: string): ToolNode => {
    const existing = nodes.get(path)
    if (existing) return existing
    const target = Object.defineProperty(() => {}, "name", { value: path || "tools" })
    const created = new Proxy(target, {
      get: (target, key, receiver) => {
        if (path === "" && typeof key === "string" && DISCOVERY.has(key)) return discovery[key as keyof typeof discovery]
        if (!isPathKey(path, key)) return Reflect.get(target, key, receiver)
        if (isPrefix(join(path, key))) return node(join(path, key))
        throw unknown(join(path, key))
      },
      has: (target, key) => (isPathKey(path, key) ? isPrefix(join(path, key)) : Reflect.has(target, key)),
      ownKeys: () => [
        ...new Set(
          ids()
            .filter((id) => path === "" || id.startsWith(`${path}.`))
            .map((id) => id.slice(path === "" ? 0 : path.length + 1).split(".")[0] ?? "")
            .filter((key) => isPathKey(path, key)),
        ),
      ],
      getOwnPropertyDescriptor: (target, key) =>
        isPathKey(path, key) && isPrefix(join(path, key))
          ? { value: node(join(path, key)), enumerable: true, configurable: true, writable: false }
          : Reflect.getOwnPropertyDescriptor(target, key),
      apply: (_target, _this, args: unknown[]) => {
        if (path === "") {
          const id = String(args[0])
          if (!ids().includes(id)) throw unknown(id)
          return (input?: unknown) => call(id, input)
        }
        if (ids().includes(path)) return call(path, args[0])
        throw isPrefix(path)
          ? new Error(`${toolPath(path)} is a namespace. Its tools: ${ids().filter((id) => id.startsWith(`${path}.`)).join(", ")}`)
          : unknown(path)
      },
    })
    nodes.set(path, created)
    return created
  }
  return node("")
}

/**
 * Installs `tools` once per realm as an accessor that is not configurable and
 * whose setter throws, so no cell can rebind, delete or shadow it.
 */
const installTools = (tools: ToolNode) => {
  if (Object.getOwnPropertyDescriptor(globalThis, "tools")?.configurable === false) return
  Object.defineProperty(globalThis, "tools", {
    get: () => tools,
    set: () => {
      throw new TypeError("tools is the host tool namespace; choose another name")
    },
    enumerable: false,
    configurable: false,
  })
}

// ── evaluator ───────────────────────────────────────────────────────────────

/** Indirect eval runs the compiled cell at global scope; replMode declares bindings as global vars. */
const evaluateInRealm: (compiled: string) => unknown = globalThis.eval

/** Taken at load: a cell may replace the globals later. */
const inspect = Bun.inspect
const isPromise = types.isPromise
const isNativeError = types.isNativeError

/** An error's name and message, with no stack: the stack lists the worker's frames, not the cell's. */
const errorHead = (error: object): string => {
  const name = String(Reflect.get(error, "name") ?? "Error")
  const message = String(Reflect.get(error, "message") ?? "")
  return message === "" ? name : `${name}: ${message}`
}

/** A thrown value as text: an error's head, the errors it aggregates, its cause one level deep. */
export const errorText = (cause: unknown): string => {
  try {
    if (typeof cause !== "object" || cause === null || !(isNativeError(cause) || cause instanceof Error))
      return typeof cause === "string" ? cause : inspect(cause)
    const lines = [errorHead(cause)]
    const inner: unknown = Reflect.get(cause, "errors")
    if (Array.isArray(inner))
      for (const item of inner.slice(0, 3))
        lines.push(`  ${typeof item === "object" && item !== null ? errorHead(item) : String(item)}`)
    const nested: unknown = Reflect.get(cause, "cause")
    if (nested !== undefined)
      lines.push(`caused by ${typeof nested === "object" && nested !== null && nested instanceof Error ? errorHead(nested) : inspect(nested)}`)
    return lines.join("\n")
  } catch {
    return "A thrown value that cannot be read"
  }
}

/** A logged or returned value as text: a string as itself, an error by `errorText`, else `Bun.inspect`. */
const display = (value: unknown): string => {
  if (typeof value === "string") return value
  if (isNativeError(value)) return errorText(value)
  try {
    return inspect(value, { depth: 4 })
  } catch (cause) {
    return `[a value that cannot be shown: ${errorText(cause)}]`
  }
}

/**
 * The realm's evaluator. Each cell runs alone (the worker loop makes sure of
 * that); `call` is how `tools` reaches the host for the running cell.
 */
export const makeEvaluator = (host: Host, workingDirectory: string) => {
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "node", replMode: true })
  const output = makeBoundedOutput({ limit: MAX_DISPLAY_CHARS, headLimit: MAX_DISPLAY_HEAD_CHARS, separator: "\n" })
  let listing: ReadonlyArray<Listing> = []
  let running = false
  let strays: string[] = []

  installTools(
    makeTools(
      () => listing,
      (id, input) => {
        if (!running) return Promise.reject(new Error("A tool call from a cell that has ended"))
        try {
          return host.call(id, jsonInput(input))
        } catch (cause) {
          return Promise.reject(cause)
        }
      },
    ),
  )
  if (typeof Reflect.get(globalThis, "require") !== "function")
    Object.defineProperty(globalThis, "require", {
      value: createRequire(`${workingDirectory}/`),
      writable: true,
      configurable: true,
    })

  // Every global as the evaluator found it. A binding is a global a cell added, or one it changed.
  const baseline = new Map(
    Object.getOwnPropertyNames(globalThis).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const),
  )
  // Taken here, before any cell: a cell may replace `Map`, `Object` or their methods.
  const { getOwnPropertyNames, getOwnPropertyDescriptor, hasOwn, is, defineProperty } = Object
  const { apply } = Reflect
  const BindingMap = Map
  const { get: mapGet, set: mapSet, has: mapHas, forEach: mapForEach } = Map.prototype
  const sameDescriptor = (left: PropertyDescriptor | undefined, right: PropertyDescriptor | undefined) =>
    left !== undefined &&
    right !== undefined &&
    is(left.value, right.value) &&
    left.get === right.get &&
    left.set === right.set &&
    left.writable === right.writable &&
    left.enumerable === right.enumerable &&
    left.configurable === right.configurable
  const changed = (key: string) => !sameDescriptor(apply(mapGet, baseline, [key]), getOwnPropertyDescriptor(globalThis, key))
  /** Each binding's value, read from its descriptor: an accessor gives its getter, so no cell code runs. */
  const namespace = () => {
    const bindings = new BindingMap<string, unknown>()
    const keys = getOwnPropertyNames(globalThis)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!
      if (!changed(key)) continue
      const descriptor = getOwnPropertyDescriptor(globalThis, key)
      if (descriptor === undefined) continue
      apply(mapSet, bindings, [key, hasOwn(descriptor, "value") ? descriptor.value : descriptor.get])
    }
    return bindings
  }
  /** The value each binding held when a result last named the namespace. */
  let reported = new Map<string, unknown>()
  const newBindings = () => {
    const current = namespace()
    const named: string[] = []
    apply(mapForEach, current, [
      (value: unknown, name: string) => {
        if (!apply(mapHas, reported, [name]) || !is(apply(mapGet, reported, [name]), value)) named.push(name)
      },
    ])
    reported = current
    return named.sort()
  }

  const write = (...values: unknown[]) => output.append(values.map(display).join(" "))
  const hostConsole = globalThis.console
  const cellConsole: Console = { ...hostConsole, log: write, info: write, warn: write, error: write, debug: write }
  const setConsole = (value: Console) =>
    Object.defineProperty(globalThis, "console", { value, writable: true, configurable: true })

  const declarations = makeDeclarations()
  const compile = (code: string) => transpiler.transformSync(code)
  /** A global's value, read from its descriptor. */
  const valueOf = (name: string): unknown => {
    const descriptor = getOwnPropertyDescriptor(globalThis, name)
    return descriptor !== undefined && hasOwn(descriptor, "value") ? descriptor.value : undefined
  }
  /** The prototype of the class a global holds, for the instances a restore rebuilds. */
  const prototypeOfClass = (name: string): object | undefined => {
    const value = valueOf(name)
    if (typeof value !== "function" || types.isProxy(value)) return undefined
    const descriptor = getOwnPropertyDescriptor(value, "prototype")
    return descriptor !== undefined && hasOwn(descriptor, "value") && typeof descriptor.value === "object" && descriptor.value !== null
      ? descriptor.value
      : undefined
  }

  /** Runs compiled cell code at global scope with the cell's console, its promise included. */
  const run = async (compiled: string): Promise<{ readonly result: unknown } | { readonly thrown: unknown }> => {
    running = true
    setConsole(cellConsole)
    try {
      let result = evaluateInRealm(compiled)
      // A thenable a cell wrote is its value; only the realm's own promise is awaited.
      if (isPromise(result)) result = await result
      return { result }
    } catch (cause) {
      return { thrown: cause }
    } finally {
      running = false
      setConsole(hostConsole)
    }
  }

  return {
    /** Runs one cell to its end, its promise included. */
    evaluate: async (source: string, tools: ReadonlyArray<Listing>): Promise<Evaluation> => {
      output.reset()
      for (const text of strays) output.append(text)
      strays = []
      listing = tools
      let declared: ReadonlyArray<Declared> = []
      /** The names the cell bound; what it declared among them is kept as source. */
      const bound = (ok: boolean) => {
        const names = newBindings()
        declarations.record(declared, names, ok, valueOf)
        return names
      }
      const failed = (cause: unknown): Evaluation => {
        output.append(errorText(cause))
        return { ok: false, display: output.read(), truncated: output.truncated(), bindings: bound(false) }
      }
      if (source.length > MAX_SOURCE_CHARS) return failed(new RangeError(`The code is over ${MAX_SOURCE_CHARS} characters`))
      let compiled: string
      try {
        compiled = transpiler.transformSync(source)
      } catch (cause) {
        return failed(cause)
      }
      // Before the cell runs: what it does to the globals cannot reach the parse.
      declared = declarationsOf(source, compile)
      const ran = await run(compiled)
      // After the console is back, so the cell's console never reads as a binding.
      if ("thrown" in ran) return failed(ran.thrown)
      // replMode wraps the last expression as `{ value }`; an undefined value shows nothing.
      const value: unknown =
        typeof ran.result === "object" && ran.result !== null ? Object.getOwnPropertyDescriptor(ran.result, "value")?.value : undefined
      if (value !== undefined) output.append(display(value))
      return { ok: true, display: output.read(), truncated: output.truncated(), bindings: bound(true) }
    },
    /** An error cell code raised outside any awaited path: the running cell's, else held for the next. */
    uncaught: (cause: unknown) => {
      if (running) output.append(`Uncaught: ${errorText(cause)}`)
      else if (strays.length < MAX_STRAY_ERRORS) strays.push(`Uncaught (after an earlier cell ended): ${errorText(cause)}`)
    },
    /** The declarations as source, then every other binding as a clone. Runs no code a cell wrote. */
    snapshot: (): Snapshot => {
      const globals = namespace()
      const sources = declarations.snapshot(globals)
      const values = new BindingMap<string, unknown>()
      apply(mapForEach, globals, [
        (value: unknown, name: string) => {
          if (!apply(mapHas, sources.carried, [name])) apply(mapSet, values, [name, value])
        },
      ])
      const encoded = encodeSnapshot(values, sources.classes, MAX_SNAPSHOT_BYTES - sources.bytes)
      // By index and definition: a cell may have replaced the array iterator or put setters on Array.prototype.
      const bindings: SnapshotBinding[] = []
      const take = (part: ReadonlyArray<SnapshotBinding>) => {
        for (let index = 0; index < part.length; index++)
          defineProperty(bindings, bindings.length, { __proto__: null, value: part[index], writable: true, enumerable: true, configurable: true } as PropertyDescriptor)
      }
      take(sources.bindings)
      take(encoded.bindings)
      return { bindings, omitted: encoded.omitted }
    },
    /**
     * Runs the stored imports again, then the declarations, each through the
     * cell's own transpile; then revives every other binding. Resolves to the
     * names it defined: a source that throws, or a value the codec cannot
     * read, is left out.
     */
    restore: async (bindings: ReadonlyArray<SnapshotBinding>): Promise<ReadonlyArray<string>> => {
      const names: string[] = []
      const sources = bindings.flatMap((binding) => {
        const source = decodeDeclaration(binding.value)
        return source === undefined ? [] : [{ ...source, name: binding.name }]
      })
      for (const source of [...sources.filter((item) => item.kind === "import"), ...sources.filter((item) => item.kind === "declaration")]) {
        let compiled: string
        try {
          compiled = transpiler.transformSync(source.code)
        } catch {
          continue
        }
        if ("thrown" in (await run(compiled))) continue
        declarations.record(declarationsOf(source.code, compile), source.name === "" ? [] : [source.name], true, valueOf)
        if (source.name !== "") names.push(source.name)
      }
      output.reset()
      for (const binding of bindings) {
        if (decodeDeclaration(binding.value) !== undefined) continue
        const decoded = decodeBinding(binding.value, prototypeOfClass)
        if (decoded === undefined) continue
        const defined = Reflect.defineProperty(globalThis, binding.name, {
          value: decoded.value,
          writable: true,
          enumerable: true,
          configurable: true,
        })
        if (defined) names.push(binding.name)
      }
      reported = namespace()
      return names
    },
  }
}

// ── worker loop ─────────────────────────────────────────────────────────────

/** The worker's side of the pipes. */
export interface Transport {
  readonly requests: AsyncIterable<Request>
  readonly send: (response: Response) => Promise<void>
  /** Closes the cell's output on stdout, before its result frame. */
  readonly endOutput: (token: string) => Promise<void>
}

/** Serves requests until the host closes the request pipe. */
export const runWorker = async (transport: Transport, workingDirectory: string, onUncaught: (report: (cause: unknown) => void) => void) => {
  const pending = new Map<string, { resolve: (value: Json) => void; reject: (error: Error) => void }>()
  let sequence = 0
  let calls = 0
  let active = false
  const inflight = new Set<Promise<Json>>()
  const evaluator = makeEvaluator(
    {
      call: (name, input) => {
        if (pending.size >= MAX_PENDING_CALLS) return Promise.reject(new Error(`More than ${MAX_PENDING_CALLS} tool calls in flight`))
        if (calls >= MAX_CALLS_PER_CELL) return Promise.reject(new Error(`More than ${MAX_CALLS_PER_CELL} tool calls in one cell`))
        calls++
        const call = String(++sequence)
        const reply = new Promise<Json>((resolve, reject) => {
          pending.set(call, { resolve, reject })
          transport.send({ type: "call", call, name, input }).catch((cause: unknown) => {
            pending.delete(call)
            reject(cause instanceof Error ? cause : new Error(String(cause)))
          })
        })
        inflight.add(reply)
        const forget = () => void inflight.delete(reply)
        reply.then(forget, forget)
        return reply
      },
    },
    workingDirectory,
  )
  onUncaught(evaluator.uncaught)
  /** Waits for every host call the cell left in flight, so the host never sees an orphaned call. */
  const settled = async () => {
    while (inflight.size > 0) await Promise.allSettled([...inflight])
  }
  const evaluate = async (request: Extract<Request, { type: "evaluate" }>) => {
    active = true
    calls = 0
    const result = await evaluator.evaluate(request.source, request.tools)
    await transport.endOutput(request.token)
    await settled()
    active = false
    await transport.send({ type: "evaluated", id: request.id, ...result })
  }
  await transport.send({ type: "ready" })
  for await (const request of transport.requests) {
    if (request.type === "reply") {
      const entry = pending.get(request.call)
      if (!entry) continue
      pending.delete(request.call)
      if (request.ok) entry.resolve(request.value)
      else entry.reject(new Error(request.message))
      continue
    }
    if (active) throw new Error(`a ${request.type} request while a cell runs`)
    if (request.type === "evaluate")
      evaluate(request).catch((cause: unknown) => {
        process.stderr.write(`kernel worker: ${errorText(cause)}\n`)
        process.exit(1)
      })
    else if (request.type === "snapshot") await transport.send({ type: "snapshot", id: request.id, ...evaluator.snapshot() })
    else await transport.send({ type: "restored", id: request.id, names: await evaluator.restore(request.bindings) })
  }
}

// ── process entry ───────────────────────────────────────────────────────────

/** Frames on fd 3 and 4; stdout carries the cell's own output and the end markers. */
const descriptorTransport = (): Transport => {
  const writer = Bun.file(RESPONSE_FD).writer()
  let queue = Promise.resolve()
  return {
    requests: (async function* () {
      const reader = makeFrameReader()
      for await (const chunk of Bun.file(REQUEST_FD).stream()) {
        const read = reader.push(chunk)
        // The host encoded each frame from `Request`, so its JSON is one.
        for (const text of read.frames) yield JSON.parse(text) as Request
        if (read.error !== undefined) {
          process.stderr.write(`kernel worker: ${read.error}\n`)
          process.exit(1)
        }
      }
    })(),
    send: (response) => {
      const encoded = encodeFrame(response)
      if (encoded._tag === "Oversized") return Promise.reject(new Error(oversized(encoded.size)))
      queue = queue.then(async () => {
        writer.write(encoded.bytes)
        await writer.flush()
      })
      return queue
    },
    // The callback fires once the marker reached the OS, so all the cell wrote before it is in the pipe.
    endOutput: (token) =>
      new Promise((resolve, reject) => process.stdout.write(outputMarker(token), (error) => (error ? reject(error) : resolve()))),
  }
}

/**
 * macOS has no parent-death signal, and a cell in a synchronous loop never
 * yields, so only a separate thread can notice the host died: it sees this
 * process reparented and kills the process group, a cell's children with it.
 */
const watchParent = () => {
  const source = `const host = ${process.ppid}
setInterval(() => {
  if (process.ppid === host) return
  try { process.kill(-process.pid, "SIGKILL") } catch { process.kill(process.pid, "SIGKILL") }
}, 250)`
  return new Worker(URL.createObjectURL(new Blob([source])), { ref: false })
}

if (import.meta.main) {
  watchParent()
  const stray: unknown[] = []
  let report: ((cause: unknown) => void) | undefined
  const uncaught = (cause: unknown) => (report ? report(cause) : stray.push(cause))
  process.on("uncaughtException", uncaught)
  process.on("unhandledRejection", uncaught)
  await runWorker(descriptorTransport(), process.cwd(), (handler) => {
    report = handler
    for (const cause of stray.splice(0)) handler(cause)
  }).then(
    () => process.exit(0),
    (cause: unknown) => {
      process.stderr.write(`kernel worker: ${errorText(cause)}\n`)
      process.exit(1)
    },
  )
}
