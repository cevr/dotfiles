# Kernel

The `kernel` tool runs the agent's TypeScript in one persistent Bun process per session. Top-level bindings stay defined for the next call and survive a restart. Every other tool the session offers is a function on `tools`; calls the cell starts without awaiting run at the same time, at most 32 in flight with the rest waiting their turn, and `tools.all` and `tools.map` settle each as `{ ok, value | error }`. A returned object's calls are awaited and shown. `attach(...)` shows images to the model after the call. The transcript draws each tool call the cell made under the cell's description, and a call of two or more tool calls records how many ran at once.

## Sub-features

- `kernel-bindings`: a binding made in one call is read in the next, and after a restart.
- `kernel-tools`: `tools.<id>(input)` reaches another tool; `tools.list()` and `tools.docs(name)` describe them.
- `kernel-parallel`: calls past 32 in flight wait; `tools.all`, `tools.map` (`concurrency`) and a returned object's calls run at once.
- `kernel-handles`: `tools.shell` and `tools.subagent` resolve to live handles (`.wait`, `.kill`, `.stop`).
- `kernel-attach`: `attach(path)` shows an image to the next request.
- `kernel-transcript`: the cell's header is its description, over the rows of the tool calls it made.

## How to get to it (user POV)

- The agent calls `kernel` with `{ code, description? }` (direct, or as the runtime that reaches every other tool).
- The user reads the call in the transcript: its description as the header, its tool calls beneath.

## Driving it with the world

- **Preconditions:** none.
- **States:** default, error (a cell that throws), refused (a tool not offered). Loading and empty are `n/a`.
- **World suites:** none yet. A cell runs in a real Bun worker process, which the world's virtual time cannot host, so a drive of this feature runs its real checks with --real.
- **Code:** `mods/kernel/`, `cmd/kernel/`, `tests/kernel.test.ts`, `tests/kernel/` (its real check)
- **Regression:** `mods/kernel/worker/workers.test.ts` (a real worker: bindings, restarts, handles, calls in parallel and their overlap), `mods/kernel/operations.test.ts` (the journal and its overlap count), `mods/kernel/description.test.ts` (the words the model reads), `cmd/kernel/server.test.ts` (the plugin's seam).

1. **Bindings.** Run the cell `let n = 2` and then `n * 21` in one worker. The second call shows `42`.
2. **Parallel.** Run `await Promise.all(Array.from({ length: 100 }, (_, n) => tools.echo({ n })))` against a tool that holds its calls. The host sees 32 calls in flight and no more, and all 100 answer once the tool lets them go.
3. **Settled.** Run `await tools.map([1, 2, 3], (n) => tools.echo(n === 2 ? { fail: true } : { n }), { concurrency: 2 })`. The answers come back in order, with the second one `{ ok: false, error: "Error: it failed" }`.

## Driving it with real OpenCode

- **Real:** `tests/kernel.test.ts`, `tests/prime-kernel.test.ts`

1. **Seed.** Run `bun run verify:seed $ROOT --plugins kernel`, then `bun run verify:launch --root $ROOT --port $PORT`, and open the TUI under pilotty as the baseline says.
2. **Bindings.** Type `verify: call kernel {"code":"let n = 2","description":"Bind n"}` and press Enter. Then type `verify: call kernel {"code":"n * 21"}` and press Enter. The second turn ends `the last answered: 42`.
3. **Parallel.** Type `verify: call kernel {"code":"(await tools.all([tools.read({ path: 'notes.txt' }), tools.read({ path: 'missing.txt' })])).map((r) => r.ok)","description":"Read two files at once"}` and press Enter. The turn ends `the last answered: [ true, false ]`: one read failed and the other still answered.
4. **Proof.** After each step, run `pilotty snapshot -s verify-$PORT --format text > $EVIDENCE/kernel/<step>.txt`.

## Gotchas

- Kernel calls in one session run one at a time: a second kernel call waits for the first.
- The description the model reads is frozen per session at its first request, so a change to the words shows only in a new session.
- A cell's compute limit pauses while tool calls run; a cell in a synchronous loop past it kills the worker and loses the bindings since the last call.
