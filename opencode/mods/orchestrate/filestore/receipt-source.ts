// A review's receipt inputs as the host's files (mods/orchestrate/batch-input.ts `ReceiptSource`): Work's receipts
// and land records in its receipts folder, the updater's installed record and handoff marker, each read whole from
// one opened handle; and the updater's record decoded by its own reader. Nothing here touches the run's own records.
import { buildOf, goodOf, parseRecord } from "@dotfiles/opencode-update/record"
import { type Duration, Effect, Fiber, FileSystem, Layer, Match, Option, Path, type PlatformError, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { type BuildFacts, type InstalledFacts, isObjectName, objectName, ReceiptSource, SourceRead, SourceRef, sourceKey, SourceUnreadable } from "../batch-input.ts"

/**
 * Where a review's inputs live on one host (batch-input.ts `ReceiptSource`): Work's receipts folder (each receipt
 * `<head>.<kind>.json`, each land record `<head>.land.json`), the updater's installed record and its handoff marker,
 * and the repository whose checkouts a receipt may name. Nothing else is ever opened.
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
// Walk the canonical directory using no-follow directory opens and fchdir, so a parent swap cannot redirect the
// leaf open. Only the held regular fd can supply bytes. Before emitting them, verify its name and directory again.
const READ_FILE = `
use strict;
use warnings;
use Cwd qw(realpath getcwd);
use Errno qw(ELOOP);
use Fcntl qw(O_RDONLY O_DIRECTORY O_NOFOLLOW O_NONBLOCK O_NOCTTY S_ISREG S_ISLNK);
binmode STDOUT, ':raw' or exit 1;
sub answer { print STDOUT @_ or exit 1; close STDOUT or exit 1; exit 0; }
my ($configured, $directory, $leaf, $cap) = @ARGV;
answer('U') unless $directory =~ m{^/} && $leaf !~ m{/} && $leaf ne '.' && $leaf ne '..';
chdir('/') or answer('U');
for my $part (grep { length } split m{/}, $directory) {
  sysopen(my $dir, $part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK) or answer('U');
  chdir($dir) && close($dir) or answer('U');
}
unless (sysopen(my $file, $leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY)) {
  my $link = $! == ELOOP;
  my @entry = lstat($leaf);
  answer('L') if $link || (@entry && S_ISLNK($entry[2]));
  answer('N') if @entry && !S_ISREG($entry[2]);
  answer('U');
} else {
  my @held = stat($file);
  answer('U') unless @held;
  answer('N') unless S_ISREG($held[2]);
  answer('H') if $held[3] > 1;
  answer('S') if $held[7] > $cap;
  my $bytes = '';
  while (length($bytes) <= $cap) {
    my $remaining = $cap + 1 - length($bytes);
    my $count = sysread($file, my $part, $remaining < 16384 ? $remaining : 16384);
    answer('U') unless defined($count);
    last unless $count;
    $bytes .= $part;
  }
  answer('S') if length($bytes) > $cap;
  my @still = stat($file);
  my @named = lstat($leaf);
  answer('U') unless @still && @named && $still[3] == 1 &&
    $held[0] == $named[0] && $held[1] == $named[1] &&
    (getcwd() // '') eq $directory && (realpath($configured) // '') eq $directory;
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
 * name, so it names no path), read whole, as its exact bytes, from one opened handle (`whole`), only when it is a
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
      /** The allowlisted folder and file name a reference names; none for a head that is not a full object name. */
      const placeOf = (ref: SourceRef): Option.Option<{ readonly folder: string; readonly name: string }> =>
        SourceRef.$match(ref, {
          Receipt: (each) => Option.map(Option.liftPredicate(each.head, isObjectName), (head) => ({ folder: places.receipts, name: `${head}.${each.kind}.json` })),
          Land: (each) => Option.map(Option.liftPredicate(each.head, isObjectName), (head) => ({ folder: places.receipts, name: `${head}.land.json` })),
          Installed: () => Option.some({ folder: path.dirname(places.installed), name: path.basename(places.installed) }),
          Handoff: () => Option.some({ folder: path.dirname(places.handoff), name: path.basename(places.handoff) }),
        })
      const unreadable = (ref: SourceRef, message: string) => new SourceUnreadable({ source: sourceKey(ref), message })
      const notFound = (error: PlatformError.PlatformError | SourceUnreadable) => error._tag === "PlatformError" && error.reason._tag === "NotFound"
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
          Match.when("N", () => Effect.succeed(SourceRead.Refused({ reason: "not a regular file" }))),
          Match.when("H", () => Effect.succeed(SourceRead.Refused({ reason: "a hard link" }))),
          Match.when("S", () => Effect.succeed(SourceRead.Refused({ reason: "too large" }))),
          Match.orElse(() => Effect.fail(unreadable(ref, "file reader could not verify the opened file"))),
        )
      /** Keep the pipe draining until after the producer has stopped, including on caller interruption. */
      const drain = (ref: SourceRef, child: ChildProcessSpawner.ChildProcessHandle) =>
        Effect.uninterruptible(Effect.gen(function* () {
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
        }))
      const readOpened = (ref: SourceRef, configured: string, folder: string, name: string) =>
        Effect.gen(function* () {
          const child = yield* processes.spawn(ChildProcess.make("/usr/bin/perl", ["-e", READ_FILE, "--", configured, folder, name, String(places.maxBytes)], {
            env: {},
            detached: true,
            stdin: "ignore",
            stderr: "ignore",
            ...terminate,
          })).pipe(Effect.mapError(() => unreadable(ref, "file reader could not start")))
          const pump = yield* drain(ref, child)
          const bytes = yield* Fiber.join(pump).pipe(Effect.catchTag("PlatformError", () => Effect.fail(unreadable(ref, "file reader pipe failed"))))
          const code = yield* child.exitCode.pipe(Effect.mapError(() => unreadable(ref, "file reader exit was unavailable")))
          if (code !== 0) return yield* unreadable(ref, "file reader did not exit cleanly")
          return yield* decode(ref, bytes)
        })
      const whole = (ref: SourceRef, place: { readonly folder: string; readonly name: string }) =>
        Effect.gen(function* () {
          const configured = path.resolve(place.folder)
          const folder = yield* fs.realPath(configured)
          const entry = yield* fs.lstat(path.join(folder, place.name))
          if (entry.type === "SymbolicLink") return SourceRead.Refused({ reason: "a link" })
          if (entry.type !== "File") return SourceRead.Refused({ reason: "not a regular file" })
          return yield* readOpened(ref, configured, folder, place.name)
        })
      const read = Effect.fn("ReceiptSource.read")(function* (ref: SourceRef) {
        const place = placeOf(ref)
        if (Option.isNone(place)) return SourceRead.Refused({ reason: "not a commit name" })
        // Our scope owns the child's pipes and lifetime even when the deadline interrupts the read.
        return yield* whole(ref, place.value).pipe(
          Effect.timeoutOrElse({ duration: places.readWithin, orElse: () => Effect.fail(unreadable(ref, "file reader did not return in time")) }),
          Effect.scoped,
          Effect.catchIf(notFound, () => Effect.succeed(SourceRead.Absent())),
          Effect.catchTag("PlatformError", (error) => Effect.fail(unreadable(ref, error.message))),
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
