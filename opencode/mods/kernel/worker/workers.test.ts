// The worker adapter against its real worker process: the Workers laws, then
// a cell's output and failures, the compute clock, tool calls, and a snapshot
// restored into a fresh worker, values and all. The worker is this repo's own program,
// run in a scratch directory; the adapter has no fake to stand for it.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, type Scope } from "effect"
import type { Json, Listing, Omission } from "../frame.ts"
import { workersLaws } from "../laws.ts"
import { Workers, type Cell } from "../service.ts"
import { KernelSessionId } from "../session.ts"
import { CallFailed } from "../tools.ts"
import * as ProcessWorkers from "./workers.ts"

const work = mkdtempSync(join(tmpdir(), "kernel-workers-"))
const first = KernelSessionId.make("ses_first")

const none: Cell["call"] = () => Effect.fail(new CallFailed({ message: "no tools in this test" }))
const cell = (source: string, tools: ReadonlyArray<Listing> = [], call: Cell["call"] = none): Cell => ({ source, tools, call })

/** `body` with the live workers, each test its own; every worker is killed when it ends. */
const scenario = <A, E>(body: Effect.Effect<A, E, Workers | Scope.Scope>, timeoutMs = 5_000) =>
  Effect.runPromise(Effect.scoped(body).pipe(Effect.provide(ProcessWorkers.layer({ timeoutMs }))))

workersLaws("the worker processes", () => ProcessWorkers.layer({ timeoutMs: 5_000 }), work)

/** The session's worker, started. */
const started = (session = first) =>
  Effect.gen(function* () {
    const workers = yield* Workers
    yield* workers.start(session, work)
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
        yield* workers.start(first, work)
        expect(yield* workers.restore(first, snapshot.bindings)).toEqual(["f", "n", "m"])
        expect((yield* workers.evaluate(first, cell("[n, m.get('a'), f(1)]"))).display).toBe("[ 5, 1n, 6 ]")
      }),
    ))

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
            if (asked.list === true) return { shells: [{ ...base, state: "running" }] }
            if (asked.command !== undefined) return { ...base, state: "running", output: "one\n", next: 4, backgrounded: "start" }
            if (asked.kill === true) return { ...base, state: "killed", signal: "SIGTERM", output: "", next: 8 }
            if (asked.wait !== undefined) return { ...base, state: "exited", exitCode: 0, output: "two\n", next: 8 }
            if (asked.lines !== undefined || asked.offset !== undefined) return { ...base, state: "exited", exitCode: 0, output: "one\ntwo\n", next: 8 }
            return { ...base, state: "running", output: "", next: 4 }
          })
        const tools = [{ id: "shell", description: "runs commands" }]
        const run = (source: string) => workers.evaluate(first, cell(source, tools, shell))

        const opened = yield* run('const h = await tools.shell({ command: "make", background: true }); JSON.stringify(h)')
        expect(opened).toMatchObject({ ok: true, bindings: ["h"] })
        // Data only: the methods are not enumerable.
        expect(JSON.parse(opened.display)).toEqual({ ...base, state: "running", output: "one\n", next: 4, backgrounded: "start" })

        expect((yield* run("(await h.refresh()) === h && [h.state, h.output, h.next]")).display).toBe('[ "running", "", 4 ]')
        expect((yield* run("await h.wait(50); [h.state, h.exitCode, h.output, h.backgrounded]")).display).toBe('[ "exited", 0, "two\\n", "start" ]')
        expect((yield* run("(await h.read({ lines: 2 })).output")).display).toBe("one\ntwo\n")
        expect((yield* run("await h.read({ offset: 4 }); await h.wait(); (await h.kill()).signal")).display).toBe("SIGTERM")
        expect(inputs).toEqual([
          { command: "make", background: true },
          { id: "sh_1" },
          { id: "sh_1", wait: 50 },
          { id: "sh_1", lines: 2 },
          { id: "sh_1", offset: 4 },
          { id: "sh_1", wait: 600_000 },
          { id: "sh_1", kill: true },
        ])

        const rebuilt = yield* run('const again = await tools.shell.handle("sh_1"); [again.id, again.state, typeof again.kill]')
        expect(rebuilt.display).toBe('[ "sh_1", "running", "function" ]')
        expect(inputs.at(-1)).toEqual({ id: "sh_1" })
        expect((yield* run("(await tools.shell({ list: true })).shells.length")).display).toBe("1")
        expect((yield* run('await tools.shell.handle("nope")')).display).toBe("TypeError: tools.shell.handle takes a shell ID (sh_…)")

        // A restart keeps the handle's data; its methods come back through tools.shell.handle.
        const snapshot = yield* workers.snapshot(first)
        expect(snapshot.omitted).toEqual([])
        yield* workers.start(first, work)
        yield* workers.restore(first, snapshot.bindings)
        expect((yield* run("[h.id, h.state, typeof h.kill]")).display).toBe('[ "sh_1", "killed", "undefined" ]')
        expect((yield* run("typeof (await tools.shell.handle(h.id)).wait")).display).toBe("function")
      }),
    ))
})

/** Runs `cells` in one worker, then restores its snapshot into a fresh one. */
const restart = (...cells: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const workers = yield* started()
    for (const source of cells) expect((yield* workers.evaluate(first, cell(source))).ok).toBe(true)
    const snapshot = yield* workers.snapshot(first)
    yield* workers.start(first, work)
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
