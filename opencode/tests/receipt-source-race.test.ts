// accept: deep (the real swapper and scoped reader processes race under a 20 s bound)
// accept: one at a time (it races two processes by the clock: a loaded host starves the swapper and proves less).
// The receipt source's file law against a real race (mods/orchestrate/filestore/receipt-source.ts `receiptSource`): a
// swapper process flips a receipt's name, by atomic renames, between the good file and a link to a file outside the
// receipts folder, while the reader freezes that receipt again and again. Whatever the interleaving, no snapshot ever
// holds the outside file's bytes or digest: each freeze holds the good file whole, refuses the link, or reads again.
// The same law for every swap at the one point between the look and the open is the fast, deterministic case in
// cmd/orchestrate/receipt-input-snapshot.sim.test.ts (a fake file system); this is its confirmation on real files.
import * as BunServices from "@effect/platform-bun/BunServices"
import { CryptoHasher, spawnSync } from "bun"
import { Array as Arr, Effect, FileSystem, Match, Option, Order, Path, Result } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { layer } from "../cmd/orchestrate/batch-inputs.ts"
import { freeze, type InputRequest, type InputSnapshot } from "../mods/orchestrate/batch-input.ts"
import type { ReceiptPlaces } from "../mods/orchestrate/filestore/receipt-source.ts"

/** How many freezes the reader tries, and how long it may take. */
const FREEZES = 3000
const BOUND = "20 seconds"

const head = "2".repeat(40)
const goodTree = "5".repeat(40)
const outsideTree = "7".repeat(40)
// A Work receipt as its producer writes it (written out here: this file's `effect` is not the packages' copy, so their schemas are not used to encode).
const receiptText = (checkout: string, tree: string, code: number) =>
  `{"repo":"${checkout}","head":"${head}","tree":"${tree}","kind":"round","checks":[{"command":"bun test fixture.test.ts","code":${code},"seconds":1}],"at":"2026-11-22T01:00:00.000Z"}`

/** One freeze of the receipt over the host files at `places`, its outcome. */
const freezeAt = (places: ReceiptPlaces, request: InputRequest) => Effect.result(freeze(request)).pipe(Effect.provide(layer(places)))

/** The swapper: until the stop file exists, rename the good file's copy over the name, then a fresh link to the outside file. */
const SWAPPER = `import { copyFileSync, existsSync, renameSync, symlinkSync } from "node:fs"
const [name, good, outside, stop] = process.argv.slice(2)
for (let flips = 0; !existsSync(stop); flips++) {
  copyFileSync(good, name + ".good")
  renameSync(name + ".good", name)
  symlinkSync(outside, name + ".link")
  renameSync(name + ".link", name)
}
`

/** How long each file-system call of the FIFO child's reader may take, and how long the child may live. */
const WITHIN_MS = 500
const CHILD_MS = 15_000

/**
 * The FIFO child: one freeze over the real file system, gated so that the first open of the receipt for reading finds
 * a FIFO renamed over it just before (the one point between the look and the open, every time, not by luck). It
 * prints the outcome, elapsed time, owned children still running, and the descriptor delta after warmup. It then
 * restores an ordinary file and reuses the same source to detect a timeout that poisons later reads.
 */
const CHILD = (imports: { readonly effect: string; readonly process: string; readonly bun: string; readonly inputs: string; readonly input: string }) => `import * as BunServices from "${imports.bun}"
import { Effect, FileSystem, Layer, Schedule } from "${imports.effect}"
import { ChildProcess, ChildProcessSpawner } from "${imports.process}"
import { readdirSync } from "node:fs"
import { layer } from "${imports.inputs}"
import { freeze } from "${imports.input}"
const [receipts, checkout, leaf, staged, within, head, mode, good] = process.argv.slice(2)
const descriptors = () => readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length
const armed = { first: false }
const readers = []
const gated = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function* () {
  const real = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  return ChildProcessSpawner.make((command) => Effect.gen(function* () {
    if (!armed.first || command._tag !== "StandardCommand" || command.args.at(-2) !== leaf.split("/").at(-1)) {
      const child = yield* real.spawn(command)
      readers.push(child)
      return child
    }
    armed.first = false
    if (mode === "parent-link") {
      yield* fs.rename(receipts, receipts + ".held")
      yield* fs.rename(staged, receipts)
    } else {
      yield* fs.rename(leaf, leaf + ".warm")
      yield* fs.rename(staged, leaf)
    }
    if (mode !== "unlinked" && mode !== "slow" && mode !== "overflow") {
      const child = yield* real.spawn(command)
      readers.push(child)
      return child
    }
    // The fake child is real at the OS process boundary. It holds a descriptor, ignores TERM and
    // either stalls with no stdout or writes past the cap. It inherits the production kill policy.
    const fixture = "use Fcntl qw(O_RDONLY O_RDWR O_NONBLOCK); $SIG{TERM} = 'IGNORE'; alarm(3); " +
      "sysopen(my $anchor, $ARGV[0], O_RDWR | O_NONBLOCK) or die $!; " +
      "sysopen(my $fd, $ARGV[0], O_RDONLY) or die $!; " +
      "open(my $ready, '>', $ARGV[1]) or die $!; close($ready); " +
      "if ($ARGV[2] eq 'overflow') { while (1) { print 'P' x 16384 or die $!; } } " +
      "if ($ARGV[2] eq 'slow') { $| = 1; print 'P' x 1024; } " +
      "sysread($fd, my $byte, 1) // die $!;";
    const marker = staged + ".opened";
    const child = yield* real.spawn(ChildProcess.make(command.command, ["-e", fixture, "--", leaf, marker, mode], command.options))
    readers.push(child)
    if (mode === "unlinked") {
      yield* fs.exists(marker).pipe(Effect.repeat({ until: (exists) => exists, schedule: Schedule.spaced("5 millis") }))
      yield* fs.rename(leaf, staged + ".removed")
    }
    return child
  }))
})).pipe(Layer.provide(BunServices.layer))
const places = { host: "host-a", repository: { key: "dotfiles", checkouts: [checkout] }, receipts, installed: receipts + "/installed.json", handoff: receipts + "/handoff.json", maxBytes: 65536, readWithin: Number(within) }
const request = { receipts: [{ head, kind: "round" }], lands: [], install: false }
const report = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const once = Effect.result(freeze(request))
  const warm = yield* once
  const before = descriptors()
  armed.first = true
  const began = performance.now()
  const outcome = yield* once
  const ms = Math.round(performance.now() - began)
  const running = yield* Effect.forEach(readers, (child) => child.isRunning)
  const after = descriptors()
  // A new read in this SAME source must work, even after a hung open was terminated.
  if (mode === "parent-link") {
    yield* fs.rename(receipts, staged)
    yield* fs.rename(receipts + ".held", receipts)
  } else if (mode !== "unlinked") {
    yield* fs.rename(leaf, staged)
  }
  yield* fs.copyFile(good, leaf)
  const recovered = yield* once
  const words = outcome._tag === "Failure" ? "failed " + outcome.failure._tag : outcome.success.refused.map((each) => "refused " + each.reason).join(",") || "frozen"
  const marker = mode !== "unlinked" && mode !== "slow" && mode !== "overflow" || (yield* fs.exists(staged + ".opened"));
  return [words, ms, before, after, !armed.first && warm._tag === "Success", running.some(Boolean), recovered._tag === "Success" && recovered.success.receipts.length === 1, marker]
})
const stats = await Effect.runPromise(report.pipe(Effect.provide(layer(places)), Effect.provide(gated), Effect.provide(BunServices.layer)))
console.log(stats.join("\\t"))
`

const byteHash = (text: string) => new CryptoHasher("sha256").update(text).digest("hex")

/** One freeze's outcome in words; a snapshot holding the outside file in any form is a leak. */
const outcomeOf = (outcome: Result.Result<InputSnapshot, { readonly _tag: string }>, outsideDigest: string, outsideText: string): string =>
  Result.match(outcome, {
    onFailure: (error) => `failed ${error._tag}`,
    onSuccess: (snapshot) => {
      const leaked =
        snapshot.artifacts.some((each) => each.digest === outsideDigest || each.text === outsideText) || snapshot.receipts.some((each) => each.input.tree === outsideTree)
      return Option.match(Arr.head(snapshot.receipts), {
        onNone: () => [...snapshot.refused.map((each) => `refused ${each.reason}`), ...snapshot.absent.map(() => "absent")].join(","),
        onSome: (frozen) => [leaked, frozen.input.tree === goodTree].join("/"),
      })
    },
  })

describe("the receipt source under a real swap race", () => {
  it.live.layer(BunServices.layer)(
    "a receipt's name flipped between the good file and a link to an outside file while the reader freezes it: no snapshot holds the outside bytes or digest",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "receipt-race-" })
        const receipts = path.join(root, "receipts")
        const checkout = path.join(root, "checkout")
        yield* fs.makeDirectory(receipts)
        yield* fs.makeDirectory(path.join(root, "outside"))
        const name = path.join(receipts, `${head}.round.json`)
        const good = path.join(root, "good.json")
        const outside = path.join(root, "outside", "secret.json")
        const outsideText = receiptText(checkout, outsideTree, 1)
        yield* fs.writeFileString(good, receiptText(checkout, goodTree, 0))
        yield* fs.writeFileString(outside, outsideText)
        yield* fs.copyFile(good, name)
        yield* fs.writeFileString(path.join(root, "swapper.ts"), SWAPPER)
        const stop = path.join(root, "stop")
        yield* spawner.spawn(ChildProcess.make("bun", [path.join(root, "swapper.ts"), name, good, outside, stop], { detached: true, stdin: "ignore", forceKillAfter: "3 seconds" }))
        const places = { host: "host-a", repository: { key: "dotfiles", checkouts: [checkout] }, receipts, installed: path.join(root, "installed.json"), handoff: path.join(root, "handoff.json"), maxBytes: 65536, readWithin: "1 second" as const }
        const outsideDigest = byteHash(outsideText)
        const tally = new Map<string, number>()
        const once = freezeAt(places, { receipts: [{ head, kind: "round" }], lands: [], install: false }).pipe(
          Effect.map((outcome) => outcomeOf(outcome, outsideDigest, outsideText)),
          Effect.tap((words) => Effect.sync(() => tally.set(words, Option.getOrElse(Option.fromNullishOr(tally.get(words)), () => 0) + 1))),
        )
        yield* Effect.forEach(Arr.range(1, FREEZES), () => once, { discard: true }).pipe(Effect.timeoutOption(BOUND))
        yield* fs.writeFileString(stop, "")
        const seen = Object.fromEntries(tally)
        const kinds = Arr.sort(Object.keys(seen), Order.String)
        // Never a leak, never a refusal but the link's (a file renamed away while open is read again, not called a hard link); and both sides of the race were seen (the good file frozen, the link refused or read again), or the race proved nothing.
        expect({ leaks: kinds.filter((kind) => kind.startsWith("true/")), wrongRefusals: kinds.filter((kind) => kind.startsWith("refused ") && kind !== "refused a link"), frozenGood: kinds.includes("false/true"), sawTheLink: kinds.some((kind) => kind === "refused a link" || kind.startsWith("failed ")) }).toEqual({
          leaks: [],
          wrongRefusals: [],
          frozenGood: true,
          sawTheLink: true,
        })
        yield* Effect.logInfo("receipt-source race", seen)
      }).pipe(Effect.scoped),
    60_000,
  )

  it.live.layer(BunServices.layer)(
    "gated nonregular swaps, a renamed-away blocked open, a slow reader and an overflowing pipe leave no process or descriptor and never poison the next read",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "receipt-fifo-" })
        const receipts = yield* fs.realPath(yield* Effect.as(fs.makeDirectory(path.join(root, "receipts")), path.join(root, "receipts")))
        const checkout = path.join(root, "checkout")
        const leaf = path.join(receipts, `${head}.round.json`)
        const good = path.join(root, "good.json")
        const outside = path.join(root, "outside")
        const outsideLeaf = path.join(outside, path.basename(leaf))
        yield* fs.makeDirectory(outside)
        yield* fs.writeFileString(outsideLeaf, receiptText(checkout, outsideTree, 1))
        yield* fs.writeFileString(good, receiptText(checkout, goodTree, 0))
        const child = path.join(root, "child.ts")
        yield* fs.writeFileString(
          child,
          CHILD({
            effect: import.meta.resolve("effect"),
            process: import.meta.resolve("effect/process"),
            bun: import.meta.resolve("@effect/platform-bun/BunServices"),
            inputs: yield* path.fromFileUrl(new URL("../cmd/orchestrate/batch-inputs.ts", import.meta.url)),
            input: yield* path.fromFileUrl(new URL("../mods/orchestrate/batch-input.ts", import.meta.url)),
          }),
        )
        const matrix = [
          ["fifo", "refused not a regular file"],
          ["readonly", "refused not a regular file"],
          ["directory", "refused not a regular file"],
          ["symlink", "refused a link"],
          ["dangling", "refused a link"],
          ["hardlink", "refused a hard link"],
          ["parent-link", "failed InputUnsettled"],
          ["unlinked", "failed InputUnsettled"],
          ["slow", "failed InputUnsettled"],
          ["overflow", "failed InputUnsettled"],
        ] as const
        yield* Effect.forEach(matrix, ([mode, expected]) =>
          Effect.gen(function* () {
            const staged = path.join(root, mode)
            yield* fs.copyFile(good, leaf)
            yield* Match.value(mode).pipe(
              Match.when("directory", () => fs.makeDirectory(staged).pipe(Effect.asVoid)),
              Match.when("symlink", () => fs.symlink(outsideLeaf, staged)),
              Match.when("dangling", () => fs.symlink(path.join(root, "missing"), staged)),
              Match.when("parent-link", () => fs.symlink(outside, staged)),
              Match.when("hardlink", () => fs.link(outsideLeaf, staged)),
              Match.orElse(() => Effect.sync(() => {
                const permissions = Match.value(mode).pipe(Match.when("readonly", () => "400"), Match.orElse(() => "600"))
                const made = spawnSync(["mkfifo", "-m", permissions, staged])
                expect(made.exitCode).toBe(0)
              })),
            )
            const ran = spawnSync(["bun", child, receipts, checkout, leaf, staged, `${WITHIN_MS}`, head, mode, good], { timeout: CHILD_MS, stdin: "ignore" })
            const [words, ms, before, after, gated, running, recovered, started] = new TextDecoder().decode(ran.stdout).trim().split("\t")
            const stderr = new TextDecoder().decode(ran.stderr).slice(-500)
            expect({ mode, exit: ran.exitCode, gated, words, running, recovered, started, inBound: Number(ms) < 3 * WITHIN_MS, descriptorsLeft: Number(after) - Number(before), stderr }).toEqual({
              mode, exit: 0, gated: "true", words: expected, running: "false", recovered: "true", started: "true", inBound: true, descriptorsLeft: 0, stderr: "",
            })
            yield* Effect.logInfo("receipt-source gated case", { mode, ms, before, after })
          }), { discard: true },
        )
      }).pipe(Effect.scoped),
    60_000,
  )
})
