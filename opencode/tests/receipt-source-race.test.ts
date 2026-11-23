// accept: one at a time (the real swapper and scoped readers race under a 20 s bound; load can starve either).
// The receipt source's file law against a real race (mods/orchestrate/filestore/receipt-source.ts `receiptSource`): a
// swapper process flips a receipt's name, by atomic renames, between the good file and a link to a file outside the
// receipts folder, while the reader freezes that receipt again and again. Whatever the interleaving, no snapshot ever
// holds the outside file's bytes or digest: each freeze holds the good file whole, refuses the link, or reads again.
// The same law for every swap at the one point between the look and the open is the fast, deterministic case in
// cmd/orchestrate/receipt-input-snapshot.sim.test.ts (a fake file system); this is its confirmation on real files.
import * as BunServices from "@effect/platform-bun/BunServices"
import { CryptoHasher, spawnSync } from "bun"
import { Array as Arr, Effect, FileSystem, Match, Option, Order, Path, Predicate, Result } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { layer } from "../cmd/orchestrate/batch-inputs.ts"
import { freeze, type InputRequest, type InputSnapshot, ReceiptSource, SourceRead, SourceRef } from "../mods/orchestrate/batch-input.ts"
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
const readTwiceAt = (places: ReceiptPlaces, ref: SourceRef) =>
  ReceiptSource.use((source) => Effect.forEach([1, 2], () => Effect.result(source.read(ref)))).pipe(Effect.provide(layer(places)))

/** Race through bursts of renames, with a good interval so double observations can settle even on a loaded host. */
const SWAPPER = `import { copyFileSync, existsSync, renameSync, symlinkSync } from "node:fs"
const [name, good, outside, stop] = process.argv.slice(2)
for (let flips = 0; !existsSync(stop); flips++) {
  copyFileSync(good, name + ".good")
  renameSync(name + ".good", name)
  if (flips % 64 === 0) await Bun.sleep(150)
  symlinkSync(outside, name + ".link")
  renameSync(name + ".link", name)
  if (flips % 64 === 0) await Bun.sleep(25)
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
  // The host emits process exit before the next turn closes its pipe fd. Measure that it closes,
  // before starting recovery; a persistent descriptor still fails the exact-count assertion.
  const firstAfter = descriptors()
  let after = firstAfter
  const closeBy = performance.now() + 200
  while (after !== before && performance.now() < closeBy) {
    yield* Effect.sleep("5 millis")
    after = descriptors()
  }
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
  return [words, ms, before, after, !armed.first && warm._tag === "Success", running.some(Boolean), recovered._tag === "Success" && recovered.success.receipts.length === 1, marker, firstAfter]
})
const stats = await Effect.runPromise(report.pipe(Effect.provide(layer(places)), Effect.provide(gated), Effect.provide(BunServices.layer)))
console.log(stats.join("\\t"))
`

const byteHash = (text: string) => new CryptoHasher("sha256").update(text).digest("hex")

// Performed inside the production child, immediately after an actual sysread. The fixture records every
// whole version the writer creates; the parent only sees the public freeze result and its artifact digest.
const BARRIER = `
    ++$i;
    if ($i == $cut) {
      if ($change eq 'rename') { rename($next, $leaf) or die $!; }
      elsif ($change eq 'unlink') { unlink($leaf) or die $!; }
      else {
        open(my $write, '+<', $leaf) or die $!;
        if ($change eq 'truncate') { truncate($write, 1024) or die $!; }
        elsif ($change eq 'append') { seek($write, 0, 2) or die $!; syswrite($write, ' ') == 1 or die $!; }
        else {
          sysseek($write, $first, 0); syswrite($write, '1') == 1 or die $!;
          sysseek($write, $second, 0); syswrite($write, '0') == 1 or die $!;
        }
        close($write) or die $!;
      }
      open(my $ran, '>', $marker) or die $!; close($ran) or die $!;
    }
`

const barriers = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "receipt-barriers-" })
  const receipts = path.join(root, "receipts")
  yield* fs.makeDirectory(receipts)
  const leaf = path.join(receipts, `${head}.round.json`)
  const next = path.join(receipts, ".next")
  const prefix = `{"repo":"${root}","head":"${head}","tree":"${goodTree}","kind":"round","checks":[{"command":"first","code":`
  const middle = `,"seconds":1},${" ".repeat(33_000)}{"command":"second","code":`
  const suffix = `,"seconds":1}],"at":"2026-11-22T01:00:00.000Z"}`
  const text = (a: number, b: number) => `${prefix}${a}${middle}${b}${suffix}`
  const before = text(0, 1)
  const accepted = [before, text(1, 1), text(1, 0), before.slice(0, 1024), `${before} `]
  const allowed = new Set(accepted.map(byteHash))
  const first = new TextEncoder().encode(prefix).length
  const second = new TextEncoder().encode(`${prefix}0${middle}`).length
  const places = { host: "fixture", repository: { key: "dotfiles", checkouts: [root] }, receipts, installed: path.join(root, "installed.json"), handoff: path.join(root, "handoff.json"), maxBytes: 65536, readWithin: "1 second" as const }
  const ref = SourceRef.Receipt({ head, kind: "round" })
  const rounds = [1, 2, 3] as const
  const actions = ["overwrite", "truncate", "append", "rename", "unlink"] as const
  const schedules = ["first", "second", "both"] as const
  yield* Effect.forEach(rounds.flatMap((cut) => actions.flatMap((change) => schedules.map((schedule) => ({ cut, change, schedule })))), ({ cut, change, schedule }) =>
    Effect.gen(function* () {
      const marker = path.join(receipts, `.ran-${cut}-${change}-${schedule}`)
      const calls = { reads: 0, expected: 0 }
      const on = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline")
          const [flag, program, separator, bound, folder, name, cap] = command.args
          if (!Predicate.isString(program) || flag !== "-e" || separator !== "--" || !Predicate.isString(bound) || !Predicate.isString(folder) || !Predicate.isString(name) || !Predicate.isString(cap)) return yield* Effect.die("unexpected reader")
          const read = ++calls.reads
          if (schedule === "first" && read === 2 || schedule === "second" && read === 1) return yield* processes.spawn(command)
          calls.expected += 1
          // Each observation starts on the same complete inode version. The write happens only after sysread.
          yield* fs.writeFileString(next, before)
          yield* fs.rename(next, leaf)
          yield* fs.writeFileString(next, text(1, 0))
          const stamp = `${marker}-${read}`
          const anchor = "    $bytes .= $part;"
          if (!program.includes(anchor)) return yield* Effect.die("read barrier lost its seam")
          const patched = program.replace("my ($bound, $directory, $leaf, $cap) = @ARGV;", "my ($bound, $directory, $leaf, $cap, $cut, $change, $next, $marker, $first, $second) = @ARGV; my $i = 0;")
            .replace(anchor, `${anchor}\n${BARRIER}`)
          return yield* processes.spawn(ChildProcess.make(command.command, [flag, patched, separator, bound, folder, name, cap, String(cut), change, next, stamp, String(first), String(second)], command.options))
        }),
      )
      yield* fs.writeFileString(next, before)
      yield* fs.rename(next, leaf)
      const outcomes = yield* readTwiceAt(places, ref).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, on))
      const hits = yield* Effect.forEach([1, 2], (at) => fs.exists(`${marker}-${at}`))
      const want = Match.value(schedule).pipe(Match.when("both", () => [true, true]), Match.when("first", () => [true, false]), Match.when("second", () => [false, true]), Match.exhaustive)
      expect({ cut, change, schedule, hits, count: calls.expected }).toEqual({ cut, change, schedule, hits: want, count: want.filter(Boolean).length })
      for (const [index, outcome] of outcomes.entries()) {
        expect(Result.match(outcome, {
          onFailure: (error) => error._tag === "SourceUnreadable",
          onSuccess: SourceRead.$match({
            Present: ({ text }) => !want[index] && allowed.has(byteHash(text)),
            Absent: () => !want[index] && change === "unlink",
            Refused: () => true,
          }),
        })).toBe(true)
      }
    }), { discard: true },
  )
}).pipe(Effect.scoped)

const componentBarriers = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner
  const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "receipt-components-" })
  const root = yield* fs.realPath(fixture)
  const leaf = `${head}.round.json`
  const good = receiptText(root, goodTree, 0)
  const outside = receiptText(root, outsideTree, 1)
  // Directory swaps are only meaningful after authority is bound. The pre-setup threats are paths
  // that are not directory identities at all (a symlink to a sibling, or a FIFO).
  const cases = [
    { phase: "before-setup", kinds: ["link", "fifo"] },
    { phase: "missing-at-setup", kinds: ["link", "directory", "fifo"] },
    { phase: "before-open", kinds: ["link", "directory", "fifo"] },
    { phase: "after-open", kinds: ["link", "directory", "fifo"] },
    { phase: "before-recheck", kinds: ["link", "directory", "fifo"] },
    { phase: "after-recheck", kinds: ["link", "directory", "fifo"] },
  ] as const
  yield* Effect.forEach(["top", "inner", "receipts"].flatMap((_, depth) =>
    cases.flatMap(({ phase, kinds }) => kinds.map((kind) => ({ depth, phase, kind }))),
  ), ({ depth, phase, kind }) =>
    Effect.gen(function* () {
      const dir = path.join(root, `${depth}-${phase}-${kind}`)
      const names = ["top", "inner", "receipts"]
      const parts = names.slice(0, depth + 1)
      const tail = names.slice(depth + 1)
      const target = path.join(dir, ...parts)
      const receipts = path.join(dir, ...names)
      const stored = path.join(dir, "outside", ...tail)
      const replacement = path.join(dir, ".replacement")
      const saved = path.join(dir, ".saved")
      const marker = path.join(dir, ".swapped")
      const step = path.basename(target)
      yield* fs.makeDirectory(dir)
      yield* Effect.forEach(names, (_, i) => fs.makeDirectory(path.join(dir, ...names.slice(0, i + 1))), { discard: true })
      yield* Effect.forEach(["outside", ...tail], (_, i) => fs.makeDirectory(path.join(dir, ...["outside", ...tail].slice(0, i + 1))), { discard: true })
      yield* fs.writeFileString(path.join(receipts, leaf), good)
      yield* fs.writeFileString(path.join(stored, leaf), outside)
      yield* Match.value(kind).pipe(
        Match.when("link", () => fs.symlink(path.join(dir, "outside"), replacement)),
        Match.when("directory", () => fs.rename(path.join(dir, "outside"), replacement)),
        Match.when("fifo", () => Effect.sync(() => expect(spawnSync(["mkfifo", replacement]).exitCode).toBe(0))),
        Match.exhaustive,
      )
      if (phase === "before-setup" || phase === "missing-at-setup") {
        yield* fs.rename(target, saved)
        if (phase === "before-setup") yield* fs.rename(replacement, target)
      }
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (phase === "before-setup") return yield* processes.spawn(command)
          if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline")
          const [flag, source, separator, bound, folder, name, cap] = command.args
          if (!Predicate.isString(source) || flag !== "-e" || separator !== "--" || !Predicate.isString(bound) || !Predicate.isString(folder) || !Predicate.isString(name) || !Predicate.isString(cap)) return yield* Effect.die("unexpected reader")
          const phaseMatch = Match.value(phase)
          const pass = phaseMatch.pipe(Match.whenOr("before-recheck", "after-recheck", () => "!$first_walk"), Match.orElse(() => "$first_walk"))
          const move = phaseMatch.pipe(Match.when("missing-at-setup", () => ""), Match.orElse(() => "rename($target, $saved) or die $!;"))
          const hook = `if (${pass} && $part eq $hook && !-e $marker) { ${move} rename($replacement, $target) or die $!; open(my $m, '>', $marker) or die $!; close($m); }`
          const anchor = phaseMatch.pipe(
            Match.whenOr("before-open", "before-recheck", "missing-at-setup", () => "    my $id = shift @expected;"),
            Match.orElse(() => "      chdir($dir) && close($dir) or answer('U');"),
          )
          if (!source.includes(anchor)) return yield* Effect.die("directory barrier lost its seam")
          const program = source.replace("my ($bound, $directory, $leaf, $cap) = @ARGV;", "my ($bound, $directory, $leaf, $cap, $hook, $target, $saved, $replacement, $marker) = @ARGV;")
            .replace(anchor, `${anchor}\n${hook}`)
          return yield* processes.spawn(ChildProcess.make(command.command, [flag, program, separator, bound, folder, name, cap, step, target, saved, replacement, marker], command.options))
        }),
      )
      const places = { host: "fixture", repository: { key: "dotfiles", checkouts: [root] }, receipts, installed: path.join(root, "installed.json"), handoff: path.join(root, "handoff.json"), maxBytes: 65536, readWithin: "1 second" as const }
      const outcome = yield* freezeAt(places, { receipts: [{ head, kind: "round" }], lands: [], install: false }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      )
      if (phase !== "before-setup") expect(yield* fs.exists(marker)).toBe(true)
      const safe = Result.match(outcome, {
        onFailure: (error) => error._tag === "InputUnsettled",
        onSuccess: (snapshot) => snapshot.refused.length === 1 ||
          (snapshot.artifacts.length === 1 && snapshot.artifacts.every((artifact) => artifact.text === good && artifact.digest === byteHash(good))),
      })
      expect({ depth, phase, kind, safe }).toEqual({ depth, phase, kind, safe: true })
    }), { discard: true },
  )
}).pipe(Effect.scoped)

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
            const [words, ms, before, after, gated, running, recovered, started, firstAfter] = new TextDecoder().decode(ran.stdout).trim().split("\t")
            const stderr = new TextDecoder().decode(ran.stderr).slice(-500)
            expect({ mode, exit: ran.exitCode, gated, words, running, recovered, started, inBound: Number(ms) < 3 * WITHIN_MS, descriptorsLeft: Number(after) - Number(before), stderr }).toEqual({
              mode, exit: 0, gated: "true", words: expected, running: "false", recovered: "true", started: "true", inBound: true, descriptorsLeft: 0, stderr: "",
            })
            yield* Effect.logInfo("receipt-source gated case", { mode, ms, before, firstAfter, after })
          }), { discard: true },
        )
      }).pipe(Effect.scoped),
    60_000,
  )

  it.live.layer(BunServices.layer)(
    "every read-barrier schedule yields a complete published version or refuses, including a repeated tear",
    () => barriers,
    60_000,
  )
  it.live.layer(BunServices.layer)(
    "every configured directory component refuses links and rooted substitutions before and after open",
    () => componentBarriers,
    60_000,
  )
})
