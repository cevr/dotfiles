// A review's receipt inputs as the host's files (mods/orchestrate/batch-input.ts `ReceiptSource`): Work's receipts
// and land records in its receipts folder, the updater's installed record and handoff marker, each read whole from
// one opened handle; and the updater's record decoded by its own reader. Nothing here touches the run's own records.
import { buildOf, goodOf, parseRecord } from "@dotfiles/opencode-update/record"
import { type Duration, Effect, Fiber, FileSystem, Layer, Match, Option, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { type BuildFacts, type InstalledFacts, isObjectName, objectName, ReceiptSource, SourceRead, SourceRef, sourceKey, SourceUnreadable } from "../batch-input.ts"

/**
 * Where a review's inputs live on one host (batch-input.ts `ReceiptSource`): Work's receipts folder (each receipt
 * `<head>.<kind>.json`, each land record `<head>.land.json`), the updater's installed record and its handoff marker,
 * and the repository whose checkouts a receipt may name. These configured locations are not supplied by a receipt
 * or derived from the reviewed checkout. All four kinds use Work's replacement-only publisher.
 */
export interface ReceiptPlaces {
  readonly host: string
  readonly repository: { readonly key: string; readonly checkouts: ReadonlyArray<string> }
  readonly receipts: string
  readonly installed: string
  readonly handoff: string
  /** The largest file read whole; a larger one is refused. */
  readonly maxBytes: number
  /** Deadline for one whole observation, including child I/O; scope exit adds at most the termination grace. */
  readonly readWithin: Duration.Input
}

// The host FileSystem cannot pass O_NONBLOCK. Use the system Perl on macOS/Linux for POSIX sysopen and fstat,
// in a process the read can terminate. No shell or inherited Perl startup options; parameters are separate argv.
// Walk the configured, bound directory using no-follow directory opens and fchdir, checking every held directory
// identity. No path item from the observed tree can authorize a different root. Only the held regular fd can
// supply bytes. Check the same handle before/after the exact-size read, then rewalk before emitting bytes.
const READ_FILE = `
use strict;
use warnings;
use Cwd qw(getcwd);
use Errno qw(ELOOP ENOENT);
use Fcntl qw(O_RDONLY O_DIRECTORY O_NOFOLLOW O_NONBLOCK O_NOCTTY S_ISREG S_ISLNK);
use Time::HiRes qw(stat);
binmode STDOUT, ':raw' or exit 1;
sub answer { print STDOUT @_ or exit 1; close STDOUT or exit 1; exit 0; }
my ($bound, $directory, $leaf, $cap) = @ARGV;
answer('U') unless $directory =~ m{^/} && $leaf !~ m{/} && $leaf ne '.' && $leaf ne '..';
my @bound = split m{/}, $bound;
my @parts = grep { length } split m{/}, $directory;
sub same_dir {
  my ($dir, $id) = @_;
  my @info = stat($dir);
  return @info && "$info[0]:$info[1]" eq $id;
}
chdir('/') or answer('U');
same_dir('.', shift @bound) or answer('U');
sub walk {
  my ($first_walk) = @_;
  my @expected = @bound;
  for my $part (@parts) {
    my $id = shift @expected;
    unless (sysopen(my $dir, $part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK)) {
      answer('A') if $first_walk && !defined($id) && $! == ENOENT;
      answer('U');
    } else {
      # Nothing created after setup can supply a missing directory identity.
      answer('U') unless defined($id) && same_dir($dir, $id);
      chdir($dir) && close($dir) or answer('U');
    }
  }
}
walk(1);
my @look = lstat($leaf);
answer('L') if @look && S_ISLNK($look[2]);
answer('N') if @look && !S_ISREG($look[2]);
unless (sysopen(my $file, $leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY)) {
  my $link = $! == ELOOP;
  my $missing = $! == ENOENT;
  my @entry = lstat($leaf);
  answer('L') if $link || (@entry && S_ISLNK($entry[2]));
  answer('N') if @entry && !S_ISREG($entry[2]);
  if ($missing && !@entry && $! == ENOENT) {
    chdir('/') or answer('U');
    walk(0);
    @entry = lstat($leaf);
    answer('A') if !@entry && $! == ENOENT;
  }
  answer('U');
} else {
  my @held = stat($file);
  answer('U') unless @held;
  answer('N') unless S_ISREG($held[2]);
  answer('H') if $held[3] > 1;
  answer('U') unless $held[3] == 1;
  answer('S') if $held[7] > $cap;
  my $bytes = '';
  while (length($bytes) < $held[7]) {
    my $remaining = $held[7] - length($bytes);
    my $count = sysread($file, my $part, $remaining < 16384 ? $remaining : 16384);
    answer('U') unless $count;
    $bytes .= $part;
  }
  my $extra = sysread($file, my $extra_byte, 1);
  answer('U') unless defined($extra);
  my @still = stat($file);
  answer('U') unless @still;
  answer('S') if $still[7] > $cap;
  answer('U') if $extra || grep { $held[$_] != $still[$_] } (0, 1, 2, 3, 7, 9, 10);
  # Rewalk the original rooted path, not a mutable canonicalization of the configured name.
  answer('U') unless (getcwd() // '') eq $directory;
  chdir('/') or answer('U');
  walk(0);
  my @named = lstat($leaf);
  answer('U') unless @named && $held[0] == $named[0] && $held[1] == $named[1];
  close($file) or answer('U');
  answer('P', $bytes);
}
`

/** A build the record names, its two commits full object names (each repository's own format); none when either is not. */
const buildFacts = (build: { readonly version: string; readonly dotfiles: string; readonly fork: string }): Option.Option<BuildFacts> =>
  Option.map(Option.all({ dotfiles: objectName(build.dotfiles), fork: objectName(build.fork) }), ({ dotfiles, fork }) => ({ version: build.version, dotfiles, fork }))

/** A named build that names a commit by anything but its full name makes the whole record corrupt. */
const named = <A>(build: Option.Option<A>, facts: (build: A) => Option.Option<BuildFacts>): Option.Option<Option.Option<BuildFacts>> =>
  Option.match(build, { onNone: () => Option.some(Option.none()), onSome: (each) => Option.map(facts(each), Option.some) })

/**
 * The updater's record in a file's text, through its own `parseRecord`, `buildOf` and `goodOf`; none for text that is
 * not one, or whose installed or good build names a commit by anything but its full object name.
 */
export const installedFacts = (text: string): Option.Option<InstalledFacts> =>
  Option.flatMap(parseRecord(text), (record) => Option.all({ installed: named(buildOf(record), buildFacts), good: named(goodOf(record), buildFacts) }))

/** Strict UTF-8 that keeps a byte-order mark as text, so the text's UTF-8 encoding is the file's bytes exactly. */
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const terminate = { forceKillAfter: "100 millis" } as const

/**
 * The receipt source over the host's files: a reference names one allowlisted file (a head must be a full object
 * name, so it names no path), read whole, as its exact bytes, from one opened handle, only when it is a
 * regular file with one name, no larger than `maxBytes`, and strict UTF-8. A missing file or folder is absent; any
 * other failure, a file moved while it was read included, is unreadable (read again), never absent.
 */
export const receiptSource = (places: ReceiptPlaces) =>
  Layer.effect(
    ReceiptSource,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner
      const roots = places.repository.checkouts.map((root) => path.resolve(root))
      // Only these fixed system aliases may be resolved, at setup. A link anywhere else is never a root.
      const systemAlias = (folder: string) =>
        Effect.gen(function* () {
          const first = path.join("/", folder.split("/").slice(1, 2).join(""))
          if (first !== "/var" && first !== "/tmp" && first !== "/etc") return folder
          const real = yield* fs.realPath(first).pipe(Effect.orElseSucceed(() => first))
          if (real !== `/private${first}`) return folder
          return `${real}${folder.slice(first.length)}`
        })
      const bind = (configured: string) =>
        Effect.gen(function* () {
          const folder = yield* systemAlias(path.resolve(configured))
          const components = folder.split("/").filter((part) => part.length > 0)
          const prefixes = ["/", ...components.map((_, i) => path.join("/", ...components.slice(0, i + 1)))]
          const ids: Array<string> = []
          for (const prefix of prefixes) {
            const info = yield* fs.lstat(prefix).pipe(
              Effect.map(Option.some),
              Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed(Option.none())),
            )
            if (Option.isNone(info)) break
            if (info.value.type !== "Directory" || Option.isNone(info.value.ino)) return Option.none()
            ids.push(`${info.value.dev}:${info.value.ino.value}`)
          }
          if (ids.length === 0) return Option.none()
          return Option.some({ folder, bound: ids.join("/") })
        }).pipe(Effect.timeoutOrElse({ duration: places.readWithin, orElse: () => Effect.succeed(Option.none()) }), Effect.orElseSucceed(() => Option.none()))
      const { receiptFolder, installFolder, handoffFolder } = yield* Effect.all({
        receiptFolder: bind(places.receipts),
        installFolder: bind(path.dirname(places.installed)),
        handoffFolder: bind(path.dirname(places.handoff)),
      }, { concurrency: 3 })
      /** The allowlisted folder and file name a reference names; none for a head that is not a full object name. */
      const placeOf = (ref: SourceRef) =>
        SourceRef.$match(ref, {
          Receipt: (each) => Option.map(Option.liftPredicate(each.head, isObjectName), (head) => ({ root: receiptFolder, name: `${head}.${each.kind}.json` })),
          Land: (each) => Option.map(Option.liftPredicate(each.head, isObjectName), (head) => ({ root: receiptFolder, name: `${head}.land.json` })),
          Installed: () => Option.some({ root: installFolder, name: path.basename(places.installed) }),
          Handoff: () => Option.some({ root: handoffFolder, name: path.basename(places.handoff) }),
        })
      const unreadable = (ref: SourceRef, message: string) => new SourceUnreadable({ source: sourceKey(ref), message })
      const reply = (ref: SourceRef, child: ChildProcessSpawner.ChildProcessHandle) =>
        Effect.gen(function* () {
          const bytes = new Uint8Array(places.maxBytes + 1)
          const size = yield* Stream.runFoldEffect(child.stdout, () => 0, (offset, chunk) => {
            if (offset > bytes.byteLength) return Effect.succeed(offset)
            // Kill the producer at the cap, then discard anything already in the bounded pipe until EOF.
            // Stopping the stream first could leave the host's stdout pipe paused with bytes still in it.
            if (chunk.byteLength > bytes.byteLength - offset) return Effect.as(Effect.ignore(child.kill(terminate)), bytes.byteLength + 1)
            bytes.set(chunk, offset)
            return Effect.succeed(offset + chunk.byteLength)
          })
          if (size > bytes.byteLength) return yield* unreadable(ref, "file reader exceeded its byte limit")
          return bytes.subarray(0, size)
        })
      const decode = (ref: SourceRef, bytes: Uint8Array) =>
        Match.value(String.fromCharCode(...bytes.subarray(0, 1))).pipe(
          Match.when("P", () =>
            Effect.try({ try: () => SourceRead.Present({ text: utf8.decode(bytes.subarray(1)) }), catch: () => "not text" }).pipe(
              Effect.orElseSucceed(() => SourceRead.Refused({ reason: "not text" })),
            ),
          ),
          Match.when("L", () => Effect.succeed(SourceRead.Refused({ reason: "a link" }))),
          Match.when("A", () => Effect.succeed(SourceRead.Absent())),
          Match.when("N", () => Effect.succeed(SourceRead.Refused({ reason: "not a regular file" }))),
          Match.when("H", () => Effect.succeed(SourceRead.Refused({ reason: "a hard link" }))),
          Match.when("S", () => Effect.succeed(SourceRead.Refused({ reason: "too large" }))),
          Match.orElse(() => Effect.fail(unreadable(ref, "file reader could not verify the opened file"))),
        )
      /** Keep the pipe draining until after the producer has stopped, including on caller interruption. */
      const drain = (ref: SourceRef, child: ChildProcessSpawner.ChildProcessHandle) =>
        Effect.gen(function* () {
          const pump = yield* Effect.forkScoped(Effect.interruptible(reply(ref, child)))
          yield* Effect.addFinalizer(() =>
            Effect.flatMap(child.isRunning, (running) => Match.value(running).pipe(
              Match.when(true, () => child.kill(terminate)),
              Match.orElse(() => Effect.void),
            )).pipe(
              Effect.ignore,
              Effect.andThen(Fiber.await(pump).pipe(Effect.timeoutOption("100 millis"), Effect.interruptible, Effect.asVoid)),
            ),
          )
          return pump
        })
      /** Register both parts of the resource before interruption can observe a half-acquired reader. */
      const start = (ref: SourceRef, bound: string, folder: string, name: string) =>
        Effect.gen(function* () {
          const child = yield* processes.spawn(ChildProcess.make("/usr/bin/perl", ["-e", READ_FILE, "--", bound, folder, name, String(places.maxBytes)], {
            env: {},
            detached: true,
            stdin: "ignore",
            stderr: "ignore",
            ...terminate,
          })).pipe(Effect.mapError(() => unreadable(ref, "file reader could not start")))
          return { child, pump: yield* drain(ref, child) }
        }).pipe(Effect.uninterruptible)
      const readOpened = (ref: SourceRef, bound: string, folder: string, name: string) =>
        Effect.gen(function* () {
          const { child, pump } = yield* start(ref, bound, folder, name)
          const bytes = yield* Fiber.join(pump).pipe(Effect.catchTag("PlatformError", () => Effect.fail(unreadable(ref, "file reader pipe failed"))))
          const code = yield* child.exitCode.pipe(Effect.mapError(() => unreadable(ref, "file reader exit was unavailable")))
          if (code !== 0) return yield* unreadable(ref, "file reader did not exit cleanly")
          return yield* decode(ref, bytes)
        })
      const read = Effect.fn("ReceiptSource.read")(function* (ref: SourceRef) {
        const place = placeOf(ref)
        if (Option.isNone(place)) return SourceRead.Refused({ reason: "not a commit name" })
        const root = place.value.root
        if (Option.isNone(root)) return yield* unreadable(ref, "file reader could not bind the configured directory")
        // Our scope owns the child's pipes and lifetime even when the deadline interrupts the read.
        return yield* readOpened(ref, root.value.bound, root.value.folder, place.value.name).pipe(
          Effect.timeoutOrElse({ duration: places.readWithin, orElse: () => Effect.fail(unreadable(ref, "file reader did not return in time")) }),
          Effect.scoped,
        )
      })
      return ReceiptSource.of({
        host: places.host,
        repository: places.repository.key,
        repositoryOf: (checkout) =>
          Option.map(
            Option.liftPredicate(path.resolve(checkout), (resolved) => path.isAbsolute(checkout) && roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))),
            () => places.repository.key,
          ),
        read,
      })
    }),
  )
