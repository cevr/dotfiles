// A model, on a manual clock, of how workrift admits creates (readers: a copy of the base) and moves of the base
// (writers: an advance's fast-forward and install, a refresh, a repair) to the base, and of what each writes inside
// the tree a copy reads. Two protocols:
//
// - "flock" (f5d1e180, on main): a turnstile and the base's lock taken with `flock -n`, then `flock -w 60` in a loop.
//   Linux flock keeps no arrival order: on a release every blocked waiter is woken and whichever runs first wins, and
//   a waiter whose 60 s ran out queues again at the back. Holder records live in the base's .git (created when a lock
//   is taken, removed when it is given back), creates fetch into the base outside any lock, and an advance warms the
//   base with only its own lock held.
// - "tickets" (this unit): a ticket per request, numbered in arrival order; a writer enters once every earlier ticket
//   has ended, a reader once every earlier writer has; a killed process's ticket ends when it dies (the kernel drops
//   its flock). Bookkeeping lives outside the base; every write of the base (fetch, fast-forward, install, hooks,
//   warm) is a writer's.
//
// Policies for the base's warm under tickets: "B" (an advance only moves the base; refresh warms) and "A" (an advance
// warms too, under the exclusive lock). The schedule of 2026-11-22 00:00Z on the workbox (11 creates waiting, master
// moving every ten minutes, 96-239 s clones, a 628 s warm) shows the wait each gives.
import { afterAll, describe, expect, test } from "bun:test"
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

type Kind = "r" | "w"
type Protocol = "flock" | "tickets"
type Policy = "A" | "B"

interface Spec {
  readonly kind: Kind
  readonly arrive: number
  /** How long it holds once in. */
  readonly hold: number
  /** It dies (kill -9) at this time, waiting or holding. */
  readonly killAt?: number
  /**
   * A background writer (the advance) that defers to copies: it takes its place in line only once the line is empty,
   * or after this many seconds, whichever comes first.
   */
  readonly politeFor?: number
  readonly label: string
}

interface Ticket {
  readonly id: number
  readonly spec: Spec
  /** Its place in line: the time it took its ticket (a tie broken by its index), Infinity before. */
  number: number
  lineAt?: number
  state: "waiting" | "holding" | "done" | "dead"
  enteredAt?: number
  endedAt?: number
}

interface Run {
  readonly tickets: ReadonlyArray<Ticket>
  /** Times something other than a writer holding the base exclusively wrote inside the base, while a copy ran. */
  readonly hazards: ReadonlyArray<{ readonly at: number; readonly what: string }>
  readonly violations: ReadonlyArray<string>
}

/** A deterministic random stream. */
const random = (seed: number) => {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

/**
 * Runs `specs` under `protocol` on a manual clock (seconds). `flockPoll`: under flock, the order in which woken
 * waiters run is the random stream's; a waiter whose `flock -w 60` ran out re-queues.
 */
const simulate = (protocol: Protocol, specs: ReadonlyArray<Spec>, seed = 1): Run => {
  const next = random(seed)
  const order = specs.map((spec, id) => ({ spec, id })).sort((a, b) => a.spec.arrive - b.spec.arrive || a.id - b.id)
  const tickets: Array<Ticket> = order.map(({ spec }, id) =>
    spec.politeFor === undefined
      ? { id, spec, number: spec.arrive + id * 1e-6, lineAt: spec.arrive, state: "waiting" }
      : { id, spec, number: Infinity, state: "waiting" },
  )
  const hazards: Array<{ at: number; what: string }> = []
  const violations: Array<string> = []
  const arrived = (t: Ticket, now: number) => t.lineAt !== undefined && t.lineAt <= now
  const live = (t: Ticket, now: number) => arrived(t, now) && (t.state === "waiting" || t.state === "holding")
  const copying = (now: number, except?: Ticket) =>
    tickets.some((t) => t !== except && t.spec.kind === "r" && t.state === "holding" && (t.enteredAt ?? 0) < now)
  let now = 0
  let moving = false
  for (let step = 0; step < 100_000; step++) {
    // A polite writer takes its ticket once the line is empty or its patience is over.
    for (const t of tickets.filter((each) => each.lineAt === undefined && each.spec.arrive <= now && each.state === "waiting")) {
      if ((t.spec.killAt ?? Infinity) <= now) {
        t.state = "dead"
        t.endedAt = now
        continue
      }
      const empty = !tickets.some((o) => live(o, now))
      if (empty || now >= t.spec.arrive + (t.spec.politeFor ?? 0)) {
        t.lineAt = now
        t.number = now + t.id * 1e-6
      }
    }
    // Admit.
    const waiting = tickets.filter((t) => arrived(t, now) && t.state === "waiting")
    const holding = tickets.filter((t) => t.state === "holding")
    let requeued = false
    if (protocol === "tickets") {
      for (const t of [...waiting].sort((a, b) => a.number - b.number)) {
        const earlier = tickets.filter((o) => o.number < t.number && live(o, now))
        const blocked = t.spec.kind === "w" ? earlier.length > 0 : earlier.some((o) => o.spec.kind === "w")
        if (blocked) continue
        if (t.spec.kind === "r" && moving) {
          // The moving marker a killed move left: the create gives its place back, a repair (a writer) goes in line,
          // and the create comes again behind it.
          t.state = "done"
          t.endedAt = now
          for (const spec of [
            { kind: "w", arrive: now, hold: 5, label: `repair for ${t.spec.label}` },
            { kind: "r", arrive: now, hold: t.spec.hold, label: `${t.spec.label} again` },
          ] satisfies ReadonlyArray<Spec>) {
            const id = tickets.length
            tickets.push({ id, spec, number: now + id * 1e-6, lineAt: now, state: "waiting" })
          }
          requeued = true
          continue
        }
        t.state = "holding"
        t.enteredAt = now
      }
    } else {
      // Whoever the scheduler runs first among the woken waiters takes the lock, if it can.
      const shuffled = waiting.map((t) => ({ t, key: next() })).sort((a, b) => a.key - b.key).map((each) => each.t)
      for (const t of shuffled) {
        const writerIn = holding.some((o) => o.spec.kind === "w") || tickets.some((o) => o.state === "holding" && o.spec.kind === "w")
        const anyIn = tickets.some((o) => o.state === "holding")
        if (t.spec.kind === "w" ? anyIn : writerIn) continue
        t.state = "holding"
        t.enteredAt = now
        // The holder record, created in the base's .git while copies may read it.
        if (copying(now, t)) hazards.push({ at: now, what: `${t.spec.label}'s holder record created` })
      }
    }
    // A writer in the flock protocol that is an advance's warm writes the base all along with copies beside it
    // (modelled as one write at its end); under tickets a writer is alone.
    const events = [
      ...tickets.filter((t) => t.state === "holding").map((t) => Math.min(t.enteredAt! + t.spec.hold, t.spec.killAt ?? Infinity)),
      ...tickets.filter((t) => t.state === "waiting" && t.spec.arrive > now).map((t) => t.spec.arrive),
      ...tickets.filter((t) => t.state === "waiting" && t.lineAt === undefined && t.spec.politeFor !== undefined).map((t) => t.spec.arrive + t.spec.politeFor!),
      ...tickets.filter((t) => t.state === "waiting" && t.lineAt === undefined && t.spec.killAt !== undefined).map((t) => t.spec.killAt!),
      ...tickets.filter((t) => t.state === "waiting" && arrived(t, now) && t.spec.killAt !== undefined).map((t) => t.spec.killAt!),
    ].filter((time) => time > now)
    const due = tickets.filter((t) => t.state === "holding" && Math.min(t.enteredAt! + t.spec.hold, t.spec.killAt ?? Infinity) <= now)
    const dying = tickets.filter((t) => t.state === "waiting" && arrived(t, now) && (t.spec.killAt ?? Infinity) <= now)
    if (due.length === 0 && dying.length === 0) {
      if (requeued) continue
      if (events.length === 0) break
      now = Math.min(...events)
      continue
    }
    for (const t of due) {
      const killed = (t.spec.killAt ?? Infinity) <= t.enteredAt! + t.spec.hold
      t.state = killed ? "dead" : "done"
      t.endedAt = now
      // A writer killed while it held leaves the base moving; one that ends (a repair, a move) leaves it whole.
      if (t.spec.kind === "w") moving = killed
      if (protocol === "flock" && copying(now, t)) hazards.push({ at: now, what: `${t.spec.label}'s holder record removed` })
      if (protocol === "flock" && t.spec.kind === "w" && t.spec.label.includes("warm") && copying(now, t))
        hazards.push({ at: now, what: `${t.spec.label} wrote the base beside a copy` })
    }
    for (const t of dying) {
      t.state = "dead"
      t.endedAt = now
    }
  }
  // Mutual exclusion: a writer never holds beside anyone.
  for (const w of tickets.filter((t) => t.spec.kind === "w" && t.enteredAt !== undefined))
    for (const o of tickets.filter((t) => t !== w && t.enteredAt !== undefined))
      if ((o.enteredAt ?? 0) < (w.endedAt ?? Infinity) && (w.enteredAt ?? 0) < (o.endedAt ?? Infinity))
        violations.push(`${w.spec.label} and ${o.spec.label} held together`)
  for (const t of tickets) if (t.spec.arrive < Infinity && t.state === "waiting") violations.push(`${t.spec.label} never entered`)
  return { tickets, hazards, violations }
}

/** Pairs served out of arrival order: j arrived after i, conflicts with it, and entered while i still waited. */
const outOfOrder = (run: Run) => {
  const found: Array<string> = []
  for (const i of run.tickets)
    for (const j of run.tickets) {
      if (j.number <= i.number || j.enteredAt === undefined) continue
      if (i.spec.kind === "r" && j.spec.kind === "r") continue
      const iLive = i.enteredAt === undefined ? (i.endedAt ?? Infinity) : i.enteredAt
      if (j.enteredAt < iLive && (i.spec.killAt ?? Infinity) > j.enteredAt) found.push(`${j.spec.label} before ${i.spec.label}`)
    }
  return found
}

/** Each ticket's wait is at most the holds of the earlier tickets it conflicts with. */
const unbounded = (run: Run) =>
  run.tickets.flatMap((t) => {
    if (t.enteredAt === undefined) return []
    // A reader behind a writer also waits, through it, for the readers before that writer.
    const before = run.tickets.filter((o) => o.number < t.number)
    const bound = before.reduce((sum, o) => sum + o.spec.hold, 0)
    const waited = t.enteredAt - (t.lineAt ?? t.spec.arrive)
    return waited <= bound + 1e-9 ? [] : [`${t.spec.label} waited ${waited} s in line > ${bound} s`]
  })

const maxWait = (run: Run, kind: Kind) =>
  Math.max(0, ...run.tickets.filter((t) => t.spec.kind === kind && t.enteredAt !== undefined).map((t) => t.enteredAt! - t.spec.arrive))

/**
 * 2026-11-22 from 00:00Z: creates arriving through an hour (11 of them waiting at once by 00:47), each cloning for
 * 96-239 s; master moving every ten minutes, so each window's first create starts an advance: a 20 s move (fetch,
 * fast-forward, install, hooks) and, under policy A, a 628 s warm under the exclusive lock.
 */
const tonight = (policy: Policy, seed: number): ReadonlyArray<Spec> => {
  const next = random(seed)
  const creates = Array.from({ length: 22 }, (_, i): Spec => ({
    kind: "r",
    arrive: Math.floor(next() * 3600),
    hold: 96 + Math.floor(next() * 144),
    label: `create ${i}`,
  }))
  const advances = Array.from({ length: 6 }, (_, i): Spec => ({
    kind: "w",
    arrive: i * 600 + 30,
    hold: 20 + (policy === "A" ? 628 : 0),
    // It defers to copies for at most a window, then takes its place in line.
    politeFor: 600,
    label: policy === "A" ? `advance ${i} (move and warm)` : `advance ${i} (move)`,
  }))
  return [...creates, ...advances]
}

/** Arbitrary schedules: readers and writers at random times, some killed waiting or holding. */
const generated = (seed: number): ReadonlyArray<Spec> => {
  const next = random(seed)
  const n = 3 + Math.floor(next() * 30)
  return Array.from({ length: n }, (_, i): Spec => {
    const kind: Kind = next() < 0.25 ? "w" : "r"
    const arrive = Math.floor(next() * 600)
    const hold = 1 + Math.floor(next() * (kind === "w" ? 30 : 240))
    const killAt = next() < 0.15 ? arrive + Math.floor(next() * (hold + 60)) : undefined
    const politeFor = kind === "w" && next() < 0.5 ? Math.floor(next() * 300) : undefined
    return { kind, arrive, hold, ...(killAt === undefined ? {} : { killAt }), ...(politeFor === undefined ? {} : { politeFor }), label: `${kind}${i}` }
  })
}

describe("the base's lock as a ticket queue (a model on a manual clock)", () => {
  test("red first: on main's flock protocol, later creates pass earlier ones, and a sibling's bookkeeping lands inside a copy", () => {
    let passes = 0
    let hazards = 0
    for (let seed = 1; seed <= 40; seed++) {
      const run = simulate("flock", tonight("B", seed), seed)
      passes += outOfOrder(run).length
      hazards += run.hazards.length
    }
    expect(passes).toBeGreaterThan(0)
    expect(hazards).toBeGreaterThan(0)
  })

  test("tonight under tickets: served in arrival order, every wait bounded, no write inside a copy; B waits seconds where A waits a warm", () => {
    const worst = { A: 0, B: 0 }
    for (let seed = 1; seed <= 40; seed++)
      for (const policy of ["A", "B"] as const) {
        const run = simulate("tickets", tonight(policy, seed), seed)
        expect({ seed, policy, out: outOfOrder(run), bound: unbounded(run), bad: run.violations, hazards: run.hazards }).toEqual({
          seed,
          policy,
          out: [],
          bound: [],
          bad: [],
          hazards: [],
        })
        worst[policy] = Math.max(worst[policy], maxWait(run, "r"))
        if (process.env.QUEUE_DEBUG && maxWait(run, "r") > 20) console.log(policy, seed, run.tickets.filter((t) => t.enteredAt !== undefined && t.enteredAt - t.spec.arrive > 20).map((t) => `${t.spec.label} arrive ${t.spec.arrive} line ${t.lineAt} in ${t.enteredAt} end ${t.endedAt}`), run.tickets.filter((t) => t.spec.kind === "w").map((t) => `${t.spec.label} ${t.spec.arrive} line ${t.lineAt} in ${t.enteredAt}`))
      }
    // B: a create waits at most for one move (20 s), or, when an advance whose patience ran out queued behind copies
    // still running, for the rest of those copies (at most one clone, 239 s) and the move; A: for a move and its warm.
    expect(worst.B).toBeLessThanOrEqual(239 + 20)
    expect(worst.A).toBeGreaterThan(600)
    console.log(`tonight, longest wait of a create: policy A ${worst.A} s, policy B ${worst.B} s`)
  })

  test("property: generated schedules with kills keep arrival order, bounded waits and exclusion, and a dead ticket never blocks", () => {
    let killed = 0
    for (let seed = 1; seed <= 500; seed++) {
      const specs = generated(seed)
      const run = simulate("tickets", specs, seed)
      const context = `seed ${seed}`
      expect(outOfOrder(run), context).toEqual([])
      expect(unbounded(run), context).toEqual([])
      expect(run.violations, context).toEqual([])
      expect(run.hazards, context).toEqual([])
      // A dead ticket holds nothing after it died: every ticket that waited on it entered no later than its death
      // plus the holds of the others before it (the bound above), and none is left waiting.
      for (const t of run.tickets.filter((each) => each.state === "dead")) {
        killed++
        expect(t.endedAt, context).toBeLessThanOrEqual(t.spec.killAt!)
      }
      expect(run.tickets.filter((t) => t.state === "waiting" || t.state === "holding"), context).toEqual([])
    }
    expect(killed).toBeGreaterThan(50)
  })

  test("a move killed while it holds: no copy enters the half-moved base; a repair goes first and every create still ends", () => {
    const specs: ReadonlyArray<Spec> = [
      { kind: "w", arrive: 0, hold: 20, killAt: 10, label: "advance (killed)" },
      ...Array.from({ length: 5 }, (_, i): Spec => ({ kind: "r", arrive: 2 + i, hold: 100, label: `c${i}` })),
    ]
    const run = simulate("tickets", specs)
    expect(run.violations).toEqual([])
    const repairs = run.tickets.filter((t) => t.spec.label.startsWith("repair"))
    expect(repairs.length).toBeGreaterThanOrEqual(1)
    const firstRepairEnd = Math.min(...repairs.map((t) => t.endedAt ?? Infinity))
    // Every copy that went in did so after a repair ended.
    for (const t of run.tickets.filter((each) => each.spec.kind === "r" && each.enteredAt !== undefined))
      expect({ label: t.spec.label, after: t.enteredAt! >= firstRepairEnd }).toEqual({ label: t.spec.label, after: true })
    // Each create came again and copied.
    for (let i = 0; i < 5; i++) expect(run.tickets.some((t) => t.spec.label === `c${i} again` && t.state === "done")).toBe(true)
  })

  test("readers batch behind a writer, and a writer is never starved by a stream of readers", () => {
    // A writer arrives while readers keep coming, each overlapping the next: under tickets it enters once the readers
    // before it end, and the readers after it wait for it.
    const stream = Array.from({ length: 40 }, (_, i): Spec => ({ kind: "r", arrive: i * 10, hold: 60, label: `r${i}` }))
    const writer: Spec = { kind: "w", arrive: 105, hold: 20, label: "advance" }
    const run = simulate("tickets", [...stream, writer])
    const w = run.tickets.find((t) => t.spec.label === "advance")!
    expect(w.enteredAt).toBe(100 + 60)
    const after = run.tickets.filter((t) => t.spec.kind === "r" && t.spec.arrive > 105)
    expect(after.every((t) => (t.enteredAt ?? 0) >= 180)).toBe(true)
    // The readers that queued behind it go in together.
    expect(new Set(after.filter((t) => t.spec.arrive < 180).map((t) => t.enteredAt))).toEqual(new Set([180]))
  })
})

// ---------------------------------------------------------------------------
// The clone turn (clone-one-at-a-time, 2026-11-22). On the workbox's btrfs (16 cores, load 40-70, ~400k files a
// Bite tree) one `cp -a --reflink=always` of the base takes 0-1 s alone, four started together took 1,262-1,287 s
// each, and a clone beside a removal's `rm -rf` stalls 12-17 min while the removal takes 16-21 min. So on a base whose
// workspaces are file copies, a create's clone phase and a remove's delete phase take one turn each, one at a time per
// base, in arrival order across both kinds; a base whose workspaces are btrfs snapshots keeps them side by side.
//
// The real script runs here in a scratch HOME over a stand-in `work` whose `new` (the clone) and `rm` (the delete)
// log when they begin and end and sleep for a set time between; a stand-in `stat` names which bases are btrfs
// subvolumes; the util-linux `flock` is a Perl stand-in (macOS has none). Generated schedules of creates and removes
// on two bases, some killed (their whole process group, kill -9) while they wait or hold, are judged against a
// reference model: one first-come-first-served server per copy base, whose arrivals are the turn tickets as they
// appear in the base's state folder.

const turnRepo = join(import.meta.dir, "..", "..")
// WORKRIFT_SCRIPT runs this against another script (main's, for the red run; a mutant).
const TURN_SCRIPT = process.env.WORKRIFT_SCRIPT ?? join(turnRepo, "workbox/bin/workrift")
const turnScratch = realpathSync(mkdtempSync(join(tmpdir(), "workrift-turn-")))
afterAll(() => rmSync(turnScratch, { recursive: true, force: true }))
let turnBenches = 0

type Env = Record<string, string>

const exe = (path: string, body: string) => {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}
const textLines = (text: string) => text.split("\n").filter((line) => line !== "")
/** `read()`, or `otherwise` when the file went away meanwhile. */
const readOr = <A>(read: () => A, otherwise: A): A => {
  try {
    return read()
  } catch {
    return otherwise
  }
}
const sh = (cwd: string, env: Env, ...argv: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync([...argv], { cwd, env, stdout: "pipe", stderr: "pipe" })
  if (ran.exitCode !== 0) throw new Error(`${argv.join(" ")} failed (${ran.exitCode}): ${ran.stderr.toString()}`)
  return ran.stdout.toString()
}

/** util-linux flock's forms workrift uses, over Perl's flock(2) (as workrift.test.ts's realFlock). */
const FLOCK = [
  "#!/usr/bin/perl",
  "use strict; use Fcntl qw(:flock); use Time::HiRes qw(sleep time);",
  "my ($nb, $sh, $w) = (0, 0, undef);",
  "while (@ARGV && $ARGV[0] =~ /^-/) { my $o = shift; if ($o eq '-n') { $nb = 1 } elsif ($o eq '-s') { $sh = 1 } elsif ($o eq '-w') { $w = shift } elsif ($o eq '-x') {} }",
  "my $t = shift; my $fh;",
  "if ($t =~ /^\\d+$/ && !@ARGV) { open($fh, '>>&=', $t) or open($fh, '<&=', $t) or exit 64 } else { open($fh, '>>', $t) or exit 64 }",
  "my $deadline = defined $w ? time + $w : undef;",
  "until (flock($fh, ($sh ? LOCK_SH : LOCK_EX) | LOCK_NB)) { exit 1 if $nb || (defined $deadline && time >= $deadline); sleep 0.05 }",
  "if (@ARGV) { exit(system(@ARGV) >> 8) }",
  "exit 0;",
  "",
].join("\n")

/**
 * A stand-in `work`: bases from FAKE_WORK_BASES, one record a file under <base's folder>/.work/<base>/.fake-registry.
 * `new` is the clone and `rm` the delete: each logs `in` and `out` lines (`in clone NAME BASE TIME PID`) to FAKE_LOG
 * around a controlled hold. FAKE_HOLDS/NAME is either a delay for a generated schedule or a gate the test releases.
 * `rm` answers as a base with `trash = false` does (deleted in the rm).
 */
const FAKE_WORK = [
  "#!/usr/bin/perl",
  "use strict; use warnings; use JSON::PP; use File::Path qw(remove_tree make_path); use Time::HiRes qw(time sleep); use Cwd qw(getcwd);",
  "my $json = JSON::PP->new->canonical;",
  "my @a = @ARGV; shift @a if @a && $a[0] eq '--json';",
  "my $cmd = shift(@a) // '';",
  "sub slurp { my ($f) = @_; open(my $h, '<', $f) or return undef; local $/; my $t = <$h>; close $h; return $t }",
  "sub spew { my ($f, $t) = @_; open(my $h, '>', \"$f.$$\") or die \"$f: $!\"; print $h $t; close $h; rename(\"$f.$$\", $f) or die }",
  "if ($cmd eq 'bases') { print $json->encode([grep { length } split /\\n/, (slurp($ENV{FAKE_WORK_BASES}) // '')]), \"\\n\"; exit 0 }",
  "my $base = $ENV{WORK_BASE} // getcwd();",
  "my ($bdir, $bname) = $base =~ m{^(.*)/([^/]+)$};",
  "my $home = \"$bdir/.work/$bname\"; my $reg = \"$home/.fake-registry\"; make_path($reg);",
  "sub records { my @r; opendir(my $d, $reg) or return (); for my $f (sort readdir $d) { next unless $f =~ /\\.json$/; my $t = slurp(\"$reg/$f\"); push @r, $json->decode($t) if defined $t && length $t } closedir $d; return @r }",
  "sub note { my ($what, $kind, $name) = @_; my $log = $ENV{FAKE_LOG} or return; open(my $h, '>>', $log) or die; printf $h \"%s %s %s %s %.3f %d\\n\", $what, $kind, $name, $base, time, $$; close $h }",
  "sub hold { my $p = ($ENV{FAKE_HOLDS} // '/nonexistent') . \"/$_[0]\"; my $s = slurp($p) // 0; chomp $s; if ($s eq 'gate') { sleep(0.02) until -e \"$p.go\" } elsif ($s > 0) { sleep($s) } }",
  "if ($cmd eq 'list') { print $json->encode([records()]), \"\\n\"; exit 0 }",
  "if ($cmd eq 'doctor') { print $json->encode({ trusted => JSON::PP::true, cloners => [qw(btrfs reflink clonefile copy)] }), \"\\n\"; exit 0 }",
  "if ($cmd eq 'new') {",
  "  my ($branch, $from);",
  "  while (@a && $a[0] =~ /^-/) { my $o = shift @a; if ($o eq '-branch') { $branch = shift @a } elsif ($o eq '-from') { $from = shift @a } else { die \"fake work new: $o\\n\" } }",
  "  my $name = shift @a; my $path = \"$home/$name\"; my $id = sprintf('%d%d', time * 1000, $$);",
  "  note('in', 'clone', $name); hold($name);",
  "  system('/bin/cp', '-pPR', $base, $path) == 0 or die \"fake work new: cp failed\\n\";",
  "  note('out', 'clone', $name);",
  "  system('git', '-C', $path, 'checkout', '-q', '-B', $branch, (defined $from ? ($from) : ())) == 0 or die \"fake work new: checkout\\n\";",
  "  spew(\"$reg/$id.json\", $json->encode({ name => $name, id => $id, path => $path, parent => $base, branch => $branch, since => int(time), state => { _tag => 'Active' } }));",
  "  print $json->encode({ path => $path, deps => { _tag => 'NoDeps' }, hooks => { _tag => 'NoHooks' } }), \"\\n\"; exit 0;",
  "}",
  "if ($cmd eq 'rm') {",
  "  my $expect;",
  "  while (@a && $a[0] =~ /^-/) { my $o = shift @a; if ($o eq '-expect') { $expect = shift @a } elsif ($o eq '-abandon' || $o eq '-tree') {} else { die \"fake work rm: $o\\n\" } }",
  "  my $name = shift @a;",
  "  my ($rec) = grep { $_->{name} eq $name && $_->{state}{_tag} eq 'Active' } records();",
  "  $rec or do { print STDERR \"fake work rm: no workspace $name\\n\"; exit 1 };",
  "  !defined $expect || $rec->{id} eq $expect or do { print STDERR \"fake work rm: $name is not $expect\\n\"; exit 1 };",
  "  note('in', 'delete', $name); hold($name);",
  "  remove_tree($rec->{path}); unlink(\"$reg/$rec->{id}.json\");",
  "  note('out', 'delete', $name);",
  "  print $json->encode([{ id => $rec->{id}, trash => '', name => $name }]), \"\\n\"; exit 0;",
  "}",
  "die \"fake work: $cmd\\n\";",
  "",
].join("\n")

/** A stand-in `stat`: a path in FAKE_SUBVOLUMES (colon-separated) is the root of a btrfs subvolume; any other is not. */
const FAKE_STAT = [
  "#!/bin/sh",
  'case "$*" in',
  '  "-f -c %T "*) p=$4; k=fs ;;',
  '  "-c %i "*) p=$3; k=ino ;;',
  '  *) exec /usr/bin/stat "$@" ;;',
  "esac",
  'case ":${FAKE_SUBVOLUMES:-}:" in',
  '  *":$p:"*) if [ "$k" = fs ]; then echo btrfs; else echo 256; fi; exit 0 ;;',
  "esac",
  'if [ "$k" = fs ]; then echo apfs; else echo 1000; fi',
  "",
].join("\n")

/** A scratch HOME and bin (flock, work, stat), a bare origin, and a work base per name in `root`. */
const turnBench = (label: string, names: ReadonlyArray<string>) => {
  const dir = join(turnScratch, `${label}-${turnBenches++}`)
  const [home, bin, root, holds, proc] = ["home", "bin", "root", "holds", "proc"].map((each) => join(dir, each)) as [string, string, string, string, string]
  for (const each of [home, bin, root, holds, proc]) mkdirSync(each, { recursive: true })
  exe(join(bin, "flock"), FLOCK)
  exe(join(bin, "work"), FAKE_WORK)
  exe(join(bin, "stat"), FAKE_STAT)
  const basesFile = join(dir, "bases")
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !/^(WORKRIFT_|RIFT_|WORK_|WORK$|XDG_|GIT_|FAKE_)/.test(entry[0]),
    ),
  )
  const env: Env = {
    ...inherited,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    WORKRIFT_ROOT: root,
    WORKRIFT_PROC: proc,
    WORKRIFT_PURGE: "1",
    WORK: join(bin, "work"),
    FAKE_WORK_BASES: basesFile,
    FAKE_HOLDS: holds,
    GIT_AUTHOR_NAME: "Workrift Test",
    GIT_AUTHOR_EMAIL: "workrift@example.invalid",
    GIT_COMMITTER_NAME: "Workrift Test",
    GIT_COMMITTER_EMAIL: "workrift@example.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "gc.auto",
    GIT_CONFIG_VALUE_0: "0",
    GIT_CONFIG_KEY_1: "maintenance.auto",
    GIT_CONFIG_VALUE_1: "false",
  }
  const origin = join(dir, "origin.git")
  sh(dir, env, "git", "init", "-q", "--bare", "-b", "main", origin)
  const seed = join(dir, "seed")
  sh(dir, env, "git", "clone", "-q", origin, seed)
  sh(seed, env, "git", "switch", "-q", "-c", "main")
  writeFileSync(join(seed, "README.md"), "app\n")
  sh(seed, env, "git", "add", "README.md")
  sh(seed, env, "git", "commit", "-q", "-m", "init")
  sh(seed, env, "git", "push", "-q", "-u", "origin", "main")
  const bases = new Map<string, string>()
  for (const name of names) {
    const path = join(root, name)
    sh(dir, env, "git", "clone", "-q", origin, path)
    sh(path, env, "git", "remote", "set-head", "origin", "--auto")
    // This bench measures clone turns, not the one-off exclusive initialization of a base.
    writeFileSync(join(path, ".git/workrift.lock"), "")
    writeFileSync(join(path, ".git/info/exclude"), "work.toml\n", { flag: "a" })
    writeFileSync(join(path, "work.toml"), "")
    writeFileSync(basesFile, `${path}\n`, { flag: "a" })
    bases.set(name, path)
  }
  const base = (name: string) => bases.get(name) ?? ""
  /** A workspace made by the stand-in directly (no workrift, no log), for a remove to take. */
  const premade = (baseName: string, name: string) =>
    (JSON.parse(sh(base(baseName), { ...env, WORK_BASE: base(baseName) }, join(bin, "work"), "--json", "new", "-branch", name, "-from", "HEAD", name)) as { path: string }).path
  /** The base's workrift state folder, where its queues are. */
  const state = (baseName: string) => join(root, ".work", baseName, ".workrift")
  return { dir, env, root, holds, log: join(dir, "phases.log"), base, premade, state, names }
}
type TurnBench = ReturnType<typeof turnBench>

interface Op {
  readonly kind: "create" | "remove"
  readonly base: string
  /** The workspace's name (a create's branch is the same word). */
  readonly name: string
  /** When it starts, in ms after the schedule's start. */
  readonly at: number
  /** How long its clone or delete takes, in seconds. */
  readonly hold: number
  /** A fixture-controlled hold instead of a scheduled duration. */
  readonly gate?: true
  /** Don't launch this operation until the other one has entered its gated operation. */
  readonly afterEntered?: string
  /** Don't launch this operation until the other operation has an actual turn ticket. */
  readonly afterQueued?: string
  /** Its whole process group is killed (kill -9) this many ms after it starts. */
  readonly killAfter?: number
  /** Another script (the older workrift) runs it. */
  readonly script?: string
}

interface Phase {
  readonly kind: string
  readonly name: string
  readonly base: string
  readonly t0: number
  /** Its end; for a phase whose op was killed in it, the kill. */
  readonly t1: number
  readonly open: boolean
}

interface Turn {
  readonly base: string
  readonly number: number
  readonly name: string
  readonly purpose: string
}

interface Outcome {
  readonly op: Op
  readonly code: number | null
  readonly killedAt?: number
  readonly err: string
}

/** Hang guard for the actual shell and Git fixtures; never part of the FIFO/overlap oracle. */
const FIXTURE_HANG_GUARD_MS = 30_000

interface FixtureEvents {
  readonly entered: (name: string) => Promise<void>
  readonly queued: (name: string) => Promise<void>
  readonly release: (name: string) => void
  readonly kill: (name: string) => void
}

/**
 * Runs `ops` against the real script (each in a process group of its own, killed at the end whatever happens) while
 * a poller notes each turn ticket the moment it appears in a base's state folder, with its number and purpose.
 */
const runOps = async (b: TurnBench, ops: ReadonlyArray<Op>, snapshots: ReadonlyArray<string> = [], drive: (events: FixtureEvents) => Promise<void> = async () => {}) => {
  const env: Env = { ...b.env, FAKE_LOG: b.log, FAKE_SUBVOLUMES: snapshots.map(b.base).join(":") }
  const targets = new Map<string, string>()
  for (const op of ops) {
    if (op.kind === "remove") targets.set(op.name, b.premade(op.base, op.name))
    writeFileSync(join(b.holds, op.name), `${op.gate ? "gate" : op.hold}\n`)
  }
  const turns = new Map<string, Turn>()
  let polling = true
  const poll = (async () => {
    while (polling) {
      for (const name of b.names) {
        const state = b.state(name)
        if (!existsSync(state)) continue
        // Every queue whose name starts with clone: a split of the turn into queues of its own (a mutant) is seen too.
        for (const queue of readdirSync(state).filter((each) => each.startsWith("clone"))) {
          const dir = join(state, queue)
          for (const file of readOr(() => readdirSync(dir), [])) {
            const m = /^(\d+)\.[rw]$/.exec(file)
            const key = `${name}/${queue}/${file}`
            if (!m || turns.has(key)) continue
            // A ticket may end between the listing and the read.
            const record = textLines(readOr(() => readFileSync(join(dir, file), "utf8"), ""))
            if (record.length < 4) continue
            const purpose = record[3] ?? ""
            turns.set(key, { base: name, number: Number(m[1]), name: purpose.split(" ")[1] ?? "", purpose })
          }
        }
      }
      await Bun.sleep(5)
    }
  })()
  const groups = new Map<string, number>()
  const kills = new Map<string, number>()
  const kill = (name: string) => {
    const pid = groups.get(name)
    if (pid === undefined) throw new Error(`no test process group for ${name}`)
    try {
      // The request is written before the kernel could unblock the next waiter.
      appendFileSync(b.log, `kill - ${name}\n`)
      process.kill(-pid, "SIGKILL")
      kills.set(name, Date.now() / 1000)
    } catch {
      // It had ended; this is not a kill of a waiter or holder.
    }
  }
  const phaseLog = () => textLines(existsSync(b.log) ? readFileSync(b.log, "utf8") : "")
  const observe = async (what: string, ready: () => boolean) => {
    const deadline = performance.now() + FIXTURE_HANG_GUARD_MS
    while (!ready()) {
      if (!polling) throw new Error(`fixture ended before ${what}`)
      if (performance.now() > deadline) throw new Error(`hang guard: never saw ${what}`)
      await Bun.sleep(20)
    }
  }
  const events: FixtureEvents = {
    entered: (name) => observe(`${name} enter the fixture`, () => phaseLog().some((line) => line.startsWith(`in clone ${name} `) || line.startsWith(`in delete ${name} `))),
    queued: (name) => observe(`${name} in the clone turn`, () => [...turns.values()].some((turn) => turn.name === name)),
    release: (name) => writeFileSync(join(b.holds, `${name}.go`), ""),
    kill,
  }
  const started = Date.now()
  const jobs = Promise.all(
    ops.map(async (op): Promise<Outcome> => {
      if (op.afterEntered !== undefined) await events.entered(op.afterEntered)
      if (op.afterQueued !== undefined) await events.queued(op.afterQueued)
      const beforeStart = started + op.at - Date.now()
      if (beforeStart > 0) await Bun.sleep(beforeStart)
      if (!polling) throw new Error(`fixture ended before ${op.name} could start`)
      const script = op.script ?? TURN_SCRIPT
      const argv = op.kind === "create" ? [script, "create", op.name] : [script, "remove", targets.get(op.name) ?? ""]
      const errFile = join(b.dir, `${op.name}.err`)
      const child = Bun.spawn(argv, {
        cwd: op.kind === "create" ? b.base(op.base) : b.root,
        env: op.kind === "create" ? { ...env, WORKRIFT_SOURCE: b.base(op.base) } : env,
        stdout: "ignore",
        stderr: Bun.file(errFile),
        detached: true,
      })
      groups.set(op.name, child.pid)
      const timer =
        op.killAfter === undefined
          ? undefined
          : setTimeout(() => kill(op.name), op.killAfter)
      const watchdog = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL") } catch { /* already exited */ }
      }, FIXTURE_HANG_GUARD_MS)
      const code = await child.exited.finally(() => {
        clearTimeout(watchdog)
        if (timer) clearTimeout(timer)
      })
      const killedAt = kills.get(op.name)
      return { op, code, ...(killedAt === undefined ? {} : { killedAt }), err: readFileSync(errFile, "utf8") }
    }),
  )
  const [outcomes] = await Promise.all([jobs, drive(events)]).finally(() => {
    polling = false
    for (const pid of groups.values())
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        // ended
      }
  })
  await poll
  const open = new Map<string, { kind: string; base: string; t0: number }>()
  const phases: Array<Phase> = []
  for (const [index, line] of phaseLog().entries()) {
    const [what = "", kind = "", name = "", base = ""] = line.split(" ")
    if (what === "kill" && !kills.has(name)) continue
    if (what === "in") open.set(name, { kind, base, t0: index })
    else {
      const o = open.get(name)
      if (o) phases.push({ ...o, name, base: basename(o.base), t1: index, open: what === "kill" })
      open.delete(name)
    }
  }
  for (const [name, o] of open) phases.push({ ...o, name, base: basename(o.base), t1: Infinity, open: true })
  return { outcomes, phases, turns: [...turns.values()] }
}

/** Pairs of phases (of one base, or any two when `across`) whose times overlap. */
const overlapping = (phases: ReadonlyArray<Phase>) => {
  const found: Array<string> = []
  for (let i = 0; i < phases.length; i++)
    for (let j = i + 1; j < phases.length; j++) {
      const a = phases[i]!
      const c = phases[j]!
      if (a.base === c.base && a.t0 < c.t1 && c.t0 < a.t1) found.push(`${a.kind} ${a.name} x ${c.kind} ${c.name} (${a.base})`)
    }
  return found
}

/**
 * The reference model: on a copy base, one server, first come first served. Every clone and delete takes a turn;
 * no two of one base overlap; they run in the order of their tickets' numbers (the order of arrival, numbered under
 * queue.lock). Every surviving operation enters its clone/delete and completes. A snapshot base takes no turn.
 * A vanished holder must let the next ticket enter; the focused case below keeps the fixture from ending by itself.
 */
const judge = (run: Awaited<ReturnType<typeof runOps>>, bases: ReadonlyArray<string>, snapshots: ReadonlyArray<string> = []) => {
  const bad: Array<string> = []
  for (const o of run.outcomes) {
    if (o.killedAt !== undefined) continue
    if (o.code !== 0) bad.push(`${o.op.kind} ${o.op.name} ended ${o.code}: ${textLines(o.err).slice(-3).join(" | ")}`)
    if (!run.phases.some((p) => p.name === o.op.name && !p.open)) bad.push(`${o.op.kind} ${o.op.name} did not finish its actual operation`)
  }
  for (const p of run.phases) if (p.open && p.t1 === Infinity) bad.push(`${p.kind} ${p.name} never ended and was not killed`)
  for (const base of bases) {
    const phases = run.phases.filter((p) => p.base === base)
    const tickets = run.turns.filter((t) => t.base === base).sort((a, c) => a.number - c.number)
    if (snapshots.includes(base)) {
      if (tickets.length > 0) bad.push(`${base} is a snapshot base, yet ${tickets.map((t) => t.purpose).join(", ")} took a turn`)
      continue
    }
    bad.push(...overlapping(phases))
    for (const p of phases) if (!tickets.some((t) => t.name === p.name)) bad.push(`${p.kind} ${p.name} ran with no turn (${base})`)
    const byStart = [...phases].sort((a, c) => a.t0 - c.t0).map((p) => p.name)
    const byTicket = tickets.map((t) => t.name).filter((name) => phases.some((p) => p.name === name))
    if (byStart.join(" ") !== byTicket.join(" ")) bad.push(`${base}: phases ran ${byStart.join(" ")}, but arrived ${byTicket.join(" ")}`)
  }
  return bad
}

/** A generated schedule of creates and removes on bases A and B, some killed while they wait or hold. */
const turnSchedule = (seed: number): ReadonlyArray<Op> => {
  const next = random(seed)
  const n = 4 + Math.floor(next() * 4)
  return Array.from({ length: n }, (_, i): Op => {
    const kind = next() < 0.55 ? "create" : "remove"
    const base = next() < 0.65 ? "A" : "B"
    const at = Math.floor(next() * 1200)
    const hold = 0.2 + Math.floor(next() * 5) / 10
    const killAfter = next() < 0.18 ? 200 + Math.floor(next() * 1500) : undefined
    return { kind, base, name: `${kind === "create" ? "c" : "r"}${seed}x${i}`, at, hold, ...(killAfter === undefined ? {} : { killAfter }) }
  })
}

describe("the clone turn: one clone or delete at a time per copy base, in arrival order (the real script on stand-ins)", () => {
  test(
    "property: generated creates and removes on two bases, some killed waiting or holding, run as the reference model's one server per base",
    async () => {
      let killed = 0
      let both = 0
      for (let seed = 1; seed <= 6; seed++) {
        const b = turnBench(`gen${seed}`, ["A", "B"])
        const ops = turnSchedule(seed)
        const run = await runOps(b, ops)
        killed += run.outcomes.filter((o) => o.killedAt !== undefined).length
        both += run.phases.some((p) => p.kind === "clone") && run.phases.some((p) => p.kind === "delete") ? 1 : 0
        expect({ seed, bad: judge(run, ["A", "B"]) }).toEqual({ seed, bad: [] })
      }
      // The schedules exercise what they claim: kills, and creates beside removes.
      expect(killed).toBeGreaterThan(0)
      expect(both).toBeGreaterThan(2)
    },
    240_000,
  )

  test("a clone never overlaps a delete of its base, removes go one at a time, and a later create waits behind an earlier remove", async () => {
    const b = turnBench("kinds", ["A"])
    const ops: ReadonlyArray<Op> = [
      { kind: "remove", base: "A", name: "r1", at: 0, hold: 0, gate: true },
      { kind: "remove", base: "A", name: "r2", at: 0, hold: 0, afterEntered: "r1" },
      { kind: "create", base: "A", name: "c1", at: 0, hold: 0, afterQueued: "r2" },
      { kind: "create", base: "A", name: "c2", at: 0, hold: 0, afterQueued: "c1" },
    ]
    const run = await runOps(b, ops, [], async (events) => {
      await events.queued("c2")
      events.release("r1")
    })
    expect(judge(run, ["A"])).toEqual([])
    expect(run.phases.map((p) => p.name).sort()).toEqual(["c1", "c2", "r1", "r2"])
  }, FIXTURE_HANG_GUARD_MS + 30_000)

  test("two bases do not wait for each other: a long clone of A and a long delete of B run together", async () => {
    const b = turnBench("two", ["A", "B"])
    const run = await runOps(b, [
      { kind: "create", base: "A", name: "ca", at: 0, hold: 0, gate: true },
      { kind: "remove", base: "B", name: "rb", at: 0, hold: 0, gate: true },
    ], [], async (events) => {
      await Promise.all([events.entered("ca"), events.entered("rb")])
      events.release("ca")
      events.release("rb")
    })
    expect(judge(run, ["A", "B"])).toEqual([])
    const [ca, rb] = ["ca", "rb"].map((name) => run.phases.find((p) => p.name === name)!)
    expect(ca!.t0 < rb!.t1 && rb!.t0 < ca!.t1).toBe(true)
  }, FIXTURE_HANG_GUARD_MS + 30_000)

  test("a holder killed in its clone frees the turn: the queued delete enters without releasing the clone's gate", async () => {
    const b = turnBench("killed", ["A"])
    const run = await runOps(b, [
      { kind: "create", base: "A", name: "c0", at: 0, hold: 0, gate: true },
      { kind: "remove", base: "A", name: "r1", at: 0, hold: 0, gate: true, afterEntered: "c0" },
    ], [], async (events) => {
      await events.entered("c0")
      await events.queued("r1")
      events.kill("c0")
      await events.entered("r1")
      events.release("r1")
    })
    expect(judge(run, ["A"])).toEqual([])
    const c0 = run.phases.find((p) => p.name === "c0")!
    const r1 = run.phases.find((p) => p.name === "r1")!
    expect(c0.open).toBe(true)
    expect(r1.t0).toBeGreaterThanOrEqual(c0.t1)
    expect(existsSync(join(b.holds, "c0.go"))).toBe(false)
  }, FIXTURE_HANG_GUARD_MS + 30_000)

  test("a snapshot base (a btrfs subvolume whose work clones by btrfs) takes no turn: its clones and deletes run side by side, while a copy base beside it still takes turns", async () => {
    const b = turnBench("snap", ["S", "A"])
    const concurrent = ["s1", "s2", "s3", "sr"]
    const run = await runOps(
      b,
      [
        ...concurrent.slice(0, 3).map((name): Op => ({ kind: "create", base: "S", name, at: 0, hold: 0, gate: true })),
        { kind: "remove", base: "S", name: "sr", at: 0, hold: 0, gate: true },
        { kind: "create", base: "A", name: "a1", at: 0, hold: 0.6 },
        { kind: "remove", base: "A", name: "ar", at: 50, hold: 0.6 },
      ],
      ["S"],
      async (events) => {
        await Promise.all(concurrent.map(events.entered))
        for (const name of concurrent) events.release(name)
      },
    )
    expect(judge(run, ["S", "A"], ["S"])).toEqual([])
    expect(overlapping(run.phases.filter((p) => p.base === "S")).length).toBeGreaterThan(0)
  }, FIXTURE_HANG_GUARD_MS + 30_000)

  test("beside the script before the turn (83b97f9e) installed by rename: old creates and removes take no turn and are not starved; nothing deadlocks; the new ones still take turns among themselves", async () => {
    const b = turnBench("old", ["A"])
    const old = join(b.dir, "workrift-83b97f9e")
    writeFileSync(old, sh(turnRepo, b.env, "git", "show", "83b97f9e:workbox/bin/workrift"))
    chmodSync(old, 0o755)
    const run = await runOps(b, [
      { kind: "create", base: "A", name: "n1", at: 0, hold: 0.8 },
      { kind: "create", base: "A", name: "o1", at: 50, hold: 0.8, script: old },
      { kind: "remove", base: "A", name: "nr", at: 100, hold: 0.8 },
      { kind: "remove", base: "A", name: "or", at: 150, hold: 0.8, script: old },
      { kind: "create", base: "A", name: "n2", at: 200, hold: 0.8 },
    ])
    const failed = run.outcomes.filter((o) => o.code !== 0).map((o) => `${o.op.name} ${o.code}: ${textLines(o.err).slice(-2).join(" | ")}`)
    expect(failed).toEqual([])
    const fresh = run.phases.filter((p) => !p.name.startsWith("o"))
    expect(fresh).toHaveLength(3)
    expect(overlapping(fresh)).toEqual([])
    expect(run.turns.map((t) => t.name).sort()).toEqual(["n1", "n2", "nr"])
  }, 60_000)
})
