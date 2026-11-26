// @reads all
// @reads-reason computed read at mods/kernel/worker/workers.ts: yield* Stream.fromReadableStream({ evaluate: () => Bun.file(fd).stream(), onError: messageOf })
// The worker adapter against its real worker process: the Workers laws, then
// a cell's output and failures, the compute clock, tool calls, and a snapshot
// restored into a fresh worker, values and all. The worker is this repo's own program,
// run in a scratch directory; the adapter has no fake to stand for it.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Fiber, Layer, Predicate, Schema, type Scope } from "effect"
import type { Json, Listing, Omission } from "../frame.ts"
import { workersLaws } from "../laws.ts"
import * as Operations from "../operations.ts"
import { Workers, type Cell } from "../service.ts"
import { KernelSessionId } from "../session.ts"
import { CallFailed } from "../tools.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"
import * as ProcessWorkers from "./workers.ts"

/** A scratch directory of the scope's own, removed when the scope closes. */
const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "kernel-workers-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

/** The directory a scenario's workers start in: its own scratch directory. */
class Work extends Context.Service<Work, string>()("kernel/test/Work") {}

const first = KernelSessionId.make("ses_first")

const none: Cell["call"] = () => Effect.fail(new CallFailed({ message: "no tools in this test" }))
const cell = (source: string, tools: ReadonlyArray<Listing> = [], call: Cell["call"] = none): Cell => ({ source, tools, call })

/** `body` with the live workers and a scratch directory, each test its own; every worker is killed and the directory removed when it ends. */
const scenario = <A, E>(body: Effect.Effect<A, E, Workers | Work | Scope.Scope>, timeoutMs = 5_000) =>
  Effect.runPromise(Effect.scoped(body).pipe(Effect.provide(Layer.merge(ProcessWorkers.layer({ timeoutMs }), Layer.effect(Work, scratch)))))

workersLaws("the worker processes", () => ProcessWorkers.layer({ timeoutMs: 5_000 }), scratch)

/** The session's worker, started. */
const started = (session = first) =>
  Effect.gen(function* () {
    const workers = yield* Workers
    yield* workers.start(session, yield* Work)
    return workers
  })

describe("a worker", () => {
  test("returns a cell's console output, then its last value, and what it wrote to stdout apart", () =>
    scenario(
      Effect.gen(function* () {
        const workers = yield* started()
        const result = yield* workers.evaluate(first, cell('console.log("hello"); process.stdout.write("raw\\n"); 6 * 7'))
        expect(result).toMatchObject({ ok: true, display: "hello\n42", output: "raw\n" })
      }),
    ))

  test("answers a throw as a failed evaluation that keeps the bindings made before it", () =>
    scenario(
      Effect.gen(function* () {
        const workers = yield* started()
        const result = yield* workers.evaluate(first, cell('const kept = 1; throw new TypeError("boom")'))
        expect(result).toMatchObject({ ok: false, display: "TypeError: boom", bindings: ["kept"] })
        expect((yield* workers.evaluate(first, cell("kept"))).display).toBe("1")
      }),
    ))

  test("is killed past the compute limit", () =>
    scenario(
      Effect.gen(function* () {
        const workers = yield* started()
        const lost = yield* Effect.flip(workers.evaluate(first, cell("while (true) {}")))
        expect(lost._tag).toBe("WorkerLost")
        expect(lost.message).toContain("0.3 s of compute")
        expect(yield* workers.alive(first)).toBe(false)
      }),
      300,
    ))

  test("stops its compute clock while a tool call runs", () =>
    scenario(
      Effect.gen(function* () {
        const workers = yield* started()
        const slow: Cell["call"] = (_name, input) => Effect.sleep("500 millis").pipe(Effect.as<Json>(input))
        const result = yield* workers.evaluate(first, cell("await tools.slow({ n: 1 })", [{ id: "slow", description: "waits" }], slow))
        expect(result.ok).toBe(true)
        expect(result.display).toContain("n: 1")
      }),
      300,
    ))

  test("throws in the cell on a tool it does not have, naming the tools; a failed call throws its message", () =>
    scenario(
      Effect.gen(function* () {
        const workers = yield* started()
        const read = [{ id: "read", description: "reads" }]
        const unknown = yield* workers.evaluate(first, cell("await tools.nope()", read))
        expect(unknown).toMatchObject({ ok: false, display: "Error: tools.nope is not a tool here. Tools: tools.read" })
        expect((yield* workers.evaluate(first, cell("tools.list()", read))).display).toContain('id: "read"')
        expect((yield* workers.evaluate(first, cell("await tools.read({})", read))).display).toBe("Error: no tools in this test")
      }),
    ))

  test("gives a tool's docs and searches them in the cell, without a tool call", () =>
    scenario(
      Effect.gen(function* () {
        const workers = yield* started()
        const tools: ReadonlyArray<Listing> = [
          { id: "read", description: "Read a file from disk. Long details follow.", input: { type: "object", properties: { path: { type: "string" } } } },
          { id: "grep", description: "Search file contents with a pattern." },
          { id: "docs", description: "A tool that happens to be named docs." },
        ]
        const docs = yield* workers.evaluate(first, cell("JSON.stringify(tools.docs('read'))", tools))
        expect(JSON.parse(docs.display)).toEqual({
          name: "read",
          description: "Read a file from disk. Long details follow.",
          input: { type: "object", properties: { path: { type: "string" } } },
        })
        const found = yield* workers.evaluate(first, cell("JSON.stringify(tools.docs.search('file'))", tools))
        expect(JSON.parse(found.display)).toEqual([
          { name: "grep", summary: "Search file contents with a pattern." },
          { name: "read", summary: "Read a file from disk." },
        ])
        expect((yield* workers.evaluate(first, cell("tools.docs('nope')", tools))).display).toBe("Error: tools.nope is not a tool here. Tools: tools(\"docs\"), tools.grep, tools.read")
        // A tool named like the built-in is still reached by its string.
        expect((yield* workers.evaluate(first, cell("tools.docs('docs').description", tools))).display).toBe("A tool that happens to be named docs.")
      }),
    ))

  test("rejects a cell with the worker's exit when it crashes", () =>
    scenario(
      Effect.gen(function* () {
        const workers = yield* started()
        const lost = yield* Effect.flip(workers.evaluate(first, cell("process.exit(3)")))
        expect(lost.message).toContain("exited (code 3)")
        expect(yield* workers.alive(first)).toBe(false)
      }),
    ))

  test("restores a snapshot into a fresh worker, declarations first", () =>
    scenario(
      Effect.gen(function* () {
        const workers = yield* started()
        yield* workers.evaluate(first, cell('let n = 5; const m = new Map([["a", 1n]]); const f = (x: number): number => x + n'))
        const snapshot = yield* workers.snapshot(first)
        expect(snapshot.omitted).toEqual([])
        yield* workers.start(first, yield* Work)
        expect(yield* workers.restore(first, snapshot.bindings)).toEqual(["f", "n", "m"])
        expect((yield* workers.evaluate(first, cell("[n, m.get('a'), f(1)]"))).display).toBe("[ 5, 1n, 6 ]")
      }),
    ))

  test("lists its bindings through kernel.bindings(), restored ones included, and keeps kernel out of them", () =>
    scenario(
      Effect.gen(function* () {
        const workers = yield* started()
        yield* workers.evaluate(first, cell('const big = "x".repeat(1000); const f = () => big; const live = new WeakMap()'))
        const snapshot = yield* workers.snapshot(first)
        yield* workers.start(first, yield* Work)
        expect(yield* workers.restore(first, snapshot.bindings)).toEqual(["f", "big"])
        yield* workers.evaluate(first, cell("const fresh = 1"))
        const sized = "JSON.stringify(kernel.bindings().map(({ name, kind, bytes }) => [name, kind, bytes > 1000 ? 'over 1000' : bytes > 0 ? 'some' : 'none']))"
        expect(parsed((yield* workers.evaluate(first, cell(sized))).display)).toEqual([
          ["big", "value", "over 1000"],
          ["f", "declaration", "some"],
          ["fresh", "value", "some"],
        ])
        const unkept = yield* workers.evaluate(first, cell("const gone = new WeakMap(); JSON.stringify([kernel.bindings('gon'), kernel.bindings('f').map((item) => item.name)])"))
        expect(parsed(unkept.display)).toEqual([[{ name: "gone", kind: "value", bytes: 0, unkept: "live" }], ["f", "fresh"]])
        // No cell can rebind it, and it is never a binding of its own.
        expect((yield* workers.evaluate(first, cell("kernel = 1"))).display).toBe("TypeError: kernel is the kernel's own namespace; choose another name")
        expect((yield* workers.evaluate(first, cell("var kernel = 2"))).ok).toBe(false)
        expect((yield* workers.evaluate(first, cell("typeof kernel.bindings"))).display).toBe("function")
        const names = (yield* workers.snapshot(first)).bindings.map((binding) => binding.name)
        expect(names).not.toContain("kernel")
        expect(names).toContain("fresh")
      }),
    ),
    hangGuard("process-fixture"),
  )

  test("makes a shell result a live handle whose methods call the shell tool with its id, and rebuilds one by id", () =>
    scenario(
      Effect.gen(function* () {
        const workers = yield* started()
        // A shell tool that answers as the fork's does: a handle per call, `{ shells }` for a list.
        const inputs: Json[] = []
        const base = { id: "sh_1", runtimeMs: 5, truncated: false }
        const shell: Cell["call"] = (_name, input) =>
          Effect.sync((): Json => {
            inputs.push(input)
            const asked = input as Record<string, Json>
            if (asked.action === "list")
              return { shells: [{ id: "sh_1", state: "running", runtimeMs: 5, size: 8, description: "Make", command: "make", started: 1, background: true }] }
            if (asked.command !== undefined) return { ...base, state: "running", output: "one\n", next: 4, backgrounded: "start" }
            if (asked.action === "kill") return { ...base, state: "killed", signal: "SIGTERM", output: "", next: 8 }
            if (asked.action === "wait") return { ...base, state: "exited", exitCode: 0, output: "two\n", next: 8 }
            if (asked.lines !== undefined || asked.offset !== undefined) return { ...base, state: "exited", exitCode: 0, output: "one\ntwo\n", next: 8 }
            return { ...base, state: "running", output: "", next: 4 }
          })
        const tools = [{ id: "shell", description: "runs commands" }]
        const run = (source: string) => workers.evaluate(first, cell(source, tools, shell))

        const opened = yield* run('const h = await tools.shell({ command: "make", background: true }); JSON.stringify(h)')
        expect(opened).toMatchObject({ ok: true, bindings: ["h"] })
        // Data only: the methods are not enumerable.
        expect(JSON.parse(opened.display)).toEqual({ ...base, state: "running", output: "one\n", next: 4, backgrounded: "start" })

        // Each method adds what is new to the output the handle holds: a refresh that sees nothing keeps it.
        expect((yield* run("(await h.refresh()) === h && [h.state, h.output, h.next]")).display).toBe('[ "running", "one\\n", 4 ]')
        expect((yield* run("await h.wait(50); [h.state, h.exitCode, h.output, h.backgrounded]")).display).toBe('[ "exited", 0, "one\\ntwo\\n", "start" ]')
        expect((yield* run("(await h.read({ lines: 2 })).output")).display).toBe("one\ntwo\n")
        expect((yield* run("await h.read({ offset: 4 }); await h.wait(); (await h.kill()).signal")).display).toBe("SIGTERM")
        expect(inputs).toEqual([
          { command: "make", background: true },
          { action: "check", id: "sh_1" },
          { action: "wait", id: "sh_1", ms: 50 },
          { action: "check", id: "sh_1", lines: 2 },
          { action: "check", id: "sh_1", offset: 4 },
          { action: "wait", id: "sh_1", ms: 600_000 },
          { action: "kill", id: "sh_1" },
        ])

        const rebuilt = yield* run('const again = await tools.shell.handle("sh_1"); [again.id, again.state, typeof again.kill]')
        expect(rebuilt.display).toBe('[ "sh_1", "running", "function" ]')
        expect(inputs.at(-1)).toEqual({ action: "check", id: "sh_1" })
        expect((yield* run('await tools.shell.handle("nope")')).display).toBe("TypeError: tools.shell.handle takes a shell ID (sh_…)")

        // One list call; each listed shell is a live handle, its data plain, its read position untouched.
        const listed = yield* run("const shells = await tools.shell.list(); JSON.stringify(shells)")
        expect(inputs.at(-1)).toEqual({ action: "list" })
        expect(JSON.parse(listed.display)).toEqual([
          { id: "sh_1", state: "running", runtimeMs: 5, description: "Make", command: "make", started: 1, background: true, output: "", next: 8, truncated: false },
        ])
        expect((yield* run("(await shells[0].kill()) === shells[0] && [shells[0].state, shells[0].signal]")).display).toBe('[ "killed", "SIGTERM" ]')
        expect(inputs.at(-1)).toEqual({ action: "kill", id: "sh_1" })

        // In a cell, tools.shell only runs a command: a field that acts on a shell throws, naming the method.
        const sent = inputs.length
        const refused = (input: string) => run(`await tools.shell(${input})`).pipe(Effect.map((result) => result.display))
        expect(yield* refused('{ id: "sh_1", kill: true }')).toBe('TypeError: tools.shell takes a command to run, not kill; use (await tools.shell.handle("sh_1")).kill()')
        expect(yield* refused('{ id: "sh_1", wait: 500 }')).toBe('TypeError: tools.shell takes a command to run, not wait; use (await tools.shell.handle("sh_1")).wait(ms)')
        expect(yield* refused('{ id: "sh_1", lines: 5 }')).toBe('TypeError: tools.shell takes a command to run, not lines; use (await tools.shell.handle("sh_1")).read({ lines })')
        expect(yield* refused('{ id: "sh_1", offset: 4 }')).toBe('TypeError: tools.shell takes a command to run, not offset; use (await tools.shell.handle("sh_1")).read({ offset })')
        expect(yield* refused('{ id: "sh_1" }')).toBe('TypeError: tools.shell takes a command to run, not id; use (await tools.shell.handle("sh_1")).refresh()')
        expect(yield* refused("{ kill: true }")).toBe("TypeError: tools.shell takes a command to run, not kill; use (await tools.shell.handle(id)).kill()")
        expect(yield* refused("{ list: true }")).toBe("TypeError: tools.shell takes a command to run, not list; use await tools.shell.list()")
        expect(yield* refused('{ command: "make", wait: 500 }')).toBe("TypeError: tools.shell takes a command to run, not wait; use (await tools.shell.handle(id)).wait(ms)")
        // The tool's own actions on a shell are methods in a cell too.
        expect(yield* refused('{ action: "check", id: "sh_1" }')).toBe('TypeError: tools.shell takes a command to run, not action "check"; use (await tools.shell.handle("sh_1")).refresh()')
        expect(yield* refused('{ action: "wait", id: "sh_1", ms: 500 }')).toBe('TypeError: tools.shell takes a command to run, not action "wait"; use (await tools.shell.handle("sh_1")).wait(ms)')
        expect(yield* refused('{ action: "kill", id: "sh_1" }')).toBe('TypeError: tools.shell takes a command to run, not action "kill"; use (await tools.shell.handle("sh_1")).kill()')
        expect(yield* refused('{ action: "list" }')).toBe("TypeError: tools.shell takes a command to run, not action \"list\"; use await tools.shell.list()")
        expect(yield* refused('{ command: "make", ms: 500 }')).toBe("TypeError: tools.shell takes a command to run, not ms; use (await tools.shell.handle(id)).wait(ms)")
        expect(inputs.length).toBe(sent)
        // action run is a command like any other.
        yield* run('await tools.shell({ action: "run", command: "make" })')
        expect(inputs.at(-1)).toEqual({ action: "run", command: "make" })

        // A restart keeps the handle's data; its methods come back through tools.shell.handle.
        const snapshot = yield* workers.snapshot(first)
        expect(snapshot.omitted).toEqual([])
        yield* workers.start(first, yield* Work)
        yield* workers.restore(first, snapshot.bindings)
        expect((yield* run("[h.id, h.state, typeof h.kill]")).display).toBe('[ "sh_1", "killed", "undefined" ]')
        expect((yield* run("typeof (await tools.shell.handle(h.id)).wait")).display).toBe("function")
      }),
    ))
})

/**
 * An echo tool that holds every call until the test opens it, counting the
 * calls in flight host-side: it never answers on its own, so what it counts
 * is only what the worker let through. `full` completes when the `target`-th
 * call arrives. Input `{ fail: true }` fails a call.
 */
const held = (target: number) => {
  let now = 0
  let most = 0
  let arrived = 0
  const full = Deferred.makeUnsafe<boolean>()
  const open = Deferred.makeUnsafe<boolean>()
  const call: Cell["call"] = (_name, input) =>
    Effect.gen(function* () {
      arrived++
      now++
      most = Math.max(most, now)
      if (arrived === target) yield* Deferred.succeed(full, true)
      yield* Deferred.await(open)
      now--
      if (Predicate.hasProperty(input, "fail")) return yield* Effect.fail(new CallFailed({ message: "it failed" }))
      return input
    })
  return { call, full, open, most: () => most }
}

const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const echo: ReadonlyArray<Listing> = [{ id: "echo", description: "echoes" }]
/** A cell's display, with `call` answering its calls. */
const shown = (source: string, call: Cell["call"], tools = echo) =>
  Effect.gen(function* () {
    const workers = yield* Workers
    return (yield* workers.evaluate(first, cell(source, tools, call))).display
  })

/** Event-loop turns given to the host after the expected calls arrived, so any call the worker should have held back would arrive too. */
const SETTLE_TURNS = 200

/**
 * Runs `source` against a held tool: waits for `expected` calls to reach the
 * host, gives any further call the time to arrive, takes the most in flight
 * (`atOnce`), then opens the tool and lets the cell end. `wrap` sees each call
 * (the journal does).
 */
const peak = (source: string, expected: number, wrap: (call: Cell["call"]) => Cell["call"] = (call) => call, tools = echo) =>
  Effect.gen(function* () {
    const tool = held(expected)
    const fiber = yield* Effect.forkChild(shown(source, wrap(tool.call), tools))
    yield* Deferred.await(tool.full)
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: SETTLE_TURNS }))
    const atOnce = tool.most()
    yield* Deferred.succeed(tool.open, true)
    const display = yield* Fiber.join(fiber)
    return { display, atOnce, most: tool.most() }
  })

describe("calls in parallel", () => {
  test("a call past the in-flight limit waits for a free slot: Promise.all over 100 calls resolves, 32 in flight and no more", () =>
    scenario(
      Effect.gen(function* () {
        yield* started()
        const run = yield* peak("const got = await Promise.all(Array.from({ length: 100 }, (_, n) => tools.echo({ n }))); got.map((r) => r.n).join(',')", 32)
        expect(run).toEqual({ display: Array.from({ length: 100 }, (_, n) => n).join(","), atOnce: 32, most: 32 })
      }),
    ))

  test("tools.all settles an array or a record of calls, each { ok, value | error }, never throwing for one failure", () =>
    scenario(
      Effect.gen(function* () {
        yield* started()
        const array = yield* peak("JSON.stringify(await tools.all([tools.echo({ n: 1 }), tools.echo({ fail: true }), () => tools.echo({ n: 3 }), 4]))", 3)
        expect(parsed(array.display)).toEqual([
          { ok: true, value: { n: 1 } },
          { ok: false, error: "Error: it failed" },
          { ok: true, value: { n: 3 } },
          { ok: true, value: 4 },
        ])
        expect(array.atOnce).toBe(3)
        const record = yield* peak("JSON.stringify(await tools.all({ a: tools.echo({ n: 1 }), b: () => { throw new TypeError('sync') } }))", 1)
        expect(parsed(record.display)).toEqual({ a: { ok: true, value: { n: 1 } }, b: { ok: false, error: "TypeError: sync" } })
        expect(yield* shown("await tools.all(5)", none)).toBe("TypeError: tools.all takes an array or a record of calls")
      }),
    ))

  test("tools.map runs a call per item, `concurrency` at once and no more, settled in input order", () =>
    scenario(
      Effect.gen(function* () {
        yield* started()
        const two = yield* peak("JSON.stringify(await tools.map([1, 2, 3, 4, 5], (n) => tools.echo(n === 2 ? { fail: true } : { n }), { concurrency: 2 }))", 2)
        expect(parsed(two.display)).toEqual([
          { ok: true, value: { n: 1 } },
          { ok: false, error: "Error: it failed" },
          { ok: true, value: { n: 3 } },
          { ok: true, value: { n: 4 } },
          { ok: true, value: { n: 5 } },
        ])
        expect([two.atOnce, two.most]).toEqual([2, 2])
        // By default as many at once as may be in flight.
        const forty = yield* peak("(await tools.map(Array.from({ length: 40 }, (_, n) => n), (n) => tools.echo({ n }))).every((r) => r.ok)", 32)
        expect(forty).toEqual({ display: "true", atOnce: 32, most: 32 })
        expect(yield* shown("await tools.map([1], (n) => n, { concurrency: 0 })", none)).toBe("TypeError: tools.map's concurrency is a whole number of 1 or more")
      }),
    ))

  test("all and map are the namespace's own: tools.list() leaves them out, and a tool so named is reached by its string", () =>
    scenario(
      Effect.gen(function* () {
        yield* started()
        const tools: ReadonlyArray<Listing> = [...echo, { id: "map", description: "a tool named map" }]
        expect(yield* shown("tools.list().map((t) => t.id).join(',')", none, tools)).toBe("echo,map")
        expect(yield* shown("typeof tools.map", none, tools)).toBe("function")
        expect((yield* peak("(await tools('map')({ n: 9 })).n", 1, (call) => call, tools)).display).toBe("9")
        expect(yield* shown("Object.keys(tools).join(',')", none, tools)).toBe("echo")
      }),
    ))

  test("a returned object's calls are awaited one level deep, a failure shown as its error, and the bound object is left as it was", () =>
    scenario(
      Effect.gen(function* () {
        yield* started()
        // A chained call starts after the first resolves, while the cell still runs.
        const bag = yield* peak("({ a: tools.echo({ n: 1 }), b: tools.echo({ fail: true }), c: tools.echo({ n: 2 }).then((r) => tools.echo({ n: r.n + 1 })), d: 4 })", 3)
        expect(bag.display).toBe('{\n  a: {\n    n: 1,\n  },\n  b: "Error: it failed",\n  c: {\n    n: 3,\n  },\n  d: 4,\n}')
        expect(bag.atOnce).toBe(3)
        expect((yield* peak("[tools.echo({ n: 5 })]", 1)).display).toBe("[\n  {\n    n: 5,\n  }\n]")
        expect((yield* peak("const kept = { p: tools.echo({ n: 6 }) }; kept", 1)).display).toContain("n: 6")
        expect(yield* shown("kept.p instanceof Promise", none)).toBe("true")
      }),
    ))

  test("the journal measures a cell's overlap: one call after another never overlaps; Promise.all, tools.map and a returned object do", () =>
    scenario(
      Effect.gen(function* () {
        yield* started()
        const overlap = (source: string, expected: number) =>
          Effect.gen(function* () {
            const record = Operations.journal(() => Effect.void)
            const journaled = (call: Cell["call"]): Cell["call"] => (name, input) =>
              record.around(name, input, Effect.map(call(name, input), (value) => ({ content: value, value }))).pipe(Effect.map((outcome) => outcome.value))
            yield* peak(source, expected, journaled)
            return record.metadata()[Operations.CONCURRENCY_KEY]
          })
        expect(yield* overlap("for (const n of [1, 2, 3, 4, 5]) await tools.echo({ n })", 1)).toEqual({ calls: 5, maxInFlight: 1 })
        expect(yield* overlap("await Promise.all([1, 2, 3].map((n) => tools.echo({ n })))", 3)).toEqual({ calls: 3, maxInFlight: 3 })
        expect(yield* overlap("await Promise.all(Array.from({ length: 40 }, (_, n) => tools.echo({ n })))", 32)).toEqual({ calls: 40, maxInFlight: 32 })
        expect(yield* overlap("await tools.map(Array.from({ length: 40 }, (_, n) => n), (n) => tools.echo({ n }))", 32)).toEqual({ calls: 40, maxInFlight: 32 })
        expect(yield* overlap("({ a: tools.echo({ n: 1 }), b: tools.echo({ n: 2 }), c: tools.echo({ n: 3 }) })", 3)).toEqual({ calls: 3, maxInFlight: 3 })
      }),
    ))
})

/** Runs `cells` in one worker, then restores its snapshot into a fresh one. */
const restart = (...cells: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const workers = yield* started()
    for (const source of cells) expect((yield* workers.evaluate(first, cell(source))).ok).toBe(true)
    const snapshot = yield* workers.snapshot(first)
    yield* workers.start(first, yield* Work)
    const restored = yield* workers.restore(first, snapshot.bindings)
    const show = (expression: string) => workers.evaluate(first, cell(expression)).pipe(Effect.map((result) => result.display))
    return { snapshot, restored, show }
  })

describe("a restart", () => {
  test("keeps a cyclic object's cycles and shared references", () =>
    scenario(
      Effect.gen(function* () {
        const { restored, show } = yield* restart("const node = { name: 'a', children: [] }; node.children.push(node); node.twin = node.children")
        expect(restored).toEqual(["node"])
        expect(yield* show("[node.children[0] === node, node.twin === node.children, node.name]")).toBe('[ true, true, "a" ]')
      }),
    ))

  test("keeps BigInt, collections, dates, patterns, errors, bytes and bare objects", () =>
    scenario(
      Effect.gen(function* () {
        const { snapshot, show } = yield* restart(`const v = {
          big: 2n ** 70n,
          map: new Map([[1n, new Set(["a"])]]),
          when: new Date(0),
          pattern: /x+/gi,
          error: Object.assign(new TypeError("bad"), { name: "BadInput" }),
          floats: new Float64Array([1.5]),
          buffer: Buffer.from("hi"),
          bare: Object.assign(Object.create(null), { k: 1 }),
        }`)
        expect(snapshot.omitted).toEqual([])
        const read = [
          "v.big",
          "v.map.get(1n).has('a')",
          "v.when.getTime()",
          "v.pattern.flags",
          "v.error instanceof TypeError",
          "v.error.name",
          "v.error.message",
          "v.floats[0]",
          "Buffer.isBuffer(v.buffer)",
          "v.buffer.toString()",
          "String(Object.getPrototypeOf(v.bare))",
          "v.bare.k",
        ]
        expect(yield* show(`[${read.join(", ")}].join(" ")`)).toBe("1180591620717411303424 true 0 gi true BadInput bad 1.5 true hi null 1")
      }),
    ))

  test("keeps a binding up to 16 MiB; one over is named too-large and left out", () =>
    scenario(
      Effect.gen(function* () {
        const { snapshot, restored, show } = yield* restart(
          "const mid = new Uint8Array(4 * 1024 * 1024).fill(7); const big = new Uint8Array(17 * 1024 * 1024); const small = 1",
        )
        expect(snapshot.omitted).toEqual([{ name: "big", reason: "too-large" }])
        expect(restored).toEqual(["mid", "small"])
        expect(yield* show("[mid.length, mid[mid.length - 1], small]")).toBe("[ 4194304, 7, 1 ]")
      }),
    ))

  test("keeps a function declaration that calls another top-level function", () =>
    scenario(
      Effect.gen(function* () {
        const { snapshot, show } = yield* restart(
          "function double(n: number): number { return n * 2 }",
          "const offset = 1; function quad(n: number) { return double(double(n)) + offset }",
        )
        expect(snapshot.omitted).toEqual([])
        expect(yield* show("quad(3)")).toBe("13")
      }),
    ))

  test("keeps a class instance's methods, its subclass and its place in other values", () =>
    scenario(
      Effect.gen(function* () {
        const { snapshot, restored, show } = yield* restart(
          "class Point { constructor(public x: number, public y: number) {} norm() { return Math.hypot(this.x, this.y) } }",
          "const Labelled = class extends Point { label = 'p'; describe() { return `${this.label} ${this.norm()}` } }",
          "const p = new Point(3, 4); const shapes = { all: [p, new Labelled(6, 8)] }",
        )
        expect(snapshot.omitted).toEqual([])
        expect(restored).toEqual(["Point", "Labelled", "p", "shapes"])
        const read = ["p.norm()", "p instanceof Point", "shapes.all[1].describe()", "shapes.all[1] instanceof Point", "shapes.all[0].norm()"]
        expect(yield* show(`[${read.join(", ")}].join(" ")`)).toBe("5 true p 10 true 5")
      }),
    ))

  test("runs imports again: named, namespace, default and bare", () =>
    scenario(
      Effect.gen(function* () {
        const work = yield* Work
        const helper = join(work, "helper.ts")
        const effect = join(work, "effect.ts")
        yield* Effect.promise(() => Bun.write(helper, "export const shout = (text: string): string => text.toUpperCase()\nexport default (n: number) => n + 1\n"))
        yield* Effect.promise(() => Bun.write(effect, "process.env.KERNEL_TEST_EFFECT = String(process.pid)\n"))
        const { snapshot, restored, show } = yield* restart(
          `import { shout as loud } from ${JSON.stringify(helper)}; import * as path from "node:path"; import next from ${JSON.stringify(helper)}; import ${JSON.stringify(effect)}`,
        )
        expect(snapshot.omitted).toEqual([])
        expect(restored).toEqual(["loud", "path", "next"])
        expect(yield* show('[loud(path.join("a", "b")), next(1), process.env.KERNEL_TEST_EFFECT === String(process.pid)].join(" ")')).toBe("A/B 2 true")
      }),
    ))

  test("keeps a redeclared function's latest version, and a function rebound to a value keeps the value", () =>
    scenario(
      Effect.gen(function* () {
        const { restored, show } = yield* restart(
          "function pick() { return 'first' }; const shift = (n: number) => n - 1; function gone() {}",
          "function pick() { return 'latest' }; let shift = (n: number) => n + 1",
          "gone = 5",
        )
        expect(restored).toEqual(["pick", "shift", "gone"])
        expect(yield* show("[pick(), shift(1), gone].join(' ')")).toBe("latest 2 5")
      }),
    ))

  test("leaves out and names a closure made inside a function", () =>
    scenario(
      Effect.gen(function* () {
        const { snapshot, restored, show } = yield* restart(
          "function make() { let n = 0; return () => ++n }; const counter = make(); const holder = { counter }; const kept = 1",
        )
        expect(snapshot.omitted).toContainEqual({ name: "counter", reason: "function" })
        expect(snapshot.omitted).toContainEqual({ name: "holder", reason: "function" })
        expect(restored).toEqual(["make", "kept"])
        expect(yield* show("[typeof counter, make()()].join(' ')")).toBe("undefined 1")
      }),
    ))

  test("leaves out live values and instances no restore can rebuild, each named with its reason", () =>
    scenario(
      Effect.gen(function* () {
        const { snapshot } = yield* restart(`const pending = Promise.resolve(1)
          const cache = new WeakMap()
          const steps = (function* () {})()
          class Vault { #key = 1; open() { return this.#key } }
          const vault = new Vault()
          const local = new (class Local {})()
          const lazy = { get v() { return 1 } }`)
        for (const omission of [
          { name: "pending", reason: "live" },
          { name: "cache", reason: "live" },
          { name: "steps", reason: "live" },
          { name: "vault", reason: "instance of Vault" },
          { name: "local", reason: "instance of Local" },
          { name: "lazy", reason: "unsupported" },
        ] satisfies Omission[])
          expect(snapshot.omitted).toContainEqual(omission)
      }),
    ))

  test("is taken without running a getter, trap, iterator or hook a cell wrote", () =>
    scenario(
      Effect.gen(function* () {
        const workers = yield* started()
        // The values come first, so only what runs after the hooks are in counts.
        const setup = `var ran = 0
          const lazy = { get x() { ran++; return 1 } }
          const trap = new Proxy({}, { get() { ran++ }, ownKeys() { ran++; return [] }, getOwnPropertyDescriptor() { ran++ }, getPrototypeOf() { ran++; return null } })
          const early = new RangeError("early")
          class Shape { side = 1 }
          const plain = { list: [1, , 3], map: new Map([[1, { polluted: 1 }]]), set: new Set([1]), early, shape: new Shape() }
          Object.defineProperty(Error.prototype, "name", { get() { ran++; return "E" }, configurable: true })
          Error.prepareStackTrace = () => { ran++; return "hooked" }
          plain.late = new Error("late")
          Map.prototype.forEach = function () { ran++ }
          Map.prototype[Symbol.iterator] = function* () { ran++ }
          Set.prototype[Symbol.iterator] = function* () { ran++ }
          Object.defineProperty(Object.prototype, "polluted", { set() { ran++ }, configurable: true })
          ran`
        expect((yield* workers.evaluate(first, cell(setup))).display).toBe("0")
        const snapshot = yield* workers.snapshot(first)
        yield* workers.snapshot(first)
        expect((yield* workers.evaluate(first, cell("ran"))).display).toBe("0")
        expect(snapshot.omitted).toContainEqual({ name: "lazy", reason: "unsupported" })
        expect(snapshot.omitted).toContainEqual({ name: "trap", reason: "unsupported" })
        expect(snapshot.bindings.map((binding) => binding.name)).toContain("plain")
        expect(snapshot.bindings.map((binding) => binding.name)).toContain("Shape")
      }),
    ))
})
