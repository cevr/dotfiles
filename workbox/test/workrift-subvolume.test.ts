// `workrift subvolume`: the real script on stand-ins, on the Mac. A base is a btrfs subvolume here when its inode is
// in the bench's registry (inodes follow a folder through renames and exchanges, as a subvolume's root does): `stat`
// answers btrfs for every path under the bench, and inode 256 for a registered one; `btrfs` makes, snapshots and
// deletes registered folders; `work` is a stand-in that snapshots a registered base and copies any other; `python3`
// is the real one (renamex_np's RENAME_SWAP stands for renameat2's RENAME_EXCHANGE), with hooks around an exchange
// for the writers of the model (move.qnt); `cp -a --reflink=always` is BSD cp, slowed, failed or killed on request;
// `findmnt`, `df` and /sys/fs/btrfs are files of the bench; /proc is a folder of the bench. Nothing touches the host.
import { afterAll, describe, expect, test } from "bun:test"
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repo = join(import.meta.dir, "..", "..")
const SCRIPT = process.env.WORKRIFT_SCRIPT ?? join(repo, "workbox/bin/workrift")
const PYTHON = Bun.which("python3") ?? "/usr/bin/python3"
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "workrift-subvolume-")))
// WORKRIFT_TEST_KEEP=1 keeps every bench (its state, journal and trees) for a failure to be read after.
afterAll(() => (process.env.WORKRIFT_TEST_KEEP ? console.log(`benches kept in ${scratch}`) : rmSync(scratch, { recursive: true, force: true })))
let benches = 0

type Env = Record<string, string>
interface Ran {
  readonly code: number | null
  readonly signal: string | null
  readonly out: string
  readonly err: string
}

const exe = (path: string, body: string) => {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}
const textLines = (text: string) => text.split("\n").filter((line) => line !== "")
const sh = (cwd: string, env: Env, ...argv: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync([...argv], { cwd, env, stdout: "pipe", stderr: "pipe" })
  if (ran.exitCode !== 0) throw new Error(`${argv.join(" ")} failed (${ran.exitCode}): ${ran.stderr.toString()}`)
  return ran.stdout.toString()
}

/** util-linux flock's forms workrift uses, over Perl's flock(2) (as the other workrift tests'). */
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

/** The registry of subvolume roots, by inode, shared by the stand-ins (FAKE_SUBVOLS). */
const REGISTRY_PERL = [
  "use Fcntl qw(:flock);",
  "sub reg_lock { open(my $l, '>>', \"$ENV{FAKE_SUBVOLS}.lock\") or die; flock($l, LOCK_EX); return $l }",
  "sub reg_all { open(my $h, '<', $ENV{FAKE_SUBVOLS}) or return (); my @r = grep { length } map { chomp; $_ } <$h>; close $h; return @r }",
  "sub reg_has { my ($i) = @_; return scalar grep { $_ eq $i } reg_all() }",
  "sub reg_add { my ($i) = @_; my $l = reg_lock(); open(my $h, '>>', $ENV{FAKE_SUBVOLS}) or die; print $h \"$i\\n\"; close $h }",
  "sub reg_del { my ($i) = @_; my $l = reg_lock(); my @r = grep { $_ ne $i } reg_all(); open(my $h, '>', $ENV{FAKE_SUBVOLS}) or die; print $h map { \"$_\\n\" } @r; close $h }",
  "sub ino { my @s = lstat($_[0]) or return undef; return $s[1] }",
].join("\n")

/** `stat -f -c %T P` (btrfs under the bench) and `stat -c %i P` (256 for a registered root); the rest is the real one. */
const STAT = [
  "#!/usr/bin/perl",
  "use strict; use warnings;",
  REGISTRY_PERL,
  "my @a = @ARGV;",
  "if (@a == 4 && $a[0] eq '-f' && $a[1] eq '-c' && $a[2] eq '%T') { -e $a[3] or exit 1; print((index($a[3], $ENV{FAKE_BTRFS_ROOT}) == 0 ? 'btrfs' : 'apfs'), \"\\n\"); exit 0 }",
  "if (@a == 3 && $a[0] eq '-c' && $a[1] eq '%i') { my $i = ino($a[2]); defined $i or exit 1; print((reg_has($i) ? 256 : $i), \"\\n\"); exit 0 }",
  "exec('/usr/bin/stat', @a);",
  "",
].join("\n")

/** `btrfs subvolume create|delete|snapshot` and `inspect-internal rootid` on the registry; each call logged. */
const BTRFS = [
  "#!/usr/bin/perl",
  "use strict; use warnings; use File::Path qw(remove_tree);",
  REGISTRY_PERL,
  "my @a = @ARGV;",
  "open(my $log, '>>', $ENV{FAKE_BTRFS_LOG}) or die; print $log join(' ', @a), \"\\n\"; close $log;",
  "my $what = \"$a[0] $a[1]\";",
  "if (($ENV{FAKE_BTRFS_FAIL} // '') eq $what) { print STDERR \"ERROR: cannot $what: No space left on device\\n\"; exit 1 }",
  "my @p = grep { $_ ne '--' } @a[2 .. $#a];",
  "if ($what eq 'subvolume create') { mkdir($p[0]) or do { print STDERR \"ERROR: cannot create $p[0]: $!\\n\"; exit 1 }; reg_add(ino($p[0])); exit 0 }",
  "if ($what eq 'subvolume delete') { my $i = ino($p[0]); defined $i && reg_has($i) or do { print STDERR \"ERROR: Not a Btrfs subvolume: $p[0]\\n\"; exit 1 }; remove_tree($p[0]); reg_del($i); exit 0 }",
  "if ($what eq 'subvolume snapshot') { my $i = ino($p[0]); defined $i && reg_has($i) or do { print STDERR \"ERROR: Not a Btrfs subvolume: $p[0]\\n\"; exit 1 }; system('/bin/cp', '-pPR', $p[0], $p[1]) == 0 or exit 1; reg_add(ino($p[1])); exit 0 }",
  "if ($what eq 'inspect-internal rootid') { my $i = ino($p[0]); defined $i or exit 1; print((reg_has($i) ? 5000 + $i : 5), \"\\n\"); exit 0 }",
  "print STDERR \"fake btrfs: $what\\n\"; exit 1;",
  "",
].join("\n")

/**
 * A stand-in `work`: bases from FAKE_WORK_BASES, one record a file in <base's folder>/.work/<base>/.fake-registry.
 * `new` snapshots a base whose root is a registered subvolume (cloner btrfs) and copies any other (reflink), around a
 * sleep of FAKE_HOLDS/NAME seconds, logging `in`/`out` lines to FAKE_LOG; `rm` deletes by the record's cloner
 * (trash = false); `doctor`, `refresh` (logged to FAKE_WORK_LOG), `list`, `bases`, `init`. FAKE_SMOKE_CLONER forces
 * the cloner a record says (a smoke workspace that is no snapshot).
 */
const WORK = [
  "#!/usr/bin/perl",
  "use strict; use warnings; use JSON::PP; use File::Path qw(remove_tree make_path); use Time::HiRes qw(time sleep); use Cwd qw(getcwd);",
  REGISTRY_PERL,
  "my $json = JSON::PP->new->canonical;",
  "my @a = @ARGV; shift @a if @a && $a[0] eq '--json';",
  "my $cmd = shift(@a) // '';",
  "sub slurp { my ($f) = @_; open(my $h, '<', $f) or return undef; local $/; my $t = <$h>; close $h; return $t }",
  "sub spew { my ($f, $t) = @_; open(my $h, '>', \"$f.$$\") or die \"$f: $!\"; print $h $t; close $h; rename(\"$f.$$\", $f) or die }",
  "if ($cmd eq 'bases') { print $json->encode([grep { length } split /\\n/, (slurp($ENV{FAKE_WORK_BASES}) // '')]), \"\\n\"; exit 0 }",
  "my $base = $ENV{WORK_BASE} // getcwd();",
  "if ($ENV{FAKE_WORK_LOG}) { open(my $l, '>>', $ENV{FAKE_WORK_LOG}) or die; print $l join(' ', $cmd, @a), \" in $base\\n\"; close $l }",
  "if ($cmd eq 'init') { unless (-e \"$base/work.toml\") { open(my $t, '>', \"$base/work.toml\") or die; close $t } open(my $b, '>>', $ENV{FAKE_WORK_BASES}) or die; print $b \"$base\\n\"; close $b; exit 0 }",
  "my ($bdir, $bname) = $base =~ m{^(.*)/([^/]+)$};",
  "my $home = \"$bdir/.work/$bname\"; my $reg = \"$home/.fake-registry\"; make_path($reg);",
  "sub records { my @r; opendir(my $d, $reg) or return (); for my $f (sort readdir $d) { next unless $f =~ /\\.json$/; my $t = slurp(\"$reg/$f\"); push @r, $json->decode($t) if defined $t && length $t } closedir $d; return @r }",
  "sub note { my ($what, $kind, $name) = @_; my $log = $ENV{FAKE_LOG} or return; open(my $h, '>>', $log) or die; printf $h \"%s %s %s %s %.3f %d\\n\", $what, $kind, $name, $base, time, $$; close $h }",
  "sub hold { my $s = slurp(($ENV{FAKE_HOLDS} // '/nonexistent') . \"/$_[0]\"); $s = 0 unless defined $s; chomp $s; sleep($s) if $s > 0 }",
  "if ($cmd eq 'list') { print $json->encode([records()]), \"\\n\"; exit 0 }",
  "if ($cmd eq 'doctor') { print $json->encode({ trusted => JSON::PP::true, purgeOneCall => JSON::PP::true, fileSystem => 'btrfs', staleIndex => 0, cloners => [qw(btrfs reflink clonefile copy)], notes => ['trash: false'] }), \"\\n\"; exit 0 }",
  "if ($cmd eq 'refresh') { print \"0\\n\"; exit 0 }",
  "if ($cmd eq 'new') {",
  "  my ($branch, $from);",
  "  while (@a && $a[0] =~ /^-/) { my $o = shift @a; if ($o eq '-branch') { $branch = shift @a } elsif ($o eq '-from') { $from = shift @a } else { die \"fake work new: $o\\n\" } }",
  "  my $name = shift @a; my $path = \"$home/$name\"; my $id = sprintf('%d%d', time * 1000, $$);",
  "  note('in', 'clone', $name); hold($name);",
  "  my $cloner;",
  "  if (reg_has(ino($base))) { system('btrfs', 'subvolume', 'snapshot', $base, $path) == 0 or die \"fake work new: snapshot failed\\n\"; $cloner = 'btrfs' }",
  "  else { system('/bin/cp', '-pPR', $base, $path) == 0 or die \"fake work new: cp failed\\n\"; $cloner = 'reflink' }",
  "  note('out', 'clone', $name);",
  "  $cloner = $ENV{FAKE_SMOKE_CLONER} if defined $ENV{FAKE_SMOKE_CLONER} && $name eq 'scratch-subvolume-smoke';",
  "  system('git', '-C', $path, 'checkout', '-q', '-B', $branch, (defined $from ? ($from) : ())) == 0 or die \"fake work new: checkout\\n\";",
  "  spew(\"$reg/$id.json\", $json->encode({ name => $name, id => $id, path => $path, parent => $base, branch => $branch, since => int(time), cloner => $cloner, state => { _tag => 'Active' } }));",
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
  "  if (reg_has(ino($rec->{path}) // -1)) { system('btrfs', 'subvolume', 'delete', $rec->{path}) == 0 or die } else { remove_tree($rec->{path}) }",
  "  unlink(\"$reg/$rec->{id}.json\");",
  "  note('out', 'delete', $name);",
  "  print $json->encode([{ id => $rec->{id}, trash => '', name => $name }]), \"\\n\"; exit 0;",
  "}",
  "die \"fake work: $cmd\\n\";",
  "",
].join("\n")

/** `cp -a --reflink=always FROM TO` as BSD cp; FAKE_CP=enospc fails it (a full disk), FAKE_CP=die kills the caller. */
const CP = [
  "#!/bin/sh",
  'if [ "$1" = -a ] && [ "$2" = --reflink=always ]; then',
  '  [ -z "${FAKE_CP_LOG:-}" ] || printf "%s %s\\n" "$4" "$(perl -MTime::HiRes=time -e \'printf "%.3f", time\')" >>"$FAKE_CP_LOG"',
  '  [ -z "${FAKE_CP_DELAY:-}" ] || sleep "$FAKE_CP_DELAY"',
  // The first copy only: FAKE_CP_AFTER runs once the tree is copied (a Git process that lands in the base meanwhile),
  // then FAKE_CP_REFS_LAST=1 copies the base's refs again (a walk that reached the refs after that process).
  '  if [ -n \"${FAKE_CP_ONCE:-}\" ] && [ ! -e \"$FAKE_CP_ONCE\" ]; then',
  '    : >\"$FAKE_CP_ONCE\"',
  '    /bin/cp -pPR \"$3\" \"$4\" || exit 1',
  '    [ -z \"${FAKE_CP_AFTER:-}\" ] || sh -c \"$FAKE_CP_AFTER\" sh \"$3\" \"$4\" || exit 1',
  '    if [ -n \"${FAKE_CP_REFS_LAST:-}\" ]; then /bin/cp -pPR \"$3/.git/refs/.\" \"$4/.git/refs/\"; [ ! -f \"$3/.git/packed-refs\" ] || /bin/cp -p \"$3/.git/packed-refs\" \"$4/.git/packed-refs\"; fi',
  '    exit 0',
  '  fi',
  '  case "${FAKE_CP:-}" in',
  '    enospc) /bin/cp -pPR "$3" "$4"; echo "cp: error writing \'$4/README.md\': No space left on device" >&2; exit 1 ;;',
  '    die) /bin/cp -pPR "$3" "$4"; kill -KILL "$PPID"; exit 1 ;;',
  "  esac",
  '  exec /bin/cp -pPR "$3" "$4"',
  "fi",
  'exec /bin/cp "$@"',
  "",
].join("\n")

/** git, logging each call (FAKE_GIT_LOG) when asked; FAKE_GIT_FAIL_ONCE (a case pattern of its arguments) fails the first call that matches (fatal, 128), as a Git that could not start on a loaded host. */
const GIT_REAL = Bun.which("git") ?? "/usr/bin/git"
const GIT = [
  "#!/bin/sh",
  '[ -z "${FAKE_GIT_LOG:-}" ] || printf "%s\\n" "$*" >>"$FAKE_GIT_LOG"',
  'if [ -n "${FAKE_GIT_FAIL_ONCE:-}" ] && [ ! -e "$FAKE_GIT_FAIL_ONCE_MARK" ]; then',
  '  case "$*" in $FAKE_GIT_FAIL_ONCE) : >"$FAKE_GIT_FAIL_ONCE_MARK"; echo "fatal: injected: $*" >&2; exit 128 ;; esac',
  "fi",
  `exec '${GIT_REAL}' "$@"`,
  "",
].join("\n")

/** python3, with FAKE_BEFORE_EXCHANGE / FAKE_AFTER_EXCHANGE run around the first exchange, FAKE_EXCHANGE_FAIL failing it. */
const PY = [
  "#!/bin/sh",
  'if [ "$1" = -c ] && [ "$3" = exchange ]; then',
  '  [ -n "${FAKE_EXCHANGE_FAIL:-}" ] && { echo "exchange: Operation not permitted" >&2; exit 1; }',
  '  first=; [ -e "$FAKE_HOOKS_DONE" ] || { first=1; : >"$FAKE_HOOKS_DONE"; }',
  '  [ -z "$first" ] || [ -z "${FAKE_BEFORE_EXCHANGE:-}" ] || sh -c "$FAKE_BEFORE_EXCHANGE" || exit 1',
  `  '${PYTHON}' "$@" || exit $?`,
  '  [ -z "$first" ] || [ -z "${FAKE_AFTER_EXCHANGE:-}" ] || sh -c "$FAKE_AFTER_EXCHANGE" || exit 1',
  "  exit 0",
  "fi",
  `exec '${PYTHON}' "$@"`,
  "",
].join("\n")

const FINDMNT = [
  "#!/bin/sh",
  'case "$*" in',
  '  *"-o OPTIONS"*) printf "%s\\n" "${FAKE_MOUNT_OPTIONS-rw,noatime,compress=zstd:3,space_cache=v2,user_subvol_rm_allowed,subvol=/@workspaces}" ;;',
  "  *\"-o SOURCE\"*) echo '/dev/loop0[/@workspaces]' ;;",
  "  *) exit 1 ;;",
  "esac",
  "",
].join("\n")

const DF = [
  "#!/bin/sh",
  "echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
  'echo "/dev/loop0 796917760 650117120 ${FAKE_DF_AVAIL:-116916224} ${FAKE_DF_PCT:-82}% /workspaces"',
  "",
].join("\n")

const UUID = "170ee675-18a3-48e1-931d-f0a84a51df83"

/** A bench: the stand-ins first on PATH, a bare origin, the base `app` (a plain folder, work.toml, two branches). */
const bench = (label: string) => {
  const dir = join(scratch, `${label}-${benches++}`)
  const [home, bin, root, holds, proc, sys] = ["home", "bin", "root", "holds", "proc", "sys"].map((each) => join(dir, each)) as [string, string, string, string, string, string]
  for (const each of [home, bin, root, holds, proc]) mkdirSync(each, { recursive: true })
  mkdirSync(join(sys, UUID, "devices"), { recursive: true })
  writeFileSync(join(sys, UUID, "devices", "loop0"), "")
  mkdirSync(join(sys, UUID, "allocation/metadata"), { recursive: true })
  writeFileSync(join(sys, UUID, "allocation/metadata/total_bytes"), `${57 * 2 ** 30}\n`)
  writeFileSync(join(sys, UUID, "allocation/metadata/bytes_used"), `${43 * 2 ** 30}\n`)
  for (const [name, body] of [["flock", FLOCK], ["stat", STAT], ["btrfs", BTRFS], ["work", WORK], ["cp", CP], ["python3", PY], ["git", GIT], ["findmnt", FINDMNT], ["df", DF]] as const)
    exe(join(bin, name), body)
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !/^(WORKRIFT_|RIFT_|WORK_|WORK$|XDG_|GIT_|FAKE_)/.test(entry[0])),
  )
  const basesFile = join(dir, "bases")
  const env: Env = {
    ...inherited,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: join(home, ".config"),
    WORKRIFT_ROOT: root,
    WORKRIFT_PROC: proc,
    WORKRIFT_STAT_PROC: proc,
    WORKRIFT_SYSFS_BTRFS: sys,
    WORKRIFT_PURGE: "1",
    WORK: join(bin, "work"),
    FAKE_WORK_BASES: basesFile,
    FAKE_HOLDS: holds,
    FAKE_SUBVOLS: join(dir, "subvolumes"),
    FAKE_BTRFS_ROOT: dir,
    FAKE_BTRFS_LOG: join(dir, "btrfs-calls"),
    FAKE_WORK_LOG: join(dir, "work-calls"),
    FAKE_LOG: join(dir, "phases.log"),
    FAKE_HOOKS_DONE: join(dir, "hooks-done"),
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
  writeFileSync(env.FAKE_SUBVOLS!, "")
  const origin = join(dir, "origin.git")
  sh(dir, env, "git", "init", "-q", "--bare", "-b", "main", origin)
  const seed = join(dir, "seed")
  sh(dir, env, "git", "clone", "-q", origin, seed)
  sh(seed, env, "git", "switch", "-q", "-c", "main")
  writeFileSync(join(seed, "README.md"), "app\n")
  sh(seed, env, "git", "add", "README.md")
  sh(seed, env, "git", "commit", "-q", "-m", "init")
  sh(seed, env, "git", "push", "-q", "-u", "origin", "main")
  sh(seed, env, "git", "commit", "-q", "--allow-empty", "-m", "feat a")
  sh(seed, env, "git", "push", "-q", "origin", "HEAD:refs/heads/feat-a")
  sh(seed, env, "git", "reset", "-q", "--hard", "HEAD~1")
  const base = join(root, "app")
  sh(dir, env, "git", "clone", "-q", origin, base)
  sh(base, env, "git", "remote", "set-head", "origin", "--auto")
  sh(base, env, "git", "branch", "-q", "feat-a", "origin/feat-a")
  writeFileSync(join(base, ".git/info/exclude"), "work.toml\n", { flag: "a" })
  writeFileSync(join(base, "work.toml"), "")
  writeFileSync(basesFile, `${base}\n`)
  const head = sh(base, env, "git", "rev-parse", "HEAD").trim()
  const move = join(root, ".subvolume-move")
  const paths = { base, new: join(move, "app.new"), back: join(move, "app.back"), old: join(move, "app.old") }
  const state = join(root, ".work", "app", ".workrift")
  const envFor = (extra: Env = {}): Env => ({ ...env, WORKRIFT_SOURCE: base, ...extra })
  /** Every command of the bench with its full output, in <bench>.commands.log beside it (out of the trees the dry-run tests hash): a failure is read from it, never from a grep. */
  const logged = (argv: ReadonlyArray<string>, ran: Ran): Ran => {
    writeFileSync(`${dir}.commands.log`, `$ workrift ${argv.join(" ")} (${new Date().toISOString()})\n${said(ran)}\n`, { flag: "a" })
    return ran
  }
  /** Runs workrift in the bench's folder (outside the base). */
  const wr = (argv: ReadonlyArray<string>, extra: Env = {}): Ran => {
    const ran = Bun.spawnSync([SCRIPT, ...argv], { cwd: dir, env: envFor(extra), stdout: "pipe", stderr: "pipe" })
    return logged(argv, { code: ran.exitCode, signal: ran.signalCode ?? null, out: ran.stdout.toString(), err: ran.stderr.toString() })
  }
  /** The same, without blocking: cases run side by side. */
  const wrAsync = async (argv: ReadonlyArray<string>, extra: Env = {}): Promise<Ran> => {
    const child = Bun.spawn([SCRIPT, ...argv], { cwd: dir, env: envFor(extra), stdout: "pipe", stderr: "pipe" })
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    await child.exited
    return logged(argv, { code: child.signalCode ? null : child.exitCode, signal: child.signalCode ?? null, out, err })
  }
  const registered = () => textLines(readFileSync(env.FAKE_SUBVOLS!, "utf8"))
  /** S (a registered subvolume root), F (a folder), - (nothing). */
  const kind = (path: string) => {
    if (!existsSync(path)) return "-"
    return registered().includes(String(lstatSync(path).ino)) ? "S" : "F"
  }
  const layout = () => ({ base: kind(paths.base), new: kind(paths.new), back: kind(paths.back), old: kind(paths.old) })
  const refs = (path: string) => sh(path, env, "git", "for-each-ref", "--format=%(objectname) %(refname)").trim()
  const original = refs(base)
  const btrfsCalls = () => (existsSync(env.FAKE_BTRFS_LOG!) ? textLines(readFileSync(env.FAKE_BTRFS_LOG!, "utf8")) : [])
  const workCalls = () => (existsSync(env.FAKE_WORK_LOG!) ? textLines(readFileSync(env.FAKE_WORK_LOG!, "utf8")) : [])
  const records = () =>
    JSON.parse(sh(base, { ...env, WORK_BASE: base }, join(bin, "work"), "--json", "list")) as ReadonlyArray<{ name: string; cloner: string; path: string }>
  /** A workspace made by the stand-in directly, as a lane made before the switch. */
  const premade = (name: string) =>
    (JSON.parse(sh(base, { ...env, WORK_BASE: base }, join(bin, "work"), "--json", "new", "-branch", name, "-from", head, name)) as { path: string }).path
  const phase = () => (existsSync(join(state, "subvolume/phase")) ? readFileSync(join(state, "subvolume/phase"), "utf8").trim() : "")
  const steps = () =>
    existsSync(join(state, "subvolume/log")) ? textLines(readFileSync(join(state, "subvolume/log"), "utf8")).map((line) => line.split(" ")[1]!.replace(/:$/, "")) : []
  /** A process of the stand-in /proc: its working folder, command line and open files. */
  const processAt = (pid: number, cwd: string, argv: ReadonlyArray<string> = ["sh"], fds: ReadonlyArray<string> = []) => {
    const at = join(proc, String(pid))
    mkdirSync(join(at, "fd"), { recursive: true })
    symlinkSync(cwd, join(at, "cwd"))
    writeFileSync(join(at, "cmdline"), `${argv.join("\0")}\0`)
    writeFileSync(join(at, "comm"), `${argv[0]?.split("/").at(-1) ?? "sh"}\n`)
    // A process of the owner's own: its environment reads (empty here).
    writeFileSync(join(at, "environ"), "")
    fds.forEach((file, i) => symlinkSync(file, join(at, "fd", String(10 + i))))
    return at
  }
  return { dir, bin, root, holds, proc, sys, env, envFor, base, head, paths, state, wr, wrAsync, kind, layout, refs, original, btrfsCalls, workCalls, records, premade, phase, steps, processAt, registered, move }
}
type Bench = ReturnType<typeof bench>

/** Every file and folder under `dir`, relative to it, sorted. */
const filesUnder = (dir: string): ReadonlyArray<string> => readdirSync(dir, { recursive: true, encoding: "utf8" }).map(String).sort()

/** The base is whole: its README and every ref it had. */
const whole = (b: Bench, path = b.base) => {
  expect(readFileSync(join(path, "README.md"), "utf8")).toBe("app\n")
  for (const line of textLines(b.original)) expect(b.refs(path)).toContain(line)
}

/** After a forward switch: the base a subvolume, the old folder kept, no copy left, the switch recorded. */
const converted = (b: Bench) => {
  expect(b.layout()).toEqual({ base: "S", new: "-", back: "-", old: "F" })
  whole(b)
  whole(b, b.paths.old)
  expect(b.phase()).toMatch(/^switched /)
  expect(b.records().filter((r) => r.name === "scratch-subvolume-smoke")).toEqual([])
}

/** Runs the tasks four at a time (the host's heavy share), every one to its end; the first failure is thrown after. */
const pool = async (tasks: ReadonlyArray<() => Promise<void>>, width = 4) => {
  const failures: Array<unknown> = []
  let next = 0
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < tasks.length) {
        const task = tasks[next++]!
        await task().catch((error: unknown) => {
          failures.push(error)
          // A loop that hunts a rare failure keeps every one, not only the first.
          if (process.env.WORKRIFT_TEST_KEEP) console.error(`POOL FAILURE ${failures.length}:`, error)
        })
      }
    }),
  )
  if (failures.length > 0) throw failures[0]
}

const said = (ran: Ran) => `${ran.code} ${ran.signal}\n${ran.out}\n${ran.err}`

describe("workrift subvolume: dry run and refusals", () => {
  test("without --apply it prints the preflight and every step with its absolute paths, and changes nothing; --check is the same", () => {
    const b = bench("dry")
    // The base's state folder, which any workrift command makes.
    mkdirSync(b.state, { recursive: true })
    const before = { root: filesUnder(b.root), dir: filesUnder(b.dir) }
    for (const argv of [["subvolume"], ["subvolume", "--check"]]) {
      const ran = b.wr(argv)
      expect(ran.code, said(ran)).toBe(0)
      expect(ran.out).toContain(`${b.base} is a plain folder`)
      expect(ran.out).toContain("  ok    the mount has user_subvol_rm_allowed")
      expect(ran.out).toContain("  ok    quotas are off")
      expect(ran.out).toContain(`btrfs subvolume create ${b.paths.new}`)
      expect(ran.out).toContain(`cp -a --reflink=always ${b.base}/. ${b.paths.new}/`)
      expect(ran.out).toContain(`exchange ${b.base} and ${b.paths.new}`)
      expect(ran.out).toContain(`rename ${b.paths.new} to ${b.paths.old}`)
      expect(ran.out).toContain("dry run: nothing changed")
      expect(ran.out).not.toContain("NO ")
    }
    expect(b.btrfsCalls()).toEqual([])
    expect({ root: filesUnder(b.root), dir: filesUnder(b.dir).filter((f) => !f.startsWith("work-calls")) }).toEqual(before)
  }, 120_000)

  test("a command that fails stops the switch with the three facts: what failed and its status at which step, the state of both trees, the next command", () => {
    const b = bench("silent")
    // The step log a directory: its rm fails before anything changes.
    mkdirSync(join(b.state, "subvolume/log"), { recursive: true })
    const ran = b.wr(["subvolume", "--apply"])
    expect(ran.code, said(ran)).toBe(1)
    expect(ran.err).toMatch(/^workrift: rm of the old step log \S+ \(nothing changed\) failed \(status [1-9]\d*\) at the step start$/m)
    expect(ran.err).toContain(`workrift subvolume: state: ${b.base} is a plain folder (the live base)`)
    expect(ran.err).toContain(`workrift subvolume: next: cd / && WORKRIFT_SOURCE=${b.base} workrift subvolume --apply`)
    expect(b.layout()).toEqual({ base: "F", new: "-", back: "-", old: "-" })
    whole(b)
  })

  test("a path that is not a work base is refused; a base already a subvolume is a no-op that says so", () => {
    const b = bench("notbase")
    const plain = join(b.root, "plain")
    mkdirSync(join(plain, ".git"), { recursive: true })
    for (const source of [plain, join(b.root, "missing")]) {
      const ran = b.wr(["subvolume", "--apply"], { WORKRIFT_SOURCE: source })
      expect(ran.code).toBe(1)
      expect(ran.err).toMatch(/not a (work base|Git repository)/)
    }
    writeFileSync(join(plain, "work.toml"), "")
    const unlisted = b.wr(["subvolume", "--apply"], { WORKRIFT_SOURCE: plain })
    expect(unlisted.code).toBe(1)
    expect(unlisted.err).toContain("work --json bases does not list it")
    expect(b.btrfsCalls()).toEqual([])

    writeFileSync(b.env.FAKE_SUBVOLS!, `${lstatSync(b.base).ino}\n`)
    for (const argv of [["subvolume"], ["subvolume", "--apply"]]) {
      const ran = b.wr(argv)
      expect(ran.code, said(ran)).toBe(0)
      expect(ran.out).toContain(`${b.base} is already a btrfs subvolume: nothing to do`)
    }
    expect(b.btrfsCalls()).toEqual([])
  }, 120_000)

  test("each preflight gate refuses with its reason and changes nothing: mount option, quotas, metadata slack, free space, a removal, a process in the base, an older workrift, a Git lock", () => {
    const b = bench("gates")
    mkdirSync(b.state, { recursive: true })
    const old = join(b.dir, "workrift-old")
    writeFileSync(old, "#!/bin/sh\n\n# Branch workspaces on top of Rift.\nexit 0\n")
    const cases: ReadonlyArray<{ readonly what: string; readonly env?: Env; readonly arrange?: () => () => void; readonly says: string }> = [
      { what: "mount", env: { FAKE_MOUNT_OPTIONS: "rw,noatime" }, says: "lacks user_subvol_rm_allowed" },
      {
        what: "quotas",
        arrange: () => {
          mkdirSync(join(b.sys, UUID, "qgroups"))
          return () => rmSync(join(b.sys, UUID, "qgroups"), { recursive: true })
        },
        says: "quotas are on",
      },
      { what: "slack", env: { WORKRIFT_SUBVOLUME_MIN_SLACK_MIB: "20000" }, says: "metadata slack 14336 MiB < 20000 MiB" },
      { what: "used", env: { FAKE_DF_PCT: "93" }, says: "used 93% (needs < 90%)" },
      { what: "free", env: { FAKE_DF_AVAIL: "1048576" }, says: "free 1024 MiB (needs 40960)" },
      {
        what: "removal",
        arrange: () => {
          const at = b.processAt(91001, b.dir, ["/bin/sh", "/home/x/.local/bin/workrift", "remove", "/x/y"])
          return () => rmSync(at, { recursive: true })
        },
        says: "91001 workrift remove",
      },
      {
        what: "work rm",
        arrange: () => {
          const at = b.processAt(91002, b.dir, ["work", "--json", "rm", "-abandon", "x"])
          return () => rmSync(at, { recursive: true })
        },
        says: "91002 work rm",
      },
      {
        what: "shell in the base",
        arrange: () => {
          const at = b.processAt(91003, join(b.base, "src"), ["zsh"])
          return () => rmSync(at, { recursive: true })
        },
        says: "91003 zsh",
      },
      {
        what: "open file in the base",
        arrange: () => {
          const at = b.processAt(91004, b.dir, ["tail"], [join(b.base, "README.md")])
          return () => rmSync(at, { recursive: true })
        },
        says: "91004 tail",
      },
      {
        what: "older workrift",
        arrange: () => {
          const at = b.processAt(91005, b.dir, ["/bin/sh", old, "create", "feat/x"], [old])
          return () => rmSync(at, { recursive: true })
        },
        says: "91005 workrift create (an older script",
      },
      {
        what: "git lock",
        arrange: () => {
          writeFileSync(join(b.base, ".git/index.lock"), "")
          return () => rmSync(join(b.base, ".git/index.lock"))
        },
        says: ".git/index.lock",
      },
    ]
    for (const each of cases) {
      const undo = each.arrange?.()
      const before = filesUnder(b.root)
      const ran = b.wr(["subvolume", "--apply"], each.env)
      expect({ what: each.what, code: ran.code, refused: ran.err.includes("refused: nothing changed"), says: ran.out.includes(each.says) }).toEqual({
        what: each.what,
        code: 1,
        refused: true,
        says: true,
      })
      expect(filesUnder(b.root)).toEqual(before)
      undo?.()
    }
    expect(b.btrfsCalls()).toEqual([])
    // A workrift that runs this script (it has the file open) is in line, or soon will be: not refused.
    b.processAt(91006, b.dir, ["/bin/sh", SCRIPT, "create", "feat/y"], [SCRIPT])
    const ok = b.wr(["subvolume"])
    expect(ok.code, said(ok)).toBe(0)
  }, 120_000)

  test("a removal of this base always refuses, --beside-other-removals or not; one of another base refuses unless --beside-other-removals, which runs beside it and says how many it saw", () => {
    const b = bench("removals")
    mkdirSync(b.state, { recursive: true })
    const home = join(b.root, ".work", "app")
    // This base's, told by an argument, by the working folder, and by WORKRIFT_SOURCE.
    const ours: ReadonlyArray<() => string> = [
      () => b.processAt(92001, b.dir, ["/bin/sh", "/home/x/.local/bin/workrift", "remove", join(home, "lane")]),
      () => b.processAt(92002, b.base, ["work", "--json", "rm", "-abandon", "lane"]),
      () => {
        const at = b.processAt(92003, b.dir, ["/bin/sh", "/home/x/.local/bin/workrift", "prune"])
        writeFileSync(join(at, "environ"), `HOME=/home/x\0WORKRIFT_SOURCE=${b.base}\0`)
        return at
      },
    ]
    for (const make of ours) {
      const at = make()
      const pid = at.split("/").at(-1)!
      for (const flags of [[], ["--beside-other-removals"]]) {
        const before = filesUnder(b.root)
        const ran = b.wr(["subvolume", "--apply", ...flags])
        expect({ pid, flags, code: ran.code, says: ran.out.includes(`a removal of ${b.base} runs; let it end: ${pid} `) }, said(ran)).toEqual({ pid, flags, code: 1, says: true })
        expect(filesUnder(b.root)).toEqual(before)
      }
      rmSync(at, { recursive: true })
    }
    expect(b.btrfsCalls()).toEqual([])
    // Another base's: refused without the flag, naming it and where it runs.
    const otherBase = join(b.root, "other")
    mkdirSync(otherBase)
    b.processAt(92010, otherBase, ["work", "--json", "rm", "-abandon", "x"])
    const refused = b.wr(["subvolume", "--apply"])
    expect(refused.code, said(refused)).toBe(1)
    expect(refused.out).toContain(`1 removal(s) of another base run, which slow the copy`)
    expect(refused.out).toContain(`92010 work rm (in ${otherBase})`)
    expect(b.btrfsCalls()).toEqual([])
    const dry = b.wr(["subvolume", "--beside-other-removals"])
    expect(dry.code, said(dry)).toBe(0)
    expect(dry.out).toContain(`  ok    beside 1 removal(s) of another base (--beside-other-removals): 92010 work rm (in ${otherBase})`)
    const ran = b.wr(["subvolume", "--apply", "--beside-other-removals"])
    expect(ran.code, said(ran)).toBe(0)
    expect(ran.out).toContain("it ran beside 1 removal(s) of another base, the most its checks saw (--beside-other-removals)")
    converted(b)
  }, 60_000)
})

describe("workrift subvolume --apply", () => {
  test("converts the base: a subvolume at its path with every ref and file, the old folder kept at .old by its identity, work refresh run, the smoke workspace made as a snapshot and removed; a create after it is a snapshot; lanes made before stay", () => {
    const b = bench("apply")
    const lane = b.premade("lane-before")
    const ran = b.wr(["subvolume", "--apply"])
    expect(ran.code, said(ran)).toBe(0)
    converted(b)
    expect(ran.out).toContain(`${b.base} is now a btrfs subvolume`)
    expect(ran.out).toContain(`the tree it was is kept at ${b.paths.old} (folder `)
    expect(ran.out).toContain("work refresh ran")
    expect(b.workCalls().some((c) => c === `refresh in ${b.base}`)).toBe(true)
    expect(b.workCalls().some((c) => c.startsWith("new -branch scratch-subvolume-smoke"))).toBe(true)
    expect(readFileSync(join(b.state, "subvolume/kept"), "utf8")).toBe(`${b.paths.old}\nfolder ${lstatSync(b.paths.old).ino}\n`)
    expect(b.steps()).toEqual(["copy-make", "copy", "refresh", "verify", "swap", "swapped", "carry-wait", "carry", "work-refresh", "prove", "smoke", "smoke-rm", "switched"])
    expect(b.kind(lane)).toBe("F")
    expect(b.records().find((r) => r.name === "lane-before")?.cloner).toBe("reflink")
    const made = b.wr(["create", "after"])
    expect(made.code, said(made)).toBe(0)
    expect(b.records().find((r) => r.name === "after")?.cloner).toBe("btrfs")
    expect(b.kind(textLines(made.out).at(-1) ?? "")).toBe("S")
    // A second run: nothing to do.
    const again = b.wr(["subvolume", "--apply"])
    expect(again.code).toBe(0)
    expect(again.out).toContain("already a btrfs subvolume: nothing to do; the tree it was is kept at")
  }, 60_000)

  test("in line with creates and removes: it waits for a clone under way, creates and removes that come during the hold wait for it and end as snapshots, and its turn line names it", async () => {
    const b = bench("line")
    const removable = b.premade("gone-lane")
    writeFileSync(join(b.holds, "early"), "2\n")
    const cpLog = join(b.dir, "cp-log")
    const spawn = (argv: ReadonlyArray<string>, extra: Env = {}) =>
      Bun.spawn([SCRIPT, ...argv], { cwd: b.dir, env: b.envFor(extra), stdout: "pipe", stderr: "pipe", detached: true })
    const children: Array<ReturnType<typeof spawn>> = []
    try {
      const early = spawn(["create", "early"])
      children.push(early)
      // The early create is in its clone before the switch arrives.
      for (let i = 0; i < 200 && !(existsSync(b.env.FAKE_LOG!) && readFileSync(b.env.FAKE_LOG!, "utf8").includes("in clone early")); i++) await Bun.sleep(25)
      const move = spawn(["subvolume", "--apply"], { FAKE_CP_DELAY: "2", FAKE_CP_LOG: cpLog })
      children.push(move)
      for (let i = 0; i < 400 && !existsSync(cpLog); i++) await Bun.sleep(25)
      expect(existsSync(cpLog)).toBe(true)
      const late = ["late1", "late2"].map((name) => spawn(["create", name]))
      const remover = spawn(["remove", removable])
      // A writer of the base (as an advance or a refresh): the exclusive lock, after the switch.
      const heldAt = join(b.dir, "held-at")
      const writer = spawn(["hold", "--", "perl", "-MTime::HiRes=time", "-e", `open(my $h, '>', '${heldAt}') or die; printf $h "%.3f", time`])
      children.push(...late, remover, writer)
      const codes = await Promise.all(children.map((c) => c.exited))
      const errs = await Promise.all(children.map((c) => new Response(c.stderr).text()))
      expect(codes, errs.join("\n----\n")).toEqual([0, 0, 0, 0, 0, 0])
      const moveEnded = Date.now() / 1000
      const log = textLines(readFileSync(b.env.FAKE_LOG!, "utf8")).map((line) => line.split(" "))
      // The last such line: gone-lane was cloned once by the stand-in itself, before.
      const at = (what: string, name: string) => Number(log.findLast((l) => l[0] === what && l[2] === name)?.[4])
      const copyAt = Number(textLines(readFileSync(cpLog, "utf8"))[0]!.split(" ")[1])
      expect(at("out", "early")).toBeLessThanOrEqual(copyAt)
      // Those that came during the hold cloned or deleted after the switch, from the subvolume.
      const smokeOut = at("out", "scratch-subvolume-smoke")
      for (const name of ["late1", "late2", "gone-lane"]) expect(at("in", name)).toBeGreaterThan(smokeOut)
      expect(Number(readFileSync(heldAt, "utf8"))).toBeGreaterThan(smokeOut)
      expect(moveEnded).toBeGreaterThan(smokeOut)
      for (const name of ["late1", "late2"]) expect(b.records().find((r) => r.name === name)?.cloner).toBe("btrfs")
      expect(b.records().find((r) => r.name === "early")?.cloner).toBe("reflink")
      expect(existsSync(removable)).toBe(false)
      expect(errs[2]).toContain("subvolume: switch")
      converted(b)
    } finally {
      for (const c of children)
        try {
          process.kill(-c.pid, "SIGKILL")
        } catch {
          // ended
        }
    }
  }, 60_000)

  test("its wait for the turn is bounded: past it, it gives its place back and changes nothing", async () => {
    const b = bench("turn")
    const holder = Bun.spawn([SCRIPT, "hold", "--", "sleep", "6"], { cwd: b.dir, env: b.envFor(), stdout: "ignore", stderr: "ignore", detached: true })
    try {
      for (let i = 0; i < 200 && !(existsSync(join(b.state, "base")) && readdirSync(join(b.state, "base")).some((f) => f.endsWith(".in"))); i++) await Bun.sleep(25)
      const t0 = Date.now()
      const ran = b.wr(["subvolume", "--apply"], { WORKRIFT_SUBVOLUME_TURN_WAIT: "1" })
      expect(ran.code, said(ran)).toBe(1)
      expect(ran.err).toContain("no turn at the lock of")
      expect(ran.err).toContain("nothing changed")
      expect(Date.now() - t0).toBeLessThan(5_500)
      expect(b.layout()).toEqual({ base: "F", new: "-", back: "-", old: "-" })
      expect(b.btrfsCalls()).toEqual([])
    } finally {
      try {
        process.kill(-holder.pid, "SIGKILL")
      } catch {
        // ended
      }
    }
  }, 30_000)

  test("writers (move.qnt): a ref pushed into the base before the swap, one written into the old tree after it, one written on both sides, all reach the new base; the checked-out branch is never moved", () => {
    const b = bench("writers")
    const feat = b.refs(b.base).match(/(\w+) refs\/heads\/feat-a/)![1]!
    const g = (path: string, ...args: ReadonlyArray<string>) => `git -C '${path}' ${args.join(" ")}`
    const ran = b.wr(["subvolume", "--apply"], {
      FAKE_BEFORE_EXCHANGE: g(b.base, "update-ref", "refs/heads/pushed", b.head),
      // After the exchange the old tree is at the new path (renamed to .old next): a writer that resolved the base before.
      FAKE_AFTER_EXCHANGE: [
        g(b.paths.new, "update-ref", "refs/heads/late", b.head),
        g(b.paths.new, "update-ref", "refs/heads/both", b.head),
        g(b.base, "update-ref", "refs/heads/both", feat),
        g(b.paths.new, "update-ref", "refs/heads/main", feat),
      ].join(" && "),
    })
    expect(ran.code, said(ran)).toBe(0)
    const refs = b.refs(b.base)
    expect(refs).toContain(`${b.head} refs/heads/pushed`)
    expect(refs).toContain(`${b.head} refs/heads/late`)
    expect(refs).toContain(`${feat} refs/heads/both`)
    expect(refs).toContain(`${b.head} refs/subvolume-move/heads/both`)
    expect(refs).toContain(`${b.head} refs/heads/main`)
    expect(refs).toContain(`${feat} refs/subvolume-move/heads/main`)
    expect(ran.err).toContain("kept as refs/subvolume-move/heads/main")
  }, 30_000)

  test("the carry waits for a process still in the old tree; one that stays past the wait leaves the switch done but unfinished (never rolled back after the exchange), and a rerun once it left finishes it", async () => {
    const b = bench("stay")
    // Leaves after a second: the carry waits, then goes on.
    const stayer = String(91100)
    const ran1 = Bun.spawn([SCRIPT, "subvolume", "--apply"], {
      cwd: b.dir,
      env: b.envFor({ WORKRIFT_SUBVOLUME_WAIT: "20", FAKE_AFTER_EXCHANGE: `mkdir -p '${b.proc}/${stayer}' && ln -s '${b.paths.old}' '${b.proc}/${stayer}/cwd'` }),
      stdout: "pipe",
      stderr: "pipe",
    })
    for (let i = 0; i < 400 && !existsSync(join(b.proc, stayer)); i++) await Bun.sleep(25)
    await Bun.sleep(1500)
    expect(b.phase()).toBe("carry copy S")
    rmSync(join(b.proc, stayer), { recursive: true })
    expect(await ran1.exited, await new Response(ran1.stderr).text()).toBe(0)
    converted(b)

    const c = bench("stay2")
    const ran2 = c.wr(["subvolume", "--apply"], {
      WORKRIFT_SUBVOLUME_WAIT: "1",
      FAKE_AFTER_EXCHANGE: `mkdir -p '${c.proc}/91101' && ln -s '${c.paths.old}/src' '${c.proc}/91101/cwd'`,
    })
    expect(ran2.code, said(ran2)).toBe(1)
    expect(ran2.err).toContain("processes still work in")
    expect(ran2.err).toContain("not rolled back: ")
    expect(ran2.out).toContain("work refresh did not run (the switch is not finished)")
    expect(ran2.out).toContain(`${c.base} holds all that ${c.paths.old} holds`)
    expect(c.layout()).toEqual({ base: "S", new: "-", back: "-", old: "F" })
    whole(c)
    whole(c, c.paths.old)
    expect(c.phase()).toBe("carry copy S")
    // --drop-old refuses while the switch is unfinished; once the process left, a rerun finishes the switch.
    expect(c.wr(["subvolume", "--drop-old", "--apply"]).code).toBe(1)
    rmSync(join(c.proc, "91101"), { recursive: true })
    const ran3 = c.wr(["subvolume", "--apply"])
    expect(ran3.code, said(ran3)).toBe(0)
    converted(c)
  }, 60_000)

  // Found by the census (r3): `sv_refs` piped Git into sort, so a Git that failed read as a tree with no refs, and
  // the carry from it deleted every ref of the new base but its HEAD branch. Each read of the carry, failed once.
  test("a Git that fails once while the switch reads or moves refs never loses a ref: the run ends with workrift's reason, both trees whole, and the next run finishes", async () => {
    const cases = [
      { what: "the kept tree's refs, read by the carry", fail: "*/app.old for-each-ref*", says: "nothing carried" },
      { what: "the kept tree's HEAD, read by the carry", fail: "*/app.old symbolic-ref -q HEAD*", says: "nothing carried" },
      { what: "the base's refs, read before the copy", fail: "*/root/app for-each-ref*", says: "rolled back before the exchange" },
      { what: "a ref the carry moves into the base", fail: "*/root/app update-ref refs/heads/late *", says: "could not move refs/heads/late" },
    ]
    await pool(
      cases.map((c) => async () => {
        const b = bench("git-once")
        // Run right after the exchange, before the rename: the tree that was the base is still at .new then.
        const late = `t=$(git -C '${b.paths.new}' commit-tree 'HEAD^{tree}' -p HEAD -m late) && git -C '${b.paths.new}' update-ref refs/heads/late "$t"`
        const ran = await b.wrAsync(["subvolume", "--apply"], { FAKE_GIT_FAIL_ONCE: c.fail, FAKE_GIT_FAIL_ONCE_MARK: join(b.dir, "git-failed"), FAKE_AFTER_EXCHANGE: late })
        expect(existsSync(join(b.dir, "git-failed")), `${c.what}: the injected failure ran`).toBe(true)
        expect(ran.code, `${c.what}: ${said(ran)}`).toBe(1)
        expect(ran.err, c.what).toContain(c.says)
        expect(ran.err, c.what).not.toContain("and no message")
        expect(["F", "S"]).toContain(b.kind(b.base))
        whole(b)
        if (existsSync(b.paths.old)) whole(b, b.paths.old)
        const again = await b.wrAsync(["subvolume", "--apply"])
        expect(again.code, `${c.what}, again: ${said(again)}`).toBe(0)
        converted(b)
        // The ref written into the kept tree after the exchange reached the base, when there was an exchange.
        if (!c.says.startsWith("rolled back")) expect(b.refs(b.base), c.what).toContain("refs/heads/late")
      }),
    )
  }, 120_000)

  // Every bound of a switch that ends in a refusal (the copy's three tries and the hold's limit are on the copy path:
  // the tests above), each past its end in the history of the r2 failure: a forward, a --back cut at carry-wait,
  // then the --back that finishes it (the bounds of the line, the carry's wait) and the forward after (the proof's).
  test("past every bound, from a --back cut at carry-wait: a refusal of workrift's own, both trees whole, and the next run finishes", async () => {
    const cutBack = async (label: string) => {
      const b = bench(label)
      const fwd = b.wr(["subvolume", "--apply"])
      expect(fwd.code, said(fwd)).toBe(0)
      const cut = await b.wrAsync(["subvolume", "--back", "--apply"], { WORKRIFT_SUBVOLUME_DIE_AT: "carry-wait" })
      expect(cut.signal, said(cut)).toBe("SIGKILL")
      return b
    }
    const intact = (b: Bench, ran: Ran, says: string) => {
      expect(ran.code, said(ran)).toBe(1)
      expect(ran.err).toContain(says)
      expect(ran.err).not.toContain("and no message")
      expect(["F", "S"]).toContain(b.kind(b.base))
      whole(b)
      whole(b, b.paths.old)
    }
    const finishes = (b: Bench, argv: ReadonlyArray<string>, layout: ReturnType<Bench["layout"]>) => {
      const ran = b.wr(argv)
      expect(ran.code, said(ran)).toBe(0)
      expect(b.layout()).toEqual(layout)
      whole(b)
      whole(b, b.paths.old)
    }
    const back = ["subvolume", "--back", "--apply"]
    const folder = { base: "F", new: "-", back: "-", old: "S" }
    const children: Array<ReturnType<typeof Bun.spawn>> = []
    const spawn = (b: Bench, argv: ReadonlyArray<string>, extra: Env = {}) => {
      const child = Bun.spawn([SCRIPT, ...argv], { cwd: b.dir, env: b.envFor(extra), stdout: "ignore", stderr: "ignore", detached: true })
      children.push(child)
      return child
    }
    const until = async (what: () => boolean) => {
      for (let i = 0; i < 400 && !what(); i++) await Bun.sleep(25)
      expect(what()).toBe(true)
    }
    try {
      // The line's try: another subvolume run holds its place (paused at its carry-wait until a gate opens).
      const a = await cutBack("bound-move")
      const gate = join(a.dir, "gate")
      const reached = join(a.dir, "reached")
      const other = spawn(a, back, { WORKRIFT_SUBVOLUME_HOOK_AT: "carry-wait", WORKRIFT_SUBVOLUME_HOOK: `: >'${reached}'; i=0; until [ -e '${gate}' ] || [ $i -ge 400 ]; do sleep 0.05; i=$((i+1)); done` })
      // At its hook it holds its place (the cut run left its ticket files, so they alone prove nothing).
      await until(() => existsSync(reached))
      intact(a, a.wr(back), "another workrift subvolume runs for")
      writeFileSync(gate, "")
      expect(await other.exited).toBe(0)
      finishes(a, back, folder)

      // The turn at the base's lock: a holder past TURN_WAIT.
      const t = await cutBack("bound-turn")
      const held = join(t.dir, "held")
      const holder = spawn(t, ["hold", "--", "sh", "-c", `: >'${held}'; sleep 6`])
      await until(() => existsSync(held))
      intact(t, t.wr(back, { WORKRIFT_SUBVOLUME_TURN_WAIT: "1" }), "no turn at the lock of")
      process.kill(-holder.pid, "SIGKILL")
      await holder.exited
      finishes(t, back, folder)

      // The clone turn: a create in its clone past TURN_WAIT (the base, a folder, does not snapshot).
      const k = await cutBack("bound-clone")
      writeFileSync(join(k.holds, "slow"), "6\n")
      const create = spawn(k, ["create", "slow"])
      await until(() => existsSync(k.env.FAKE_LOG!) && readFileSync(k.env.FAKE_LOG!, "utf8").includes("in clone slow"))
      const turn = k.wr(back, { WORKRIFT_SUBVOLUME_TURN_WAIT: "1" })
      intact(k, turn, "within 1 s")
      expect(turn.err).toMatch(/no (clone turn of|turn at the lock of)/)
      process.kill(-create.pid, "SIGKILL")
      await create.exited
      finishes(k, back, folder)

      // The carry's wait: a process stays in the tree at .old past WAIT.
      const w = await cutBack("bound-wait")
      w.processAt(91500, w.paths.old, ["zsh"])
      intact(w, w.wr(back, { WORKRIFT_SUBVOLUME_WAIT: "1" }), "processes still work in")
      rmSync(join(w.proc, "91500"), { recursive: true })
      finishes(w, back, folder)

      // The proof's 5 s: the forward after, whose smoke workspace's folder comes back after its removal.
      const p = await cutBack("bound-smoke")
      finishes(p, back, folder)
      const smoke = join(p.root, ".work", "app", "scratch-subvolume-smoke")
      // Something makes the folder again and again (until told to stop, at most 20 s) from the removal on.
      const stop = join(p.dir, "stop-smoke")
      const proof = p.wr(["subvolume", "--apply"], {
        WORKRIFT_SUBVOLUME_HOOK_AT: "smoke-rm",
        WORKRIFT_SUBVOLUME_HOOK: `(i=0; until [ -e '${stop}' ] || [ $i -ge 400 ]; do mkdir -p '${smoke}'; sleep 0.05; i=$((i+1)); done) >/dev/null 2>&1 &`,
      })
      writeFileSync(stop, "")
      await Bun.sleep(300)
      intact(p, proof, "not rolled back")
      // Seen by the purge (`left it`) or, once the purge passed, by the 5 s wait (`still there 5 s`).
      expect(proof.err).toMatch(/work rm scratch-subvolume-smoke left it|still there 5 s after its removal/)
      rmSync(smoke, { recursive: true, force: true })
      finishes(p, ["subvolume", "--apply"], { base: "S", new: "-", back: "-", old: "F" })
    } finally {
      for (const c of children)
        try {
          process.kill(-c.pid, "SIGKILL")
        } catch {
          // ended
        }
    }
  }, 120_000)
})

describe("a live .git under the copy (Git processes outside the line: create-fetch G1-G5)", () => {
  const g = (path: string, ...args: ReadonlyArray<string>) => `git -C '${path}' ${args.join(" ")}`
  /** A whole repository: every object of every ref reachable (fsck of connectivity). */
  const connected = (b: Bench) => {
    const ran = Bun.spawnSync(["git", "-C", b.base, "fsck", "--connectivity-only", "--no-dangling"], { env: b.env, stdout: "pipe", stderr: "pipe" })
    expect(ran.exitCode, ran.stderr.toString()).toBe(0)
  }

  test("G1/G2: a fetch that lands while the copy walks the base, its ref copied after its objects (a torn copy), is seen and the .git copied again; the new base holds the ref and its objects", () => {
    const b = bench("torn")
    const ran = b.wr(["subvolume", "--apply"], {
      FAKE_CP_ONCE: join(b.dir, "cp-once"),
      FAKE_CP_AFTER: `t=$(${g(b.base, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "torn")}) && ${g(b.base, "update-ref", "refs/heads/torn", '"$t"')}`,
      FAKE_CP_REFS_LAST: "1",
    })
    expect(ran.code, said(ran)).toBe(0)
    expect(b.steps()).toContain("copy-git")
    expect(b.refs(b.base)).toContain("refs/heads/torn")
    connected(b)
    converted(b)
  }, 30_000)

  test("G2: a copy with a ref tip its store lacks is never switched to: after three copies of the .git it rolls back, the base untouched", () => {
    const b = bench("tip-missing")
    writeFileSync(join(b.base, ".git/refs/heads/broken"), `${"0123456789abcdef".repeat(2)}01234567\n`)
    const ran = b.wr(["subvolume", "--apply"])
    expect(ran.code, said(ran)).toBe(1)
    expect(ran.err).toContain("after 3 copies of its .git")
    expect(ran.err).toContain("rolled back")
    expect(b.layout()).toEqual({ base: "F", new: "-", back: "-", old: "-" })
    expect(b.steps().filter((s) => s === "copy-git")).toHaveLength(2)
  }, 30_000)

  test("G1: a repack that lands while the copy walks the base (no ref moves) is seen by the store's listing and the .git copied again", () => {
    const b = bench("repack")
    const ran = b.wr(["subvolume", "--apply"], { FAKE_CP_ONCE: join(b.dir, "cp-once"), FAKE_CP_AFTER: `${g(b.base, "repack", "-a", "-d", "-q")}` })
    expect(ran.code, said(ran)).toBe(0)
    expect(b.steps()).toContain("copy-git")
    connected(b)
    converted(b)
  }, 30_000)

  test("G3: a Git lock or temporary pack the copy carried (gone from the base since) sends the .git to be copied again; none is left in the new base", () => {
    for (const carried of [".git/refs/heads/main.lock", ".git/packed-refs.lock", ".git/objects/pack/tmp_pack_q1"]) {
      const b = bench("carried")
      const ran = b.wr(["subvolume", "--apply"], { FAKE_CP_ONCE: join(b.dir, "cp-once"), FAKE_CP_AFTER: `: >"$2/${carried}"` })
      expect(ran.code, `${carried}: ${said(ran)}`).toBe(0)
      expect(b.steps(), carried).toContain("copy-git")
      expect(existsSync(join(b.base, carried)), carried).toBe(false)
      converted(b)
    }
  }, 60_000)

  test("G4: a ref moved in the old tree after the exchange to a commit only the old tree has arrives with its objects; every write of the command's git calls runs with auto-maintenance off", () => {
    const b = bench("only-old")
    const gitLog = join(b.dir, "git-calls")
    const ran = b.wr(["subvolume", "--apply"], {
      FAKE_GIT_LOG: gitLog,
      // The writer is not the command: its calls stay out of the log.
      FAKE_AFTER_EXCHANGE: `export FAKE_GIT_LOG=; t=$(${g(b.paths.new, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "only-old")}) && ${g(b.paths.new, "update-ref", "refs/heads/only-old", '"$t"')}`,
    })
    expect(ran.code, said(ran)).toBe(0)
    expect(b.refs(b.base)).toContain("refs/heads/only-old")
    connected(b)
    const writes = textLines(readFileSync(gitLog, "utf8")).filter((line) => / (fetch|update-ref|update-index|repack|gc|commit)( |$)/.test(line))
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.filter((line) => !(line.includes("gc.auto=0") && line.includes("maintenance.auto=false"))).filter((line) => !line.includes(" checkout "))).toEqual([])
  }, 30_000)

  test("G5: a create whose copy carried a Git lock or gc file from the base deletes it in the new workspace only, naming it; an index.lock fails the create with the retry as the fix", () => {
    const b = bench("create-locks")
    const carried = [".git/refs/remotes/origin/zz.lock", ".git/gc.pid", ".git/objects/maintenance.lock", ".git/objects/pack/tmp_pack_z"]
    for (const each of carried) writeFileSync(join(b.base, each), "")
    const made = b.wr(["create", "with-locks"])
    expect(made.code, said(made)).toBe(0)
    const workspace = b.records().find((r) => r.name === "with-locks")!.path
    for (const each of carried) {
      expect(made.err).toContain(`removed ${join(workspace, each)} from the new workspace`)
      expect(existsSync(join(workspace, each)), each).toBe(false)
      expect(existsSync(join(b.base, each)), each).toBe(true)
    }
    for (const each of carried) rmSync(join(b.base, each))
    writeFileSync(join(b.base, ".git/index.lock"), "")
    const failed = b.wr(["create", "with-index-lock"])
    expect(failed.code, said(failed)).toBe(1)
    expect(failed.err).toContain("a Git process held it in the base the instant the workspace was copied; run the create again")
    expect(existsSync(join(b.base, ".git/index.lock"))).toBe(true)
  }, 60_000)
})

/** Faults before the exchange: each rolls back to the folder base, whole, deleting only its copy (never the base). */
const FAULTS: ReadonlyArray<{ readonly what: string; readonly env: Env; readonly says: string; readonly copy: boolean }> = [
  { what: "subvolume create fails", env: { FAKE_BTRFS_FAIL: "subvolume create" }, says: "btrfs subvolume create", copy: false },
  { what: "disk full in the copy", env: { FAKE_CP: "enospc" }, says: "full disk or metadata space", copy: true },
  { what: "the exchange fails", env: { FAKE_EXCHANGE_FAIL: "1" }, says: "the exchange failed", copy: true },
  { what: "the hold takes too long", env: { WORKRIFT_SUBVOLUME_LIMIT: "-1" }, says: "took more than -1 s", copy: true },
]

describe("workrift subvolume: failure and kill at every step", () => {
  test("a failure before the exchange rolls back: the folder base at its path, never moved, whole, the copy deleted and said so, no phase; a rerun without the fault converts", () => {
    for (const fault of FAULTS) {
      const b = bench("fault")
      const ino = lstatSync(b.base).ino
      const ran = b.wr(["subvolume", "--apply"], fault.env)
      expect({ what: fault.what, code: ran.code, rolled: ran.err.includes("rolled back before the exchange"), says: ran.err.includes(fault.says) }, said(ran)).toEqual({
        what: fault.what,
        code: 1,
        rolled: true,
        says: true,
      })
      expect(ran.err, fault.what).toContain(fault.copy ? `deleted only its copy that was never the base: ${b.paths.new}` : "deleted nothing")
      expect(ran.err).not.toContain("nothing deleted that it held")
      expect(b.layout(), fault.what).toEqual({ base: "F", new: "-", back: "-", old: "-" })
      expect(lstatSync(b.base).ino).toBe(ino)
      whole(b)
      expect(b.phase(), fault.what).toBe("")
      const again = b.wr(["subvolume", "--apply"])
      expect(again.code, said(again)).toBe(0)
      converted(b)
    }
  }, 180_000)

  test("a failure after the exchange (the smoke workspace is no snapshot) never rolls back: the new tree stays the base, the old one kept under its record, what the base lacks said, exit 1; --back returns", () => {
    const b = bench("fault-after")
    const ran = b.wr(["subvolume", "--apply"], { FAKE_SMOKE_CLONER: "reflink" })
    expect(ran.code, said(ran)).toBe(1)
    expect(ran.err).toContain("not a btrfs snapshot; not rolled back: ")
    expect(ran.out).toContain("deleted nothing")
    expect(ran.out).toContain(`${b.base} holds all that ${b.paths.old} holds`)
    expect(b.layout()).toEqual({ base: "S", new: "-", back: "-", old: "F" })
    whole(b)
    whole(b, b.paths.old)
    expect(b.phase()).toMatch(/^switched /)
    expect(readFileSync(join(b.state, "subvolume/kept"), "utf8")).toBe(`${b.paths.old}\nfolder ${lstatSync(b.paths.old).ino}\n`)
    const back = b.wr(["subvolume", "--back", "--apply"])
    expect(back.code, said(back)).toBe(0)
    expect(b.layout()).toEqual({ base: "F", new: "-", back: "-", old: "S" })
    whole(b)
  }, 60_000)

  /**
   * The property: for every step the command names (its state log of a clean run, and of a run that rolls back), a
   * kill -9 there leaves the old folder or the new subvolume whole at the base's path, never neither, and nothing of
   * either tree lost; the next --apply ends converted (or, after a cut rollback, rolled back, and the one after that
   * converted). Kills in a copy's middle (cp killing its caller) too.
   */
  test("property: a kill -9 at every step, then reruns, ends in one of two states: the folder base untouched, or the subvolume base complete", async () => {
    const clean = bench("steps")
    expect(clean.wr(["subvolume", "--apply"]).code).toBe(0)
    const forward = clean.steps()
    // A rollback is only ever before the exchange: the copy failing (a full disk).
    const failing = bench("steps-rb")
    expect(failing.wr(["subvolume", "--apply"], { FAKE_CP: "enospc" }).code).toBe(1)
    const rollback = failing.steps().filter((s) => !forward.includes(s))
    expect(rollback).toEqual(["rollback", "drop-copy", "rolled-back"])
    const invariant = (b: Bench, label: string) => {
      const l = b.layout()
      expect(["F", "S"], label).toContain(l.base)
      whole(b)
      // The folder is never lost: it is the base, or it is parked at .new or .old.
      expect(l.base === "F" || l.new === "F" || l.old === "F", label).toBe(true)
    }
    let kills = 0
    await pool(forward.map((step) => async () => {
      const b = bench(`kill-${step}`)
      const ran = await b.wrAsync(["subvolume", "--apply"], { WORKRIFT_SUBVOLUME_DIE_AT: step })
      expect(ran.signal, `${step}: ${said(ran)}`).toBe("SIGKILL")
      kills++
      invariant(b, step)
      const again = await b.wrAsync(["subvolume", "--apply"])
      expect(again.code, `${step}: ${said(again)}`).toBe(0)
      converted(b)
    }))
    await pool(rollback.map((step) => async () => {
      const b = bench(`kill-rb-${step}`)
      const ran = await b.wrAsync(["subvolume", "--apply"], { FAKE_CP: "enospc", WORKRIFT_SUBVOLUME_DIE_AT: step })
      expect(ran.signal, `${step}: ${said(ran)}`).toBe("SIGKILL")
      kills++
      invariant(b, `rollback ${step}`)
      // The fault still there: the rerun finishes the rollback; then, without it, a run converts.
      const finish = await b.wrAsync(["subvolume", "--apply"], { FAKE_CP: "enospc" })
      if (b.phase() === "") {
        expect(b.layout(), `${step}: ${said(finish)}`).toEqual({ base: "F", new: "-", back: "-", old: "-" })
        whole(b)
      }
      const again = await b.wrAsync(["subvolume", "--apply"])
      expect(again.code, `${step}: ${said(again)}`).toBe(0)
      converted(b)
    }))
    // Mid-copy: cp kills its caller with the copy all written but never verified.
    const mid = bench("kill-mid-copy")
    const cut = mid.wr(["subvolume", "--apply"], { FAKE_CP: "die" })
    expect(cut.signal).toBe("SIGKILL")
    invariant(mid, "mid-copy")
    expect(mid.layout().new).toBe("S")
    const again = mid.wr(["subvolume", "--apply"])
    expect(again.code, said(again)).toBe(0)
    expect(again.err).toContain(`the cut switch had not swapped: deleted only its copy that was never the base: ${mid.paths.new}; the switch starts again`)
    converted(mid)
    // Two kills in a row, at seeded pairs of steps, then a clean run.
    let seed = 7
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    const pairs = Array.from({ length: 8 }, () => [forward[Math.floor(next() * forward.length)]!, [...forward, "drop-copy"][Math.floor(next() * (forward.length + 1))]!] as const)
    await pool(
      pairs.map(([s1, s2], i) => async () => {
        const b = bench(`kill2-${i}`)
        await b.wrAsync(["subvolume", "--apply"], { WORKRIFT_SUBVOLUME_DIE_AT: s1 })
        invariant(b, `${s1} then`)
        await b.wrAsync(["subvolume", "--apply"], { WORKRIFT_SUBVOLUME_DIE_AT: s2 })
        invariant(b, `${s1} then ${s2}`)
        const last = await b.wrAsync(["subvolume", "--apply"])
        expect(last.code, `${s1} ${s2}: ${said(last)}`).toBe(0)
        converted(b)
      }),
    )
    expect(kills).toBeGreaterThanOrEqual(forward.length + rollback.length)
  }, 400_000)
})

/** Every step name of the command (sv_step), for a hook at each. */
const SEQ_STEPS = ["carry", "carry-in", "carry-wait", "copy", "copy-git", "copy-make", "drop", "drop-copy", "dropped", "prove", "refresh", "rollback", "rolled-back", "smoke", "smoke-rm", "swap", "swapped", "switched", "verify", "work-refresh"]

describe("workrift subvolume --back and --drop-old", () => {
  /** forward, back (exchange), forward (exchange), drop the folder, back (copy into a folder), drop the subvolume. */
  /** A sequence that fails keeps the full output of its every command outside the scratch (removed after the run). */
  const sequence = async (b: Bench, die: { readonly at: number; readonly step: string } | undefined) => {
    try {
      await sequenceOf(b, die)
    } catch (error) {
      const kept = join(tmpdir(), "workrift-subvolume-failures")
      mkdirSync(kept, { recursive: true })
      const file = join(kept, `${b.dir.split("/").at(-1)}-${Date.now()}.log`)
      writeFileSync(file, existsSync(`${b.dir}.commands.log`) ? readFileSync(`${b.dir}.commands.log`) : "")
      throw new Error(`${String(error)}\nthe sequence's every command, in full: ${file}`)
    }
  }
  const sequenceOf = async (b: Bench, die: { readonly at: number; readonly step: string } | undefined) => {
    const argvs: ReadonlyArray<ReadonlyArray<string>> = [
      ["subvolume", "--apply"],
      ["subvolume", "--back", "--apply"],
      ["subvolume", "--apply"],
      ["subvolume", "--drop-old", "--apply"],
      ["subvolume", "--back", "--apply"],
      ["subvolume", "--drop-old", "--apply"],
    ]
    const folderIno = lstatSync(b.base).ino
    const expected = [
      { base: "S", new: "-", back: "-", old: "F" },
      { base: "F", new: "-", back: "-", old: "S" },
      { base: "S", new: "-", back: "-", old: "F" },
      { base: "S", new: "-", back: "-", old: "-" },
      { base: "F", new: "-", back: "-", old: "S" },
      { base: "F", new: "-", back: "-", old: "-" },
    ]
    // SEQ_JITTER_SEED=<n>: a seeded delay (0-1.5 s) at every step boundary of every run, so a schedule replays.
    // SEQ_EXTKILL=1: the cut is a kill -9 of the command's own pid alone (its children run on) at a seeded instant
    // of its run, instead of at a step.
    const seed = process.env.SEQ_JITTER_SEED
    const rand = seed === undefined ? undefined : prng(Number(seed) * 7919 + b.dir.length * 31 + (die?.at ?? 0) * 131 + [...(die?.step ?? "")].reduce((a, c) => a + c.charCodeAt(0), 0))
    const jitter = (): Env =>
      rand === undefined
        ? {}
        : {
            WORKRIFT_SUBVOLUME_HOOK_AT: SEQ_STEPS.join(" "),
            WORKRIFT_SUBVOLUME_HOOK: `for kv in ${SEQ_STEPS.map((s) => `${s}=${(rand() * 1.5).toFixed(2)}`).join(" ")}; do case "$kv" in "$1="*) sleep "\${kv#*=}" ;; esac; done`,
          }
    for (const [i, argv] of argvs.entries()) {
      if (die?.at === i) {
        if (process.env.SEQ_EXTKILL && rand !== undefined) {
          const child = Bun.spawn([SCRIPT, ...argv], { cwd: b.dir, env: b.envFor(jitter()), stdout: "pipe", stderr: "pipe" })
          const after = Math.floor(rand() * 8000)
          const timer = setTimeout(() => {
            try {
              process.kill(child.pid, "SIGKILL")
            } catch {
              // ended first
            }
          }, after)
          await child.exited
          clearTimeout(timer)
          await Bun.sleep(200)
        } else {
          const cut = await b.wrAsync(argv, { WORKRIFT_SUBVOLUME_DIE_AT: die.step, ...jitter() })
          expect(cut.signal, `${argv.join(" ")} cut at ${die.step}: ${said(cut)}`).toBe("SIGKILL")
        }
        expect(["F", "S"]).toContain(b.kind(b.base))
        whole(b)
      }
      const ran = await b.wrAsync(argv, jitter())
      expect(ran.code, `${argv.join(" ")} (cut at ${JSON.stringify(die)}): ${said(ran)}`).toBe(0)
      expect(b.layout(), `${argv.join(" ")}`).toEqual(expected[i])
      whole(b)
      if (i === 1) expect(lstatSync(b.base).ino).toBe(folderIno)
      if (i === 3) expect(existsSync(b.paths.old)).toBe(false)
    }
  }

  test("forward, back, forward, drop, back with no kept tree, drop: each a whole base, the kept tree always the other one, back to the very folder it was", async () => {
    const b = bench("seq")
    await sequence(b, undefined)
    const r = b.records()
    expect(r.filter((x) => x.name === "scratch-subvolume-smoke")).toEqual([])
  }, 120_000)

  test("property: a kill -9 at every step of every switch and drop after the first (the first is the property above), then the same command again, ends where the sequence would", async () => {
    const probe = bench("seq-steps")
    const perCommand: Array<ReadonlyArray<string>> = []
    for (const argv of [
      ["subvolume", "--apply"],
      ["subvolume", "--back", "--apply"],
      ["subvolume", "--apply"],
      ["subvolume", "--drop-old", "--apply"],
      ["subvolume", "--back", "--apply"],
      ["subvolume", "--drop-old", "--apply"],
    ]) {
      rmSync(join(probe.state, "subvolume/log"), { force: true })
      expect(probe.wr(argv).code).toBe(0)
      perCommand.push(probe.steps())
    }
    expect(perCommand[1]).toEqual(expect.arrayContaining(["carry-in", "swap", "carry", "switched"]))
    expect(perCommand[3]).toEqual(["drop", "dropped"])
    const cuts = perCommand.flatMap((steps, at) => (at === 0 ? [] : steps.map((step) => ({ at, step }))))
    // SEQ_ONLY=<at>:<step>,... runs only those cuts (a loop that hunts one).
    const only = process.env.SEQ_ONLY?.split(",")
    // SEQ_REPEAT=<n> runs each chosen cut n times.
    const chosen = cuts.filter((die) => !only || only.includes(`${die.at}:${die.step}`))
    const repeat = Number(process.env.SEQ_REPEAT ?? 1)
    await pool(Array.from({ length: repeat }, () => chosen).flat().map((die, n) => () => sequence(bench(`seq-${die.at}-${die.step}-${n}`), die)))
    expect(cuts.length).toBeGreaterThan(25)
  }, 900_000 * Number(process.env.SEQ_REPEAT ?? 1))

  test("--drop-old deletes only the tree the last switch kept, by its identity; a dry run says its path and kind; anything else at that path is refused", () => {
    const b = bench("drop")
    expect(b.wr(["subvolume", "--apply"]).code).toBe(0)
    const dry = b.wr(["subvolume", "--drop-old"])
    expect(dry.code, said(dry)).toBe(0)
    expect(dry.out).toContain(`drop ${b.paths.old}, a plain folder (folder ${lstatSync(b.paths.old).ino})`)
    expect(dry.out).toContain(`rm -rf --one-file-system -- ${b.paths.old}`)
    expect(dry.out).toContain("dry run: nothing changed")
    expect(existsSync(b.paths.old)).toBe(true)
    // Someone put another folder there: not the tree recorded.
    renameSync(b.paths.old, join(b.dir, "parked"))
    mkdirSync(b.paths.old)
    const other = b.wr(["subvolume", "--drop-old", "--apply"])
    expect(other.code).toBe(1)
    expect(other.err).toContain("not the folder")
    expect(existsSync(b.paths.old)).toBe(true)
    rmSync(b.paths.old, { recursive: true })
    renameSync(join(b.dir, "parked"), b.paths.old)
    // A process in it: refused.
    b.processAt(91200, b.paths.old, ["zsh"])
    const busy = b.wr(["subvolume", "--drop-old", "--apply"])
    expect(busy.code).toBe(1)
    expect(busy.err).toContain("91200 zsh")
    rmSync(join(b.proc, "91200"), { recursive: true })
    // No record of what was kept: refused.
    const kept = readFileSync(join(b.state, "subvolume/kept"), "utf8")
    rmSync(join(b.state, "subvolume/kept"))
    expect(b.wr(["subvolume", "--drop-old", "--apply"]).code).toBe(1)
    writeFileSync(join(b.state, "subvolume/kept"), kept)
    const ok = b.wr(["subvolume", "--drop-old", "--apply"])
    expect(ok.code, said(ok)).toBe(0)
    expect(existsSync(b.paths.old)).toBe(false)
    whole(b)
    expect(b.kind(b.base)).toBe("S")
    const none = b.wr(["subvolume", "--drop-old", "--apply"])
    expect(none.code).toBe(0)
    expect(none.out).toContain("nothing to drop")
  }, 60_000)
})

describe("init and check on btrfs", () => {
  test("init makes a new base on btrfs a subvolume before it clones into it; check warns about a folder base on btrfs and not about a subvolume one", () => {
    const b = bench("init")
    const target = join(b.root, "fresh")
    const origin = join(b.dir, "origin.git")
    const ran = Bun.spawnSync([SCRIPT, "init", origin, target], { cwd: b.dir, env: { ...b.env, WORKRIFT_WARM: "0" }, stdout: "pipe", stderr: "pipe" })
    expect(ran.exitCode, ran.stderr.toString()).toBe(0)
    expect(b.btrfsCalls()).toEqual([`subvolume create ${target}`])
    expect(b.kind(target)).toBe("S")
    expect(existsSync(join(target, "README.md"))).toBe(true)

    const folder = b.wr(["check"])
    expect(folder.code, said(folder)).toBe(0)
    expect(folder.err).toContain(`${b.base} is a plain folder on btrfs, not a subvolume`)
    writeFileSync(b.env.FAKE_SUBVOLS!, `${lstatSync(b.base).ino}\n`, { flag: "a" })
    const sub = b.wr(["check"])
    expect(sub.code, said(sub)).toBe(0)
    expect(sub.err).not.toContain("not a subvolume")
  }, 30_000)
})

// ---- round 2: the exchange is the commit point (M1), dry runs write nothing, the cp of a run cut short.

/** The verifier's probes VB1 and VB1b (workrift-subvolume r1), verbatim but for where they note what they saw. */
describe("VB probes", () => {
  const notes: Record<string, unknown> = {}
  const note = (name: string, value: unknown) => {
    notes[name] = value
  }
  const gq = (path: string, ...args: ReadonlyArray<string>) => `git -C '${path}' ${args.join(" ")}`
  const refAt = (b: Bench, path: string, ref: string, oid: string) => ({
    path,
    ref: Bun.spawnSync(["git", "-C", path, "rev-parse", "-q", "--verify", ref], { env: b.env }).stdout.toString().trim(),
    object: Bun.spawnSync(["git", "-C", path, "cat-file", "-e", oid], { env: b.env }).exitCode === 0,
  })
  const where = (b: Bench, ref: string, oid: string) =>
    [b.base, b.paths.new, b.paths.old, b.paths.back].filter((p) => existsSync(p)).map((p) => refAt(b, p, ref, oid))

  test("VB1 a ref written into the base after the exchange, then a rollback (prove fails): the ref survives somewhere", () => {
    const b = bench("vb1")
    const oidFile = join(b.dir, "after-swap-oid")
    const ran = b.wr(["subvolume", "--apply"], {
      FAKE_SMOKE_CLONER: "reflink",
      FAKE_AFTER_EXCHANGE: `t=$(${gq(b.base, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "after-swap")}) && ${gq(b.base, "update-ref", "refs/heads/after-swap", '"$t"')} && echo "$t" >'${oidFile}'`,
    })
    const oid = readFileSync(oidFile, "utf8").trim()
    const found = where(b, "refs/heads/after-swap", oid)
    note("vb1", { code: ran.code, err: ran.err, layout: b.layout(), oid, found })
    expect(ran.code).toBe(1)
    expect(ran.err).toContain("rolled back")
    expect(found.some((w) => w.ref === oid && w.object), JSON.stringify(found)).toBe(true)
    // Round 2: the claim is from what happened, and the ref is in the base at its path.
    expect(`${ran.out}${ran.err}`).not.toContain("nothing deleted that it held")
    expect(found[0]).toEqual({ path: b.base, ref: oid, object: true })
  }, 30_000)

  test("VB1b the same with the carry-wait timeout as the trigger (a process lingers in the old tree)", () => {
    const b = bench("vb1b")
    const oidFile = join(b.dir, "after-swap-oid")
    const ran = b.wr(["subvolume", "--apply"], {
      WORKRIFT_SUBVOLUME_WAIT: "1",
      FAKE_AFTER_EXCHANGE: `mkdir -p '${b.proc}/91301' && ln -s '${b.paths.old}/src' '${b.proc}/91301/cwd' && t=$(${gq(b.base, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "after-swap")}) && ${gq(b.base, "update-ref", "refs/heads/after-swap", '"$t"')} && echo "$t" >'${oidFile}'`,
    })
    const oid = readFileSync(oidFile, "utf8").trim()
    const found = where(b, "refs/heads/after-swap", oid)
    note("vb1b", { code: ran.code, err: ran.err, layout: b.layout(), oid, found })
    expect(ran.code).toBe(1)
    expect(ran.err).toContain("rolled back")
    expect(found.some((w) => w.ref === oid && w.object), JSON.stringify(found)).toBe(true)
    expect(`${ran.out}${ran.err}`).not.toContain("nothing deleted that it held")
    expect(found[0]).toEqual({ path: b.base, ref: oid, object: true })
  }, 30_000)
})

/** Every entry under `dir` with its kind, size, inode and time: equal before and after when nothing was written. */
const treeHash = (dir: string, skip: ReadonlyArray<string>) =>
  Bun.hash(
    filesUnder(dir)
      .filter((f) => !skip.some((s) => f === s || f.startsWith(`${s}/`)))
      .map((f) => {
        const st = lstatSync(join(dir, f))
        return `${f} ${st.mode} ${st.size} ${st.ino} ${st.mtimeMs} ${st.ctimeMs}`
      })
      .join("\n"),
  ).toString(16)

describe("workrift subvolume: a dry run writes nothing", () => {
  test("property: every mode without --apply, in every state a base can be in, leaves the bench's tree hash as it was and calls no btrfs", async () => {
    const modes: ReadonlyArray<ReadonlyArray<string>> = [[], ["--check"], ["--back"], ["--back", "--check"], ["--drop-old"], ["--beside-other-removals"], ["--back", "--beside-other-removals"]]
    /** The states: each arranges a fresh bench. */
    const states: ReadonlyArray<{ readonly what: string; readonly arrange: (b: Bench) => Promise<void> }> = [
      { what: "a folder base, no state folder", arrange: async () => {} },
      { what: "converted", arrange: async (b) => void expect(b.wr(["subvolume", "--apply"]).code).toBe(0) },
      {
        what: "converted, then the old dropped",
        arrange: async (b) => {
          expect(b.wr(["subvolume", "--apply"]).code).toBe(0)
          expect(b.wr(["subvolume", "--drop-old", "--apply"]).code).toBe(0)
        },
      },
      {
        what: "converted, the kept tree moved away by hand (VB3)",
        arrange: async (b) => {
          expect(b.wr(["subvolume", "--apply"]).code).toBe(0)
          renameSync(b.paths.old, join(b.dir, "parked-old"))
        },
      },
      {
        what: "unfinished: a process stayed in the old tree past the wait",
        arrange: async (b) => {
          const ran = b.wr(["subvolume", "--apply"], { WORKRIFT_SUBVOLUME_WAIT: "1", FAKE_AFTER_EXCHANGE: `mkdir -p '${b.proc}/91401' && ln -s '${b.paths.old}' '${b.proc}/91401/cwd'` })
          expect(ran.code, said(ran)).toBe(1)
        },
      },
      {
        what: "cut by a kill -9 in the copy",
        arrange: async (b) => void expect((await b.wrAsync(["subvolume", "--apply"], { WORKRIFT_SUBVOLUME_DIE_AT: "copy" })).signal).toBe("SIGKILL"),
      },
    ]
    const cases = states.flatMap((state) => modes.map((mode) => ({ state, mode })))
    await pool(
      states.map((state) => async () => {
        const b = bench("dry")
        // The btrfs calls that write (inspect-internal only reads).
        const writes = () => b.btrfsCalls().filter((c) => c.startsWith("subvolume ")).length
        await state.arrange(b)
        b.records()
        for (const { mode } of cases.filter((c) => c.state === state)) {
          const before = { tree: treeHash(b.dir, ["work-calls", "btrfs-calls", "proc"]), btrfs: writes() }
          const ran = await b.wrAsync(["subvolume", ...mode])
          const after = { tree: treeHash(b.dir, ["work-calls", "btrfs-calls", "proc"]), btrfs: writes() }
          expect({ state: state.what, mode, ...after }, said(ran)).toEqual({ state: state.what, mode, ...before })
          expect(`${ran.out}${ran.err}`).not.toContain("nothing deleted that it held")
        }
      }),
    )
    expect(cases.length).toBe(42)
  }, 600_000)

  test("a base directly under / is refused before anything is read or made: its move folder would be /.subvolume-move", () => {
    const b = bench("root-base")
    const ran = b.wr(["subvolume", "--apply"], { WORKRIFT_SOURCE: "/Users" })
    expect(ran.code, said(ran)).toBe(1)
    expect(ran.err).toContain("/Users: its move folder would be /.subvolume-move, not a folder beside it under a parent of its own (a base directly under / is refused); nothing changed")
    expect(existsSync("/.subvolume-move")).toBe(false)
    expect(existsSync("/.work/Users")).toBe(false)
    expect(b.btrfsCalls()).toEqual([])
  })
})

describe("workrift subvolume: the cp of a run cut short", () => {
  test("the shell alone killed mid-copy (its cp runs on): the rerun waits for that cp, then drops the copy and converts; no stray copy is left", async () => {
    const b = bench("orphan")
    const cpLog = join(b.dir, "cp-log")
    const move = Bun.spawn([SCRIPT, "subvolume", "--apply"], { cwd: b.dir, env: b.envFor({ FAKE_CP_DELAY: "3", FAKE_CP_LOG: cpLog }), stdout: "ignore", stderr: "ignore" })
    for (let i = 0; i < 400 && !existsSync(cpLog); i++) await Bun.sleep(25)
    const copier = join(b.state, "subvolume/copier")
    expect(existsSync(copier)).toBe(true)
    const pid = Number(readFileSync(copier, "utf8").split("\n")[0])
    process.kill(move.pid, "SIGKILL")
    await move.exited
    // The cp outlives the shell.
    expect(() => process.kill(pid, 0)).not.toThrow()
    const t0 = Date.now()
    const rerun = await b.wrAsync(["subvolume", "--apply"])
    expect(rerun.code, said(rerun)).toBe(0)
    expect(rerun.err).toContain(`the cp of a run cut short (pid ${pid}) has ended`)
    expect(rerun.err).toContain(`the cut switch had not swapped: deleted only its copy that was never the base: ${b.paths.new}`)
    expect(Date.now() - t0).toBeGreaterThan(500)
    expect(() => process.kill(pid, 0)).toThrow()
    converted(b)
    await Bun.sleep(500)
    expect(readdirSync(b.move).sort()).toEqual(["app.old"])
    expect(existsSync(copier)).toBe(false)
  }, 60_000)

  test("a cp of a run cut short that outlives the wait is named, and nothing is touched", async () => {
    const b = bench("orphan-wait")
    const cpLog = join(b.dir, "cp-log")
    const move = Bun.spawn([SCRIPT, "subvolume", "--apply"], { cwd: b.dir, env: b.envFor({ FAKE_CP_DELAY: "6", FAKE_CP_LOG: cpLog }), stdout: "ignore", stderr: "ignore" })
    for (let i = 0; i < 400 && !existsSync(cpLog); i++) await Bun.sleep(25)
    const pid = Number(readFileSync(join(b.state, "subvolume/copier"), "utf8").split("\n")[0])
    process.kill(move.pid, "SIGKILL")
    await move.exited
    const rerun = await b.wrAsync(["subvolume", "--apply"], { WORKRIFT_SUBVOLUME_WAIT: "1" })
    expect(rerun.code, said(rerun)).toBe(1)
    expect(rerun.err).toContain(`the cp of a run cut short (pid ${pid}) still writes into the copy after 1 s`)
    expect(b.kind(b.paths.new)).toBe("S")
    whole(b)
    for (let i = 0; i < 400; i++) {
      try {
        process.kill(pid, 0)
      } catch {
        break
      }
      await Bun.sleep(25)
    }
    const last = await b.wrAsync(["subvolume", "--apply"])
    expect(last.code, said(last)).toBe(0)
    converted(b)
  }, 60_000)
})

// ---- the model: histories of switches, faults, kills and writers, against four invariants.

type Klass = "ref" | "index" | "config" | "file" | "oldref" | "work" | "stay"
const KLASSES: ReadonlyArray<Klass> = ["ref", "index", "config", "file", "oldref", "work"]
type Cmd = "fwd" | "back" | "drop" | "dry"
const CMD_ARGV: Record<Exclude<Cmd, "dry">, ReadonlyArray<string>> = {
  fwd: ["subvolume", "--apply"],
  back: ["subvolume", "--back", "--apply"],
  drop: ["subvolume", "--drop-old", "--apply"],
}
const MODEL_FAULTS: Record<string, Env> = {
  none: {},
  enospc: { FAKE_CP: "enospc" },
  exchange: { FAKE_EXCHANGE_FAIL: "1" },
  smoke: { FAKE_SMOKE_CLONER: "reflink" },
  slow: { WORKRIFT_SUBVOLUME_LIMIT: "-1" },
  stay: { WORKRIFT_SUBVOLUME_WAIT: "1" },
}
interface Move {
  readonly cmd: Cmd
  readonly fault: keyof typeof MODEL_FAULTS
  readonly kill?: string
  readonly writers: ReadonlyArray<{ readonly klass: Klass; readonly step: string }>
}
interface Write {
  readonly klass: Klass
  readonly mark: string
  readonly value: string
  said: boolean
  dropped: boolean
}

/**
 * The hook workrift runs at every step (WORKRIFT_SUBVOLUME_HOOK): it notes the inode at the base's path and whether a
 * whole base is there, then runs the writers the plan names for this step, each with a mark of its own.
 */
const HOOK = (b: Bench) =>
  [
    "#!/bin/sh",
    "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE",
    `D='${b.dir}' B='${b.base}' O='${b.paths.old}' WORKBIN='${join(b.bin, "work")}' P='${b.proc}'`,
    "ino() { perl -e '@s = lstat($ARGV[0]) or exit 1; print $s[1]' \"$1\"; }",
    'ok=0; [ -f "$B/README.md" ] && git -C "$B" rev-parse -q --verify refs/heads/main >/dev/null && ok=1',
    'printf "obs %s %s %s\\n" "$1" "$(ino "$B")" "$ok" >>"$D/model-log"',
    '[ -f "$D/model-plan" ] || exit 0',
    'grep "^$1 " "$D/model-plan" | while read -r _ k; do',
    '  n=$(($(cat "$D/model-n" 2>/dev/null || echo 0) + 1)); echo "$n" >"$D/model-n"; m="w${n}x$k"',
    '  case "$k" in',
    '    ref) t=$(git -C "$B" commit-tree "HEAD^{tree}" -p HEAD -m "$m") && git -C "$B" update-ref "refs/heads/$m" "$t" && echo "ref $m $t" >>"$D/model-writes" ;;',
    '    oldref) [ -d "$O" ] && grep -q "^obs [^ ]* $(ino "$O") " "$D/model-log" || continue',
    '      t=$(git -C "$O" commit-tree "HEAD^{tree}" -p HEAD -m "$m") && git -C "$O" update-ref "refs/heads/$m" "$t" && echo "oldref $m $t" >>"$D/model-writes" ;;',
    '    index) echo "$m" >"$B/$m.staged" && git -C "$B" add "$m.staged" && echo "index $m -" >>"$D/model-writes" ;;',
    '    config) git -C "$B" config "model.$m" 1 && echo "config $m -" >>"$D/model-writes" ;;',
    '    file) echo "$m" >"$B/$m.txt" && echo "file $m -" >>"$D/model-writes" ;;',
    '    work) WORK_BASE="$B" "$WORKBIN" --json new -branch "$m" "$m" >/dev/null && echo "work $m -" >>"$D/model-writes" ;;',
    '    stay) [ -d "$O" ] && mkdir -p "$P/9$n" && ln -s "$O" "$P/9$n/cwd" && echo "9$n" >>"$D/model-stay" ;;',
    "  esac",
    "done",
    "exit 0",
    "",
  ].join("\n")

const gitOk = (b: Bench, path: string, ...args: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync(["git", "-C", path, ...args], { env: b.env, stdout: "pipe", stderr: "pipe" })
  return ran.exitCode === 0 ? ran.stdout.toString().trim() : undefined
}
/** Whether the write `w` is in the tree at `path`. */
const holds = (b: Bench, path: string, w: Write): boolean => {
  if (!existsSync(join(path, ".git"))) return false
  switch (w.klass) {
    case "ref":
    case "oldref":
      return (gitOk(b, path, "rev-parse", "-q", "--verify", `refs/heads/${w.mark}`) === w.value || gitOk(b, path, "rev-parse", "-q", "--verify", `refs/subvolume-move/heads/${w.mark}`) === w.value) && gitOk(b, path, "cat-file", "-e", w.value) !== undefined
    case "index":
      return (gitOk(b, path, "ls-files", "-s", `${w.mark}.staged`) ?? "") !== ""
    case "config":
      return gitOk(b, path, "config", "--get", `model.${w.mark}`) === "1"
    case "file":
      return existsSync(join(path, `${w.mark}.txt`))
    default:
      return true
  }
}
/** Whether an output says the base lacks `w` (a line of what the base lacks of the kept tree). */
const saysLacks = (text: string, w: Write) =>
  textLines(text).some((line) => /^ {2}(ref |HEAD |Git file |reflog |worktree or index: )/.test(line) && (line.includes(w.mark) || (w.klass === "config" && line.includes(".git/config"))))

/** Seeded: the same histories every run. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

describe("workrift subvolume: the model (histories of switches, faults, kills and writers)", () => {
  test("property: in every history a whole base is at its path at every step; nothing written to a live base is lost but into a kept, recorded tree the command names; no tree that was live is deleted but by --drop-old; every claim printed is true", async () => {
    // The steps of each command, from a run of each.
    const probe = bench("model-steps")
    const stepsOf: Record<Exclude<Cmd, "dry">, Set<string>> = { fwd: new Set(), back: new Set(), drop: new Set() }
    for (const cmd of ["fwd", "back", "fwd", "drop", "back", "drop"] as const) {
      rmSync(join(probe.state, "subvolume/log"), { force: true })
      expect(probe.wr(CMD_ARGV[cmd]).code).toBe(0)
      for (const s of probe.steps()) stepsOf[cmd].add(s)
    }
    const all = [...new Set([...stepsOf.fwd, ...stepsOf.back, ...stepsOf.drop])]
    expect([...stepsOf.fwd]).toEqual(expect.arrayContaining(["copy", "swap", "swapped", "carry-wait", "carry", "prove", "switched"]))

    // Histories: every class written at every step of a forward and a back; a kill at every forward and back step
    // with writers around the exchange; then seeded random histories of every command, fault, kill and writer.
    const histories: Array<ReadonlyArray<Move>> = []
    for (const klass of KLASSES) {
      const at = (cmd: "fwd" | "back") => [...stepsOf[cmd]].map((step) => ({ klass, step }))
      histories.push([
        { cmd: "fwd", fault: "none", writers: at("fwd") },
        { cmd: "back", fault: "none", writers: at("back") },
        { cmd: "drop", fault: "none", writers: [] },
        { cmd: "back", fault: "none", writers: at("back") },
        { cmd: "fwd", fault: "none", writers: at("fwd") },
      ])
    }
    for (const cmd of ["fwd", "back"] as const)
      for (const kill of stepsOf[cmd])
        histories.push([
          ...(cmd === "back" ? [{ cmd: "fwd" as const, fault: "none" as const, writers: [] }] : []),
          { cmd, fault: "none", kill, writers: KLASSES.map((klass) => ({ klass, step: kill })) },
          { cmd: "dry", fault: "none", writers: [] },
          { cmd: "drop", fault: "none", writers: [] },
        ])
    const random = prng(Number(process.env.MODEL_SEED ?? 20261122))
    const pick = <T,>(xs: ReadonlyArray<T>) => xs[Math.floor(random() * xs.length)]!
    for (let h = 0; h < Number(process.env.MODEL_HISTORIES ?? 24); h++) {
      const moves: Array<Move> = []
      for (let i = 0, n = 3 + Math.floor(random() * 3); i < n; i++) {
        const cmd = pick<Cmd>(["fwd", "fwd", "back", "back", "drop", "dry"])
        if (cmd === "dry") {
          moves.push({ cmd, fault: "none", writers: [] })
          continue
        }
        const steps = [...stepsOf[cmd]]
        const fault = cmd === "drop" ? "none" : pick(Object.keys(MODEL_FAULTS))
        const writers = Array.from({ length: 1 + Math.floor(random() * 4) }, () => ({ klass: pick(KLASSES), step: pick(steps) }))
        if (fault === "stay") writers.push({ klass: "stay", step: "carry-wait" })
        moves.push({ cmd, fault, writers, ...(random() < 0.3 ? { kill: pick(steps) } : {}) })
      }
      histories.push(moves)
    }

    const live = async (moves: ReadonlyArray<Move>, h: number) => {
      const b = bench(`model-${h}`)
      const hook = join(b.dir, "model-hook")
      exe(hook, HOOK(b))
      const writes: Array<Write> = []
      const everLive = new Set<number>([lstatSync(b.base).ino])
      const story: Array<string> = []
      const at = (path: string) => (existsSync(path) ? lstatSync(path).ino : undefined)
      const trees = () => new Set([b.base, b.paths.new, b.paths.back, b.paths.old].map(at).filter((i): i is number => i !== undefined))
      const readWrites = () => {
        const lines = existsSync(join(b.dir, "model-writes")) ? textLines(readFileSync(join(b.dir, "model-writes"), "utf8")) : []
        for (const line of lines.slice(writes.length)) {
          const [klass, mark, value] = line.split(" ") as [Klass, string, string]
          writes.push({ klass, mark, value, said: false, dropped: false })
        }
      }
      const observed = () => {
        const lines = existsSync(join(b.dir, "model-log")) ? textLines(readFileSync(join(b.dir, "model-log"), "utf8")) : []
        rmSync(join(b.dir, "model-log"), { force: true })
        for (const line of lines) {
          const [, step, ino, ok] = line.split(" ")
          expect(ok, `${story.join(" > ")}: no whole base at ${b.base} at the step ${step}`).toBe("1")
          everLive.add(Number(ino))
        }
      }
      const run = async (argv: ReadonlyArray<string>, env: Env, label: string) => {
        const before = { trees: trees(), base: at(b.base)!, kind: b.kind(b.base) }
        const ran = await b.wrAsync(argv, { WORKRIFT_SUBVOLUME_HOOK_AT: all.join(" "), WORKRIFT_SUBVOLUME_HOOK: `sh '${hook}' "$1"`, ...env })
        story.push(`${label}=${ran.code ?? ran.signal}`)
        const where = story.join(" > ")
        for (const pid of existsSync(join(b.dir, "model-stay")) ? textLines(readFileSync(join(b.dir, "model-stay"), "utf8")) : []) rmSync(join(b.proc, pid), { recursive: true, force: true })
        rmSync(join(b.dir, "model-stay"), { force: true })
        observed()
        readWrites()
        const text = `${ran.out}\n${ran.err}`
        // A whole base at its path, after as at every step.
        expect(["F", "S"], where).toContain(b.kind(b.base))
        whole(b)
        everLive.add(at(b.base)!)
        for (const w of writes) if (saysLacks(text, w)) w.said = true
        // No tree that was live is deleted, but by --drop-old, which says first what the base lacks of it.
        const now = trees()
        for (const ino of everLive) {
          if (now.has(ino)) continue
          expect({ where, deleted: ino, by: argv.join(" "), ended: ran.code === 0 || ran.signal === "SIGKILL" }, `${where}\n${said(ran)}`).toEqual({ where, deleted: ino, by: "subvolume --drop-old --apply", ended: true })
          everLive.delete(ino)
          for (const w of writes) if (!w.dropped && w.said && w.klass !== "work") w.dropped = true
        }
        // Nothing written is lost: in the base, or in the tree kept at .old under its record and said.
        for (const w of writes) {
          if (w.dropped || w.klass === "stay") continue
          if (w.klass === "work") {
            const rec = b.records().find((r) => r.name === w.mark)
            expect({ where, work: w.mark, kept: rec !== undefined && existsSync(rec.path) }).toEqual({ where, work: w.mark, kept: true })
            continue
          }
          const inBase = holds(b, b.base, w)
          if (inBase) continue
          const kept = existsSync(join(b.state, "subvolume/kept")) && readFileSync(join(b.state, "subvolume/kept"), "utf8").split("\n")[0] === b.paths.old
          if (ran.signal === "SIGKILL") {
            // Cut: the next run finishes it and says; until then the write is in some tree of the move.
            expect({ where, w: w.mark, somewhere: [b.paths.old, b.paths.new, b.paths.back].some((p) => holds(b, p, w)) }, `${where}\n${said(ran)}`).toEqual({ where, w: w.mark, somewhere: true })
            continue
          }
          // A ref written into the live base is carried: it is always in the base once a run ends.
          expect({ where, lost: w.klass === "ref" ? w : undefined }, `${where}\n${said(ran)}`).toEqual({ where, lost: undefined })
          expect({ where, w: w.mark, klass: w.klass, inKept: holds(b, b.paths.old, w), recorded: kept, said: w.said }, `${where}\n${said(ran)}`).toEqual({ where, w: w.mark, klass: w.klass, inKept: true, recorded: true, said: true })
        }
        // Every claim printed is true.
        expect(text, where).not.toContain("nothing deleted that it held")
        if (text.includes("deleted nothing")) expect({ where, gone: [...before.trees].filter((i) => !now.has(i)) }).toEqual({ where, gone: [] })
        if (text.includes("deleted only its copy that was never the base")) expect({ where, gone: [...before.trees].filter((i) => !now.has(i) && everLive.has(i)) }).toEqual({ where, gone: [] })
        if (text.includes("rolled back before the exchange")) expect({ where, base: at(b.base), kind: b.kind(b.base) }).toEqual({ where, base: before.base, kind: before.kind })
        if (text.includes("not rolled back")) expect({ where, kind: b.kind(b.base) }).toEqual({ where, kind: argv.includes("--back") ? "F" : "S" })
        if (text.includes(`${b.base} holds all that ${b.paths.old} holds`))
          expect({ where, unsaid: writes.filter((w) => w.klass !== "work" && w.klass !== "stay" && holds(b, b.paths.old, w) && !holds(b, b.base, w)).map((w) => w.mark) }).toEqual({ where, unsaid: [] })
        return ran
      }

      for (const [i, move] of moves.entries()) {
        if (move.cmd === "dry") {
          for (const mode of [[], ["--back"], ["--drop-old"]]) {
            const before = treeHash(b.dir, ["work-calls", "btrfs-calls", "proc"])
            const ran = await b.wrAsync(["subvolume", ...mode])
            story.push(`dry${mode.join("")}=${ran.code}`)
            expect({ where: story.join(" > "), tree: treeHash(b.dir, ["work-calls", "btrfs-calls", "proc"]) }).toEqual({ where: story.join(" > "), tree: before })
          }
          continue
        }
        writeFileSync(join(b.dir, "model-plan"), move.writers.map((w) => `${w.step} ${w.klass}\n`).join(""))
        const argv = CMD_ARGV[move.cmd]
        const env = { ...MODEL_FAULTS[move.fault], ...(move.kill ? { WORKRIFT_SUBVOLUME_DIE_AT: move.kill } : {}) }
        let ran = await run(argv, env, `${i}:${move.cmd}${move.fault === "none" ? "" : `!${move.fault}`}${move.kill ? `@${move.kill}` : ""}[${move.writers.map((w) => `${w.klass}@${w.step}`).join(",")}]`)
        rmSync(join(b.dir, "model-plan"), { force: true })
        // A second run, without the fault, ends the command: the switch done, or the drop.
        if (ran.code !== 0) ran = await run(argv, {}, `${i}:again`)
        expect(ran.code, `${story.join(" > ")}: ${said(ran)}`).toBe(0)
      }
    }
    const only = process.env.MODEL_ONLY?.split(",").map(Number)
    await pool(histories.flatMap((moves, h) => (only && !only.includes(h) ? [] : [() => live(moves, h)])))
    expect(histories.length).toBeGreaterThan(50)
  }, 1_800_000)
})

/** The external commands workrift runs, each put behind a shim by the census (`work` through WORK). */
const CENSUS_COMMANDS = ["git", "jq", "date", "sed", "tr", "grep", "cat", "awk", "rm", "find", "work", "stat", "head", "mkdir", "dirname", "wc", "sleep", "cut", "cp", "basename", "readlink", "mv", "lsof", "python3", "ps", "mktemp", "ls", "ln", "id", "getconf", "df", "uname", "sort", "cksum", "btrfs", "flock", "findmnt", "touch", "xargs", "comm", "tail", "sh"]
/** Functions that only run one external command: a failure inside one is its caller's call site. */
const WRAPPERS: Record<string, string> = { base_git: "git", work_in: "work", sv_renameat: "python3" }
/** Functions that run the command their arguments name (sv_read VAR CMD…): the command is the call site. */
const RUNNERS = ["sv_read"]

/** One call site of the script: an external command (or a wrapper's call) at a line, the k-th of its kind there. */
interface Site {
  readonly id: string
  readonly line: number
  /** Where the census's instrumented copy puts `CENSUS_SITE=<id> ` (before `nice`, `command` or `sv_read` when one leads). */
  readonly col: number
  /** The last line of the statement it is in. */
  readonly end: number
  readonly fn: string
  readonly command: string
  readonly ordinal: number
  /** The first run of literal words after the command, as a case pattern (to read the table by). */
  readonly glob: string
  readonly construct: ReadonlyArray<string>
  /** What set -e does with a failure here. */
  readonly setE: "stops" | "does not stop"
  readonly text: string
}

/** A command the scanner found, before it is kept as a site. */
interface Raw {
  line: number
  col: number
  read: boolean
  end: number
  fn: string
  word: string
  args: string
  subst: "none" | "assigned" | "embedded"
  pipeNotLast: boolean
  pipeLast: boolean
  or: string | undefined
  and: boolean
  afterAndOr: boolean
  cond: boolean
  neg: boolean
  devnull: boolean
  text: string
}

/** The words after a command, to its segment's end, quotes stripped; a word with an expansion is null. */
const argWords = (raw: string, from: number): Array<string | null> => {
  const out: Array<string | null> = []
  let word = ""
  let literal = true
  let started = false
  let q: string | undefined
  let depth = 0
  const push = () => {
    if (started) out.push(literal ? word : null)
    word = ""
    literal = true
    started = false
  }
  for (let k = from; k < raw.length; k++) {
    const c = raw[k]!
    if (q) {
      if (c === q) q = undefined
      else {
        if (q === '"' && (c === "$" || c === "`")) literal = false
        word += c
      }
      continue
    }
    if (depth > 0) {
      if (c === "(") depth++
      if (c === ")") depth--
      continue
    }
    if (c === "'" || c === '"') {
      q = c
      started = true
      continue
    }
    if (c === "$" && raw[k + 1] === "(") {
      depth = 1
      k++
      literal = false
      started = true
      continue
    }
    if (c === "$" || c === "`") literal = false
    if (/\s/.test(c)) {
      push()
      continue
    }
    if (c === "|" || c === ";" || c === "&" || c === ")" || (c === "#" && !started)) break
    if ((c === ">" || c === "<") && !started) {
      // A redirection and its target: no argument.
      let t = k + 1
      while (raw[t] === ">" || raw[t] === "&" || raw[t] === "<") t++
      while (t < raw.length && /\s/.test(raw[t]!)) t++
      while (t < raw.length && !/[\s;|&)]/.test(raw[t]!)) t++
      k = t - 1
      continue
    }
    if (/[0-9]/.test(c) && !started && (raw[k + 1] === ">" || raw[k + 1] === "<")) continue
    word += c
    started = true
  }
  push()
  return out
}
/** The case pattern of a call site: its first run of literal arguments. */
const globOf = (words: Array<string | null>) => {
  const run: Array<string> = []
  for (const w of words) {
    if (w === null || w === "\\") {
      if (run.length > 0) break
      continue
    }
    run.push(w)
  }
  const esc = run.join(" ").replace(/[\\*?[\]]/g, (c) => `\\${c}`)
  return run.length > 0 ? `*${esc}*` : "*"
}

/**
 * The sites of the scanned commands: those of the functions workrift subvolume reaches, and of the top level that runs
 * for it (before the dispatch on the command, and its `subvolume)` arm), with set -e's verdict on each.
 */
const keptSites = (raws: ReadonlyArray<Raw>, fns: ReadonlyArray<{ readonly name: string; readonly start: number; readonly end: number }>, names: ReadonlySet<string>, topRuns: (line: number) => boolean): ReadonlyArray<Site> => {
  const byName = new Map(fns.map((f) => [f.name, f]))
  const reach = new Set<string>(["(top)"])
  const walk = (name: string) => {
    if (reach.has(name) || !byName.has(name)) return
    reach.add(name)
    for (const r of raws) if (r.fn === name && names.has(r.word)) walk(r.word)
  }
  for (const root of ["subvolume_command", "tickets_at_exit", "fail"]) walk(root)
  raws = raws.filter((r) => r.fn !== "(top)" || topRuns(r.line))
  for (const r of raws) if (r.fn === "(top)" && names.has(r.word)) walk(r.word)
  // A call in a condition, after `!`, or left of `||` / `&&`: set -e is off for the whole call.
  const off = new Set<string>()
  const walkOff = (name: string) => {
    if (off.has(name) || !byName.has(name)) return
    off.add(name)
    for (const r of raws) if (r.fn === name && names.has(r.word)) walkOff(r.word)
  }
  for (const r of raws) if (reach.has(r.fn) && names.has(r.word) && (r.cond || r.neg || r.or !== undefined || r.and)) walkOff(r.word)
  const external = (w: string) => CENSUS_COMMANDS.includes(w) || w in WRAPPERS
  const kept = raws.filter((r) => reach.has(r.fn) && !(r.fn in WRAPPERS) && external(r.word))
  const seen = new Map<string, number>()
  return kept.map((r) => {
    const command = WRAPPERS[r.word] ?? r.word
    const key = `${r.line}:${command}`
    const ordinal = (seen.get(key) ?? 0) + 1
    seen.set(key, ordinal)
    const construct: Array<string> = []
    if (r.read) construct.push("sv_read (its status returned)")
    if (r.subst === "assigned") construct.push("x=$(…)")
    if (r.subst === "embedded") construct.push("$(…) in another command")
    if (r.pipeNotLast) construct.push("pipe, not its last command")
    if (r.pipeLast) construct.push("pipe, last")
    if (r.or !== undefined) construct.push(`|| ${r.or}`)
    if (r.and) construct.push("&& …")
    if (r.afterAndOr) construct.push("after && or ||")
    if (r.cond) construct.push("condition")
    if (r.neg) construct.push("!")
    if (r.devnull) construct.push("2>/dev/null")
    if (off.has(r.fn)) construct.push(`set -e off when ${r.fn} is called in a condition`)
    const ignored = r.pipeNotLast || r.subst === "embedded" || r.or !== undefined || r.and || r.cond || r.neg || off.has(r.fn)
    return {
      id: `${r.line}:${command}#${ordinal}`,
      line: r.line,
      col: r.col,
      end: r.end,
      fn: r.fn,
      command,
      ordinal,
      glob: globOf(JSON.parse(r.args) as Array<string | null>),
      construct,
      setE: ignored ? "does not stop" : "stops",
      text: r.text,
    } satisfies Site
  })
}

/** The offset just past the bracket that closes the one at `from` (`$((…))`, `${…}`), on the same line. */
const pastClose = (raw: string, from: number, open: string, close: string) => {
  let d = 0
  let k = from
  for (; k < raw.length; k++) {
    if (raw[k] === open) d++
    else if (raw[k] === close && --d === 0) break
  }
  return k + 1
}

/** A `||` that ends a line: its handler is the next line. */
const handlersOnNextLine = (raws: ReadonlyArray<Raw>, lines: ReadonlyArray<string>) => {
  for (const r of raws) {
    if (r.or !== "(the next line)") continue
    const at = lines.slice(r.line - 1, r.end).findIndex((l) => /\|\|\s*$/.test(l))
    if (at >= 0) r.or = lines[r.line - 1 + at + 1]!.trim().slice(0, 160)
  }
}

/** The functions of the script: each `name() {` to its `}` at the line's start. */
const scriptFunctions = (lines: ReadonlyArray<string>) => {
  const fns: Array<{ readonly name: string; readonly start: number; readonly end: number }> = []
  lines.forEach((text, i) => {
    const m = text.match(/^([a-z_][a-z0-9_]*)\(\) \{(.*\})?\s*$/)
    if (!m) return
    let j = i
    if (!m[2]) while (j + 1 < lines.length && lines[j] !== "}") j++
    fns.push({ name: m[1]!, start: i + 1, end: j + 1 })
  })
  return fns
}

/**
 * The call sites of every function `workrift subvolume` reaches (from subvolume_command, fail and the exit trap) and of
 * the top level, by a scanner over the script's text: quotes, `$(…)`, heredocs, comments and redirections are tracked,
 * and each simple command's first word is a command. The census addresses calls by these sites, never by a count.
 */
const callSites = (src: string): ReadonlyArray<Site> => {
  const lines = src.split("\n")
  const fns = scriptFunctions(lines)
  const fnAt = (n: number) => fns.find((f) => f.start <= n && n <= f.end)?.name ?? "(top)"
  const names = new Set(fns.map((f) => f.name))
  const raws: Array<Raw> = []
  type Ctx = { kind: "top" | "subst" | "dq" | "sq"; depth: number; assigned: boolean }
  const stack: Array<Ctx> = [{ kind: "top", depth: 0, assigned: false }]
  interface Seg { cmd: Raw | undefined; group: ReadonlyArray<Raw>; expect: boolean; pipeFrom: boolean; afterAndOr: boolean; neg: boolean; col: number | undefined; read: boolean }
  const fresh = (): Seg => ({ cmd: undefined, group: [], expect: true, pipeFrom: false, afterAndOr: false, neg: false, col: undefined, read: false })
  // `{ …; }`: where each group began in raws; a group followed by || or && takes it for every command in it.
  const groups: Array<number> = []
  const listed = (s: Seg, how: (r: Raw) => void) => {
    if (s.cmd) how(s.cmd)
    else for (const r of s.group) how(r)
  }
  const segs: Array<Seg> = [fresh()]
  const seg = () => segs[segs.length - 1]!
  let heredoc: string | undefined
  let cond = 0
  let pendingAssign = false
  let open: Array<Raw> = []
  /** A command named at line n, its arguments from the offset `from`: in the current segment. */
  const record = (n: number, raw: string, word: string, at: number) => {
    const s = seg()
    const substCtx = [...stack].reverse().find((x) => x.kind === "subst")
    const from = at + (word === "work" && raw.startsWith('"$work_bin"', at) ? 11 : raw.slice(at).match(/^[^\s;|&()<>'"`$]+/)![0].length)
    const r: Raw = {
      line: n,
      col: s.col ?? at,
      read: s.read,
      end: n,
      fn: fnAt(n),
      word,
      args: JSON.stringify(argWords(raw, from)),
      subst: substCtx ? (substCtx.assigned ? "assigned" : "embedded") : "none",
      pipeNotLast: false,
      pipeLast: s.pipeFrom,
      or: undefined,
      and: false,
      afterAndOr: s.afterAndOr,
      cond: cond > 0,
      neg: s.neg,
      devnull: false,
      text: raw.trim().slice(0, 160),
    }
    raws.push(r)
    open.push(r)
    s.cmd = r
    s.expect = false
  }
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1
    const raw = lines[i]!
    if (heredoc !== undefined) {
      if (raw.trim() === heredoc) heredoc = undefined
      continue
    }
    let j = /^[a-z_][a-z0-9_]*\(\) \{/.test(raw) ? raw.indexOf("{") + 1 : 0
    const at = (k: number) => raw[k] ?? ""
    while (j < raw.length) {
      const c = at(j)
      const ctx = stack[stack.length - 1]!
      if (ctx.kind === "sq") {
        if (c === "'") stack.pop()
        j++
        continue
      }
      if (ctx.kind === "dq") {
        if (c === "\\") j += 2
        else if (c === '"') {
          stack.pop()
          j++
        } else if (c === "$" && at(j + 1) === "(" && at(j + 2) !== "(") {
          stack.push({ kind: "subst", depth: 0, assigned: false })
          segs.push(fresh())
          j += 2
        } else j++
        continue
      }
      if (c === "#" && (j === 0 || /[\s;]/.test(at(j - 1)))) break
      if (c === "\\") {
        j += 2
        continue
      }
      if (c === "'") {
        stack.push({ kind: "sq", depth: 0, assigned: false })
        seg().expect = false
        j++
        continue
      }
      if (c === '"') {
        stack.push({ kind: "dq", depth: 0, assigned: false })
        if (!seg().expect) {
          j++
          continue
        }
        // `"$work_bin" …` as a command.
        if (raw.startsWith('"$work_bin"', j)) {
          stack.pop()
          record(n, raw, "work", j)
          j += 11
          continue
        }
        // Another quoted word in command place is the command (`"$@"`), no site; after `=`, a value.
        if (at(j - 1) !== "=") seg().expect = false
        j++
        continue
      }
      if (c === "$" && at(j + 1) === "(" && at(j + 2) === "(") {
        j = pastClose(raw, j + 1, "(", ")")
        continue
      }
      if (c === "$" && at(j + 1) === "(") {
        stack.push({ kind: "subst", depth: 0, assigned: pendingAssign })
        pendingAssign = false
        segs.push(fresh())
        j += 2
        continue
      }
      if (c === "$" && at(j + 1) === "{") {
        j = pastClose(raw, j + 1, "{", "}")
        seg().expect = false
        continue
      }
      if (c === "(") {
        ctx.depth++
        segs[segs.length - 1] = fresh()
        j++
        continue
      }
      if (c === ")") {
        if (ctx.kind === "subst" && ctx.depth === 0) {
          stack.pop()
          const inner = segs.pop()!
          // `x=$(…) || h`: the substitution's last command is the status the handler sees.
          if (ctx.assigned && seg().cmd === undefined && inner.cmd) seg().cmd = inner.cmd
          j++
          continue
        }
        if (ctx.depth > 0) ctx.depth--
        segs[segs.length - 1] = fresh()
        j++
        continue
      }
      if (c === "<" && at(j + 1) === "<" && at(j + 2) !== "<") {
        const m = raw.slice(j + 2).match(/^-?\s*['"]?([A-Za-z_]+)['"]?/)
        if (m) heredoc = m[1]
        j += 2
        continue
      }
      const redir = raw.slice(j).match(/^[0-9]*(<<<|>>|<>|>&|<&|>|<)(-|[0-9]+)?/)
      if (redir && (c === "<" || c === ">" || (/[0-9]/.test(c) && /^[0-9]+[<>]/.test(raw.slice(j))))) {
        const rest = raw.slice(j + redir[0].length)
        if (/^>|2>/.test(redir[0]) && rest.startsWith("/dev/null") && redir[0].startsWith("2")) {
          const s = seg()
          if (s.cmd) s.cmd.devnull = true
        }
        j += redir[0].length
        if (/^\s*["']/.test(raw.slice(j))) {
          const k0 = raw.slice(j).search(/["']/) + j
          const k = raw.indexOf(raw[k0]!, k0 + 1)
          j = k < 0 ? raw.length : k + 1
        } else {
          const tw = raw.slice(j).match(/^\s*[^\s;|&()<>'"`]+/)
          if (tw) j += tw[0].length
        }
        continue
      }
      if (c === "|" && at(j + 1) === "|") {
        const or = raw.slice(j + 2).trim().slice(0, 160) || "(the next line)"
        listed(seg(), (r) => {
          r.or ??= or
        })
        segs[segs.length - 1] = { ...fresh(), afterAndOr: true }
        j += 2
        continue
      }
      if (c === "&" && at(j + 1) === "&") {
        listed(seg(), (r) => {
          r.and = true
        })
        segs[segs.length - 1] = { ...fresh(), afterAndOr: true }
        j += 2
        continue
      }
      if (c === "|") {
        const s = seg()
        if (s.cmd) s.cmd.pipeNotLast = true
        segs[segs.length - 1] = { ...fresh(), pipeFrom: true }
        j++
        continue
      }
      if (c === ";" || c === "&") {
        if (at(j + 1) === ";") j++
        segs[segs.length - 1] = fresh()
        j++
        continue
      }
      if (/\s/.test(c)) {
        j++
        continue
      }
      const m = raw.slice(j).match(/^[^\s;|&()<>'"`$]+/)
      if (!m) {
        j++
        seg().expect = false
        continue
      }
      const w = m[0]
      const s = seg()
      if (s.expect) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
          if (w.endsWith("=") && raw.startsWith("$(", j + w.length)) pendingAssign = true
          j += w.length
          continue
        }
        if (w === "local" || w === "!" || ["then", "do", "else", "fi", "done", "esac", "{", "}", "in", "time", "command"].includes(w)) {
          if (w === "!") s.neg = true
          if (w === "then" || w === "do") cond = Math.max(0, cond - 1)
          if (w === "{") groups.push(raws.length)
          if (w === "}" && groups.length > 0) s.group = raws.slice(groups.pop())
          // `command -v x` looks x up: no call of it.
          if (w === "command" && /^command\s+-[vV]/.test(raw.slice(j))) s.expect = false
          j += w.length
          continue
        }
        if (["if", "while", "until", "elif"].includes(w)) {
          cond++
          j += w.length
          continue
        }
        if (w === "case" || w === "for") {
          s.expect = false
          j += w.length
          continue
        }
        if (w === "nice" || RUNNERS.includes(w)) {
          // `nice -n N cmd`, `sv_read VAR cmd`: the command is the word after; the site's mark goes before them.
          const nm = raw.slice(j).match(/^\S+\s+(-n\s+)?\S+\s+/)
          s.col ??= j
          s.read ||= w !== "nice"
          j += nm ? nm[0].length : w.length
          continue
        }
        if (w.endsWith(")") || /^[^a-z_/]/.test(w)) {
          // `[` is the test builtin: its words are no commands. (A case pattern's `x)` leaves the arm's command next.)
          if (w === "[") s.expect = false
          j += w.length
          continue
        }
        record(n, raw, w.replace(/^.*\//, ""), j)
        j += w.length
        continue
      }
      j += w.length
    }
    // A line that ends its statement closes it: the end line of every command opened since.
    const t = raw.replace(/\s+#.*$/, "").trimEnd()
    if (stack.length === 1 && heredoc === undefined && !/(\\|\||&&|\(|\{|(^|\s)(then|do|else|in))$/.test(t)) {
      for (const r of open) r.end = n
      open = []
      if (t !== "") segs[0] = fresh()
    }
  }
  handlersOnNextLine(raws, lines)
  const dispatch = lines.indexOf('case "$command" in') + 1
  const arm = lines.indexOf("  subvolume)") + 1
  const armEnd = lines.indexOf("    ;;", arm) + 1
  if (dispatch === 0 || arm === 0 || armEnd === 0) throw new Error("the script's dispatch (case \"$command\" in, its subvolume) arm) is not where the census looks")
  return keptSites(raws, fns, names, (line) => line < dispatch || (arm <= line && line <= armEnd))
}

/** The handler of a site's `||`, from its construct. */
const handlerOf = (site: Site) => site.construct.find((c) => c.startsWith("|| "))?.slice(3) ?? ""

/**
 * What a failure at the site becomes, where its construct says it: set -e stops the script; a `|| fail` stops it with
 * its own message; a `|| return 1` hands the failure to the caller. Undefined: VERDICTS says it.
 */
const autoVerdict = (site: Site): string | undefined => {
  const or = handlerOf(site)
  if (site.setE === "stops") return "stops: set -e ends the script; the exit trap says what failed, its status and step, the state of both trees and the next command"
  if (/\b(fail|sv_stop|sv_stop_status|p_left)\b/.test(or)) return "stops: its own message (fail), with the state of both trees and the next command"
  if (/^(\{ .*)?return [1-9]/.test(or) || /^\{ sv_why=.*(return 1|sv_abort)/.test(or)) return "returned: the function fails (sv_why says why where it is set) and its caller checks it"
  return undefined
}

/**
 * What a failure becomes at each site whose construct does not say it (autoVerdict), and what the script decides from
 * it, keyed by verdictKeys. Each starts with its kind: closed (the failure leads to a refusal, a wait or a fault said,
 * never to the step that a success allows), returned (the function's status, which its caller checks), branch (a
 * condition whose false branch is the safe one), message (read only for words a person reads), cleanup (a scratch
 * file; nothing reads it after), unreachable (a path the census host cannot take: Linux's /proc, lsof, a test hook).
 */
const VERDICTS: Record<string, string> = {
  "(top):uname#1": "closed: uname that fails reads as not Linux: purge_trash=false, the trash is kept, never purged",
  "normalized_origin:git#1": "closed: no origin (pipe member) reads as an origin no source has: resolve_source finds none and fails; never reached with WORKRIFT_SOURCE set",
  "normalized_origin:sed#1": "closed: as its git: an empty origin, no source found, a refusal",
  "process_identity:cat#1": "closed: /proc/<pid>/stat that does not read is no identity (empty): process_is asks kill -0, alive is unknown, never gone",
  "process_identity:awk#1": "closed: no start tick is no identity (empty): unknown while kill -0 finds the pid, never gone",
  "process_identity:cat#2": "closed: no boot id is no identity (empty), never one that differs (r4: it was `boot  tick N`, a mismatch, a holder taken for gone)",
  "process_identity:ps#1": "closed: ps that fails prints nothing: no identity, unknown while kill -0 finds the pid, never gone",
  "process_identity:sed#1": "closed: as its ps: empty, no identity, never gone",
  "ticket_live:flock#1": "closed: flock -n that fails (held or an error) is a held ticket: it is live unless its owner is known gone",
  "process_parent:cat#1": "closed: no parent: sv_in_line's walk ends, the process counts as outside workrift's line (a user of the base: wait or refusal)",
  "process_parent:awk#1": "closed: as its cat: no parent, the process is outside the line",
  "process_parent:ps#1": "closed: as on Linux: no parent, outside the line",
  "process_parent:tr#1": "closed: as its ps",
  "queue_sweep:rm#1": "cleanup: a dead ticket left in place; every reader checks liveness (ticket_live), so it is skipped as dead",
  "queue_sweep:rm#2": "cleanup: a stray .in left; a .in without its ticket is never read",
  "ticket_ahead:sort#1": "returned: `&& [ -n ] || return 1`: a sort that fails is the line unreadable; both queue_enter callers fail on it",
  "ticket_ahead_words:grep#1": "message: the count in the waiting line's words",
  "ticket_ahead_words:head#1": "message: the first ticket's words; empty says nothing ahead in the message only",
  "ticket_words:sed#1": "message: the pid in the waiting line's words",
  "ticket_words:ps#1": "message: whether the holder is stopped, in words",
  "ticket_words:sed#2": "message: the purpose in words",
  "ticket_words:sed#3": "message: the since in words",
  "queue_enter:date#2": "closed: a clock that does not read is the polite patience spent: it takes its place in line now (a writer waits its turn there)",
  "queue_enter:date#3": "closed: as before it",
  "queue_enter:cat#1": "closed: a counter that does not read is 0; the next number is past every ticket present, so no ticket is numbered below a live one",
  "queue_enter:sleep#1": "message: the talker that repeats the waiting line ends; the wait goes on",
  "queue_enter:date#5": "closed: a clock that does not read is the bound passed: the line is read again, and a ticket still ahead gives the place back (subvolume: a refusal)",
  "legacy_path:git#1": "returned: `&& [ -n ] || return 1`; legacy_take fails when a .git is there (r4), queue_enter's check then makes a reader a writer (more exclusive)",
  "legacy_take:flock#1": "branch: try mode, the lock held or an error: returns 1, no place taken",
  "legacy_take:flock#2": "branch: the try failed: the blocking flock follows, and its failure fails",
  "legacy_yield:ls#1": "unreachable: Linux only (/proc/locks); an inode that does not read yields to nothing: fairness to an older waiting writer, not exclusion (the flock after it is)",
  "legacy_yield:awk#1": "unreachable: as its ls",
  "legacy_yield:awk#2": "unreachable: Linux only; awk that fails ends the yield, as above",
  "legacy_yield:sleep#1": "unreachable: Linux only; a sleep that fails looks again at once",
  "ticket_wait:date#1": "closed: returns: the caller reads the line again (ticket_ahead), and a ticket still ahead gives the place back",
  "ticket_wait:date#2": "closed: as before it",
  "ticket_wait:flock#1": "branch: flock -w that fails (held, timed out, an error) waits on; the owner and the bound are checked each round",
  "ticket_wait:date#3": "closed: [ '' -lt N ] fails, the wait returns: the caller reads the line again",
  "queue_leave:rm#1": "cleanup: said; the given-back ticket stays with its lock closed: dead to every reader, swept (r4: in a plain call it was a set -e stop after a finished switch)",
  "base_snapshots:stat#1": "closed: not a snapshot base: it takes the clone turn (slower, never worse)",
  "base_snapshots:stat#2": "closed: as before it",
  "base_snapshots:work#1": "closed: doctor that fails is no btrfs cloner: the clone turn is taken",
  "base_snapshots:jq#1": "closed: as its work",
  "clock_time:date#1": "branch: GNU date's -d failing tries BSD date's -r (message only)",
  "clock_time:date#2": "message: a time of day in words",
  "phase:date#1": "message: the seconds in a phase line",
  "work_bases:head#1": "message: the answer quoted in a fail",
  "work_bases:jq#2": "closed: after the list was checked by jq -e, a jq that fails lists fewer bases: the base is not listed, a refusal",
  "work_workspaces:work#1": "branch: work list that fails: no workspaces when the base is gone, else a fail",
  "work_workspaces:jq#1": "returned: the function's status (last of its pipe)",
  "work_resolve_source:cut#1": "closed: not found among the workspaces: the source is then found by origin, and the switch acts only on a listed work base (never reached with WORKRIFT_SOURCE)",
  "work_resolve_source:grep#1": "closed: as its cut",
  "work_resolve_source:grep#2": "closed: a count that does not read matches no case arm: no source, a refusal",
  "work_resolve_source:tr#1": "message: the sources named in a fail",
  "work_list_checked:head#1": "message: the answer quoted in a fail",
  "work_purge:jq#2": "message: the trash folders named in a fail",
  "work_purge:tr#1": "message: as before it",
  "work_purge:jq#4": "closed: an id that does not read is none of those asked for: p_left fails",
  "work_purge:grep#1": "closed: grep that fails is not among those asked for: p_left fails",
  "work_purge:work#1": "closed: work gc that fails leaves the trash, named, and the purge fails",
  "work_purge:jq#5": "closed: an answer that does not read differs from the name: the trash is said and the purge fails",
  "work_purge:jq#6": "closed: as before it",
  "work_purge:jq#7": "closed: jq -e's status read: 0 listed, 1 gone, any other unproven and the purge fails (r4: any failure read as gone)",
  "work_purge:jq#8": "message: the record quoted",
  "sv_kind:stat#1": "closed: prints `?` and fails: sv_kind_of stops with the three facts; no `?` is taken for a kind",
  "sv_kind:stat#2": "closed: as before it",
  "sv_identity:btrfs#1": "returned: `&& [ -n ] || return 1`: every caller stops or refuses (no identity is recorded or compared as `?`)",
  "sv_identity:stat#1": "returned: as before it",
  "sv_step:mkdir#1": "message: the step log is a record for a person; its write failing is said, and the switch goes on (the phase record, which decides, is sv_phase_write, checked)",
  "sv_step:date#1": "message: the log line's time",
  "sv_step:sh#1": "unreachable: the test hook (WORKRIFT_SUBVOLUME_HOOK), set by tests only",
  "sv_users:cat#1": "message: the command name of a process found in the tree (`?` when it does not read); the process is counted either way",
  "sv_removals:tr#1": "closed: a process still there whose command line does not read is a removal of this base (refused)",
  "sv_removals:awk#1": "closed: as before it",
  "sv_removals:readlink#1": "closed: a process still there whose working folder does not read is a removal of this base (refused)",
  "sv_removals:tr#2": "closed: a removal whose environment does not read counts as one of this base (refused)",
  "sv_removals:sed#1": "closed: a clone ticket that does not read is a removal of this base (refused)",
  "sv_runs_tickets:sed#1": "closed: a script that does not read is not one that takes tickets: the process counts as an older workrift (refused)",
  "sv_runs_tickets:grep#1": "closed: as before it",
  "sv_runs_tickets:lsof#1": "closed: no open files read: not one that takes tickets, an older workrift (refused)",
  "sv_runs_tickets:sed#2": "closed: as its lsof",
  "sv_runs_tickets:sed#3": "closed: as on Linux",
  "sv_runs_tickets:grep#2": "closed: as on Linux",
  "sv_runs_tickets:grep#3": "closed: as on Linux",
  "sv_old_workrifts:tr#1": "closed: a process still there whose command line does not read is an older workrift (refused)",
  "sv_old_workrifts:awk#1": "closed: as before it",
  "sv_git_locks:git#1": "closed: prints `unknown`: the lock check says NO",
  "sv_git_locks:find#1": "closed: as before it",
  "sv_git_locks:find#2": "closed: as before it",
  "sv_fs_dir:findmnt#2": "closed: no UUID is no state folder: the metadata check says the sizes do not read (NO)",
  "sv_preflight:findmnt#1": "closed: sv_read's status: options that do not read are a NO",
  "sv_preflight:cat#1": "closed: sv_read's status: sizes that do not read stay empty, a NO (r4: they were 0, a slack read wrong)",
  "sv_preflight:cat#2": "closed: as the first: the group's `|| true` leaves the sizes empty, a NO",
  "tickets_at_exit:rm#1": "cleanup: in the exit trap, the script ends either way; a ticket it cannot remove is dead (its lock goes with the process) and swept",
  "sv_preflight:df#1": "closed: sv_read's status: a df that does not read is a NO",
  "(top):python3#1": "closed: no python3 with ctypes is a NO: nothing can make the exchange",
  "sv_refs:sort#1": "returned: the function's status (last of its pipe); its callers check it",
  "sv_digest:git#1": "branch: no symbolic HEAD tries rev-parse HEAD, and that failing fails",
  "sv_store:sort#1": "returned: the function's status (last of its pipe)",
  "sv_tips_missing:git#1": "closed: prints the failure: a non-empty answer, the copy is not true",
  "sv_tips_missing:awk#1": "closed: as before it",
  "sv_tips_missing:git#2": "closed: as before it",
  "sv_tips_missing:grep#1": "closed: grep's status read: 1 none missing, any other the failure printed (the copy is not true)",
  "sv_tips_missing:cat#1": "closed: errors that do not read are said: the copy is not true",
  "sv_tips_missing:rm#1": "cleanup: tips.err is written again before it is read",
  "sv_copy_true:cat#1": "returned: the && chain: a read that fails is a copy not true (copy again, then roll back)",
  "sv_copy_true:cat#2": "returned: as before it",
  "sv_carry:rm#1": "cleanup: the files are written again (>) right after",
  "sv_carry:git#1": "branch: symbolic-ref's status read: 0 HEAD names a branch, 1 detached, any other sv_why and return 1",
  "sv_carry:git#2": "branch: as before it",
  "sv_carry:awk#1": "returned: `if ! awk … || ! sort`: sv_why, return 1 (nothing carried, the switch said unfinished)",
  "sv_carry:sort#1": "returned: as its awk",
  "sv_carry:rm#2": "cleanup: the scratch files of a carry that failed",
  "sv_carry:git#3": "closed: a fetch that fails is checked by the rev-parse after it: an object missing is not carried (sv_missed, said)",
  "sv_carry:git#4": "branch: rev-parse -q --verify's status read: 1 missing (not carried), any other c_failed, rerun",
  "sv_carry:git#5": "branch: update-ref that fails keeps the ref under refs/subvolume-move/, said",
  "sv_carry:git#6": "closed: that failing too is counted and said (not carried)",
  "sv_carry:rm#3": "cleanup: the scratch files after the carry",
  "sv_wait_users:sleep#1": "closed: a sleep that fails looks again; the clock bounds the wait (checked)",
  "sv_rm_folder:rm#1": "closed: no GNU rm --version takes BSD's -x, which GNU rm refuses: a wrong guess deletes nothing and fails",
  "sv_rm_folder:rm#2": "returned: the function's status; callers fail on it",
  "sv_rm_folder:rm#3": "returned: as before it",
  "sv_rm_folder:rm#4": "returned: as before it",
  "sv_rm_folder:rm#5": "returned: as before it",
  "sv_cp:cp#1": "returned: in the background; its status is read by wait in sv_cp, and a copy that failed fails",
  "sv_cp:rm#1": "cleanup: the copier record; a stale one is read with the copier's identity, which no longer matches",
  "sv_wait_copier:sleep#1": "closed: a sleep that fails looks again; the clock bounds the wait",
  "sv_copy_in:git#1": "closed: an index not refreshed differs in status: sv_copy_true says the copy is not true",
  "sv_smoke_rm:sleep#1": "closed: a sleep that fails looks again; the wait is bounded",
  "sv_prove:work#2": "returned: sv_why, the smoke workspace unproven: the switch said unproved with the --back command",
  "sv_lacks:awk#1": "closed: `if l_out=$(…)`: else the lack is said as unknown (the report)",
  "sv_lacks:awk#2": "closed: as before it",
  "sv_lacks:awk#3": "closed: as before it",
  "sv_lacks:awk#4": "closed: as before it",
  "sv_head:git#1": "branch: symbolic-ref's status read: 1 tries rev-parse, any other return 1",
  "sv_git_files:find#1": "returned: the function's status (the subshell's last command)",
  "sv_reflogs:find#1": "returned: as before it",
  "sv_finish:work#1": "message: work refresh that fails is said with the command to run (cd <base> && work refresh); the proof after it decides",
  "sv_baseline:sort#1": "returned: the function's status (last of its pipe)",
  "sv_baseline_write:mv#1": "returned: the && return 0 is skipped: sv_why, return 1",
  "sv_baseline_write:rm#1": "cleanup: the scratch record of a write that failed",
  "sv_refs_write:mv#1": "returned: as sv_baseline_write's",
  "sv_refs_write:rm#1": "cleanup: as sv_baseline_write's",
  "sv_said:date#1": "message: the hold's seconds, `?` when the clock does not read",
  "sv_drop:date#2": "message: the drop's seconds",
}

/** The key of each site in VERDICTS: `<function>:<command>#<k>`, the k-th call of that command in that function. */
const verdictKeys = (sites: ReadonlyArray<Site>) => {
  const seen = new Map<string, number>()
  return sites.map((s) => {
    const k = `${s.fn}:${s.command}`
    const n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    return `${k}#${n}`
  })
}

interface Call { readonly id: string; readonly command: string; readonly args: string }
/** The calls a census run logged (`site<TAB>command<TAB>args`; site `-`: a call no site named), in order. */
const loggedCalls = (log: string): ReadonlyArray<Call> =>
  existsSync(log)
    ? textLines(readFileSync(log, "utf8")).map((l) => {
        const [id, command, ...args] = l.split("\t")
        return { id: id!, command: command!, args: args.join("\t") }
      })
    : []

/** Each call's site: the one it named (undefined: a call the table does not name, or names for another command, a finding). */
const siteOf = (sites: ReadonlyArray<Site>, calls: ReadonlyArray<Call>) => {
  const byId = new Map(sites.map((s) => [s.id, s]))
  return calls.map((call) => {
    const site = byId.get(call.id)
    return site?.command === call.command ? site : undefined
  })
}

/**
 * The census's copy of the script: each call site of the table names itself, `CENSUS_SITE=<id> ` before its command
 * (a wrapper's or sv_read's call passes it to the command inside). Line 2 (a comment: no line moves) clears it before
 * every other command (set -T: in every function, substitution and pipe), so a name a function call left behind (bash's
 * POSIX mode keeps it) never reaches a command that is no site: that call logs `-`, a finding.
 */
const instrumented = (dir: string, sites: ReadonlyArray<Site>) => {
  const text = readFileSync(SCRIPT, "utf8").split("\n")
  if (!text[1]!.startsWith("#")) throw new Error(`line 2 of ${SCRIPT} is no comment: ${text[1]}`)
  for (const site of [...sites].sort((a, b) => b.line - a.line || b.col - a.col)) {
    const line = text[site.line - 1]!
    text[site.line - 1] = `${line.slice(0, site.col)}CENSUS_SITE=${site.id} ${line.slice(site.col)}`
  }
  text[1] = `set -T; trap 'case \${FUNCNAME:-} in ${[...Object.keys(WRAPPERS), ...RUNNERS].join("|")}) ;; *) unset CENSUS_SITE ;; esac' DEBUG`
  const path = join(dir, "workrift-census")
  exe(path, text.join("\n"))
  const parsed = Bun.spawnSync(["/bin/sh", "-n", path], { stderr: "pipe" })
  if (parsed.exitCode !== 0) throw new Error(`the census's copy does not parse: ${parsed.stderr.toString()}`)
  return path
}

/** The shims of the census in <bench>/shim: each logs its call with its site and, at the target, fails it or kills workrift. */
const censusShims = (b: Bench) => {
  const dir = join(b.dir, "shim")
  mkdirSync(dir, { recursive: true })
  for (const name of CENSUS_COMMANDS) {
    const real = Bun.which(name, { PATH: `${b.bin}:${process.env.PATH ?? ""}` })
    if (!real) continue
    const code = name === "git" ? 128 : name === "grep" ? 2 : 1
    exe(
      join(dir, name),
      [
        "#!/bin/sh",
        // A stand-in's own commands (CENSUS_IN) are no call of workrift's.
        'if [ -z "${CENSUS_IN:-}" ]; then',
        "  s=${CENSUS_SITE:--}",
        "  unset CENSUS_SITE",
        "  CENSUS_IN=1",
        "  export CENSUS_IN",
        `  printf '%s\\t%s\\t%s\\n' "$s" '${name}' "$(printf '%s' "$*" | /usr/bin/tr '\\n\\t' '  ')" >>"$CENSUS_LOG"`,
        // The site's first call only.
        `  if [ "$s" = "\${CENSUS_AT:-}" ] && [ ! -e "$CENSUS_LOG.hit" ]; then`,
        `    printf '%s\\n' "$s" >"$CENSUS_LOG.hit"`,
        '    case "$CENSUS_MODE" in',
        `      fail) printf 'census: ${name} failed (injected at %s)\\n' "$s" >&2; exit ${code} ;;`,
        '      kill) kill -KILL "$(/bin/cat "$CENSUS_PIDFILE")" 2>/dev/null || true ;;',
        "    esac",
        "  fi",
        "fi",
        `exec '${real}' "$@"`,
        "",
      ].join("\n"),
    )
  }
  return dir
}

/** The three facts every end but a success says: what happened, the state both trees are in, the command that goes on. */
const hasFacts = (err: string) => /^workrift: /m.test(err) && /^workrift subvolume: state: /m.test(err) && /^workrift subvolume: next: /m.test(err)

describe("workrift subvolume: the call sites of the census", () => {
  test("every call site has its verdict: what a failure there becomes, and every verdict names a site", () => {
    const sites = callSites(readFileSync(SCRIPT, "utf8"))
    const keys = verdictKeys(sites)
    const rows = sites.map((site, i) => ({ key: keys[i]!, ...site, verdict: VERDICTS[keys[i]!] ?? autoVerdict(site) }))
    if (process.env.CENSUS_TABLE) writeFileSync(process.env.CENSUS_TABLE, JSON.stringify(rows, null, 1))
    expect(rows.filter((r) => r.verdict === undefined).map((r) => `${r.key} (${r.id}): ${r.text}`), "sites with no verdict").toEqual([])
    const named = new Set(rows.map((r) => r.key))
    expect(Object.keys(VERDICTS).filter((k) => !named.has(k)), "verdicts that name no site").toEqual([])
    expect(rows.every((r) => /^(stops|returned|closed|branch|message|cleanup|unreachable): /.test(r.verdict!))).toBe(true)
  })

  test("the table names every call a forward, a --back and a --drop-old make, and each such call maps to one site", async () => {
    const sites = callSites(readFileSync(SCRIPT, "utf8"))
    expect(new Set(sites.map((s) => s.id)).size).toBe(sites.length)
    const b = bench("sites")
    const script = instrumented(b.dir, sites)
    const shims = censusShims(b)
    const log = join(b.dir, "census.calls")
    for (const argv of [["subvolume", "--apply"], ["subvolume", "--back", "--apply"], ["subvolume", "--drop-old", "--apply"]]) {
      const ran = Bun.spawnSync([script, ...argv], { cwd: b.dir, env: b.envFor({ PATH: `${shims}:${b.env.PATH}`, WORK: join(shims, "work"), CENSUS_LOG: log }), stdout: "pipe", stderr: "pipe" })
      expect(ran.exitCode, `${argv.join(" ")}: ${ran.stderr.toString()}`).toBe(0)
    }
    const calls = loggedCalls(log)
    const mapped = siteOf(sites, calls)
    const outside = calls.filter((_c, i) => mapped[i] === undefined).map((c) => `${c.id} ${c.command} ${c.args.slice(0, 80)}`)
    expect(outside, "calls no site of the table names").toEqual([])
    expect(calls.length).toBeGreaterThan(100)
  }, 120_000)
})

/**
 * The census (WORKRIFT_CENSUS=<scenario>, run by hand, not in the gate): every call site of the table (callSites) that
 * the scenario's command reaches, one case each, addressed by the name the census's copy gives the site
 * (`<line>:<command>#<k>`, the k-th of that command on that line; never a running number). In `fail` mode the site's first call fails (exit 1; git 128, grep 2: a fork that failed, a
 * full disk, a lock taken); in `kill` mode it first kills the workrift process alone (kill -9), and the call goes on.
 * Each case checks the injection hit its site, the trees are whole with every ref, every end but a success and a cut
 * says the three facts (what happened, the state, the next command), and the commands that finish from there finish.
 * CENSUS_OUT (a .jsonl) gets one line a case; <CENSUS_OUT>.coverage.json the table, the sites reached and the calls no
 * site names. CENSUS_ONLY (site ids, comma-separated) picks cases. The full stderr of every command of a case goes to
 * <bench>/case.log, and the bench is kept when the case fails a check.
 */
describe.skipIf(!process.env.WORKRIFT_CENSUS)("census: a failure or a kill at every call site", () => {
  const scenario = process.env.WORKRIFT_CENSUS ?? ""
  type Step = { readonly argv: ReadonlyArray<string>; readonly env?: Env; readonly code: number | null }
  type Settle = "S" | "F" | "drop" | "refused"
  interface Plan {
    readonly mode: "fail" | "kill"
    readonly before: ReadonlyArray<Step>
    readonly setup?: (b: Bench) => void
    readonly env?: Env
    readonly argv: ReadonlyArray<string>
    readonly settle: Settle
  }
  const fwd: Step = { argv: ["subvolume", "--apply"], code: 0 }
  const back: Step = { argv: ["subvolume", "--back", "--apply"], code: 0 }
  const cutBack: Step = { argv: ["subvolume", "--back", "--apply"], env: { WORKRIFT_SUBVOLUME_DIE_AT: "carry-wait" }, code: null }
  const drop: Step = { argv: ["subvolume", "--drop-old", "--apply"], code: 0 }
  /** Every preflight refusal at once: removals of this base and of another, an older workrift, a process in the base, a Git lock, no slack, no room, no user_subvol_rm_allowed. */
  const refusing = (b: Bench) => {
    b.processAt(91001, b.base)
    b.processAt(91002, b.dir, ["work", "rm", "lane"])
    writeFileSync(join(b.proc, "91002", "environ"), `WORKRIFT_SOURCE=${b.base}\0`)
    b.processAt(91003, "/nonexistent/census-other", ["work", "rm", "other"])
    b.processAt(91004, b.dir, ["/bin/sh", "/nonexistent/census/workrift", "create", "old"])
    writeFileSync(join(b.base, ".git", "index.lock"), "")
    writeFileSync(join(b.sys, UUID, "allocation/metadata/bytes_used"), `${57 * 2 ** 30 - 1}\n`)
  }
  const refusingEnv: Env = { FAKE_DF_AVAIL: "10", FAKE_DF_PCT: "99", FAKE_MOUNT_OPTIONS: "rw,noatime" }
  /** A ref to change on both sides: census-both, at feat-a in the base before the switch. */
  const carrying = (b: Bench) => {
    sh(b.base, b.env, "git", "update-ref", "refs/heads/census-both", "refs/heads/feat-a")
  }
  /**
   * Once, at carry-wait: the tree at .old gains census-new (to carry) and moves census-both, which the base deletes
   * (changed on both sides: kept under refs/subvolume-move/). The carry's every call is then a site the census reaches.
   */
  const carryEnv: Env = {
    WORKRIFT_SUBVOLUME_HOOK_AT: "carry-wait",
    WORKRIFT_SUBVOLUME_HOOK: [
      'm="${WORKRIFT_SOURCE%/*}/census-carry-done"; [ ! -e "$m" ] || exit 0; : >"$m"',
      'o="${WORKRIFT_SOURCE%/*}/.subvolume-move/${WORKRIFT_SOURCE##*/}.old"',
      'git -C "$o" update-ref refs/heads/census-new "$(git -C "$o" rev-parse refs/heads/feat-a)"',
      'git -C "$o" update-ref refs/heads/census-both HEAD',
      'git -C "$WORKRIFT_SOURCE" update-ref -d refs/heads/census-both',
    ].join("; "),
  }
  const plans: Record<string, Plan> = {
    fwd: { mode: "fail", before: [], argv: fwd.argv, settle: "S" },
    back: { mode: "fail", before: [fwd], argv: back.argv, settle: "F" },
    // The r2 failure's history: forward, a --back cut at carry-wait, the --back again, then the forward under census.
    "cut-fwd": { mode: "fail", before: [fwd, cutBack, back], argv: fwd.argv, settle: "S" },
    // The --back itself after its cut at carry-wait, under census.
    "cut-back": { mode: "fail", before: [fwd, cutBack], argv: back.argv, settle: "F" },
    // A --back with no kept tree: the copy into .back, the rm of a folder copy.
    "back-copy": { mode: "fail", before: [fwd, drop], argv: back.argv, settle: "F" },
    drop: { mode: "fail", before: [fwd], argv: drop.argv, settle: "drop" },
    refused: { mode: "fail", before: [], setup: refusing, argv: fwd.argv, settle: "refused" },
    // A forward whose kept tree gains refs while the switch waits: the carry moves one and keeps one.
    carry: { mode: "fail", before: [], setup: carrying, env: carryEnv, argv: fwd.argv, settle: "S" },
    "kill-carry": { mode: "kill", before: [], setup: carrying, env: carryEnv, argv: fwd.argv, settle: "S" },
    "kill-back": { mode: "kill", before: [fwd], argv: back.argv, settle: "F" },
    "kill-fwd": { mode: "kill", before: [], argv: fwd.argv, settle: "S" },
    "kill-back-copy": { mode: "kill", before: [fwd, drop], argv: back.argv, settle: "F" },
    "kill-drop": { mode: "kill", before: [fwd], argv: drop.argv, settle: "drop" },
  }
  const plan = plans[scenario]
  const end = (ran: Ran) =>
    ran.signal ? "cut" : ran.code === 0 ? "ok" : /and no message \(a command failed under set -e\)/.test(ran.err) ? "set-e" : /^workrift: /m.test(ran.err) ? "refused" : "other"
  const lastSaid = (ran: Ran) => textLines(ran.err).filter((l) => /^(workrift|census|fatal|error):? /.test(l) && !/^workrift subvolume: (state|next): /.test(l)).slice(-2).join(" | ").slice(0, 300)

  test(`census ${scenario}`, async () => {
    if (!plan) throw new Error(`WORKRIFT_CENSUS=${scenario}: one of ${Object.keys(plans).join(", ")}`)
    const sites = callSites(readFileSync(SCRIPT, "utf8"))
    const planEnv: Env = plan.env ?? (plan.setup === refusing ? refusingEnv : {})
    /** One command: plain, or instrumented with the site `at` failed or killed (none: only logged). */
    const run = async (b: Bench, argv: ReadonlyArray<string>, census?: { readonly log: string; readonly at?: { readonly site: Site; readonly call: Call } }, extra: Env = {}) => {
      const pidfile = join(b.dir, "census.pid")
      const shims = census ? censusShims(b) : ""
      const script = census ? instrumented(b.dir, sites) : SCRIPT
      const runEnv = b.envFor({
        ...planEnv,
        ...extra,
        ...(census
          ? {
              PATH: `${shims}:${b.env.PATH}`,
              WORK: join(shims, "work"),
              CENSUS_LOG: census.log,
              CENSUS_MODE: plan.mode,
              CENSUS_PIDFILE: pidfile,
              ...(census.at ? { CENSUS_AT: census.at.site.id } : {}),
            }
          : {}),
      })
      // The pid is the script's own (exec), for a kill of it alone.
      const child = Bun.spawn(["/bin/sh", "-c", 'printf "%s\\n" "$$" >"$0.pid"; exec "$@"', join(b.dir, "census"), script, ...argv], { cwd: b.dir, env: runEnv, stdout: "pipe", stderr: "pipe" })
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      await child.exited
      const ran: Ran = { code: child.signalCode ? null : child.exitCode, signal: child.signalCode ?? null, out, err }
      writeFileSync(join(b.dir, "case.log"), `$ workrift ${argv.join(" ")}${census?.at ? ` (census ${plan.mode} at ${census.at.site.id})` : ""}\n${said(ran)}\n`, { flag: "a" })
      // A cut run's children (the call that killed it) end before anything is read.
      if (ran.signal) await Bun.sleep(300)
      return ran
    }
    const prepare = async (label: string) => {
      const b = bench(label)
      for (const step of plan.before) {
        const ran = await run(b, step.argv, undefined, step.env)
        expect(ran.code, `${label} before: ${step.argv.join(" ")}: ${said(ran)}`).toBe(step.code)
      }
      plan.setup?.(b)
      return b
    }
    // The count: the command once, every call logged with its site.
    const counted = await prepare("census-count")
    const countLog = join(counted.dir, "census.calls")
    const first = await run(counted, plan.argv, { log: countLog })
    expect(first.code, said(first)).toBe(plan.settle === "refused" ? 1 : 0)
    const calls = loggedCalls(countLog)
    const mapped = siteOf(sites, calls)
    const outside = calls.flatMap((c, i) => (mapped[i] === undefined ? [`${c.id} ${c.command} ${c.args.slice(0, 100)}`] : []))
    // Each site's first call.
    const targets = new Map<string, { readonly site: Site; readonly call: Call }>()
    calls.forEach((call, i) => {
      const site = mapped[i]
      if (site && !targets.has(site.id)) targets.set(site.id, { site, call })
    })
    const out = process.env.CENSUS_OUT ?? join(scratch, `census-${scenario}.jsonl`)
    writeFileSync(`${out}.coverage.json`, JSON.stringify({ scenario, mode: plan.mode, table: sites.length, calls: calls.length, reached: [...targets.keys()], outside }, null, 1))
    const only = process.env.CENSUS_ONLY?.split(",")
    const cases = [...targets.values()].filter((t) => !only || only.includes(t.site.id))
    console.log(`census ${scenario} (${plan.mode}): ${calls.length} calls, ${targets.size} of ${sites.length} sites reached, ${outside.length} calls outside the table; ${cases.length} cases; results in ${out}`)
    const bad: Array<string> = outside.map((o) => `a call no site names: ${o}`)
    await pool(
      cases.map((target) => async () => {
        const b = await prepare(`census-${target.site.line}-${target.site.command}-${target.site.ordinal}`)
        const log = join(b.dir, "census.calls")
        const ran = await run(b, plan.argv, { log, at: target })
        const problems: Array<string> = []
        const check = (what: string, f: () => void) => {
          try {
            f()
          } catch (error) {
            problems.push(`${what}: ${String(error).split("\n").slice(0, 3).join(" ")}`)
          }
        }
        const runs: Array<[string, Ran]> = [["under census", ran]]
        check("the injection hit its site", () => expect(existsSync(`${log}.hit`) ? readFileSync(`${log}.hit`, "utf8").trim() : "(not hit)").toBe(target.site.id))
        check("whole after", () => {
          expect(["F", "S"]).toContain(b.kind(b.base))
          whole(b)
        })
        const result: Record<string, unknown> = { site: target.site.id, fn: target.site.fn, call: `${target.site.command} ${target.call.args}`.slice(0, 160), end: end(ran), said: lastSaid(ran), layout: b.layout() }
        const forward = plan.settle === "S"
        // After a kill, the other direction is refused or runs (never stops without its facts).
        if (plan.mode === "kill") {
          const other = await run(b, plan.settle === "S" ? back.argv : fwd.argv)
          runs.push(["the other way after the kill", other])
          result.other = { end: end(other), said: lastSaid(other) }
          check("other after the kill", () => expect(["ok", "refused"]).toContain(end(other)))
          check("whole after other", () => whole(b))
        }
        const again = await run(b, plan.argv)
        runs.push(["again", again])
        result.again = { end: end(again), said: lastSaid(again) }
        if (plan.settle === "refused") {
          check("again refused", () => expect(again.code, said(again)).toBe(1))
          check("layout again", () => expect(b.layout()).toEqual({ base: "F", new: "-", back: "-", old: "-" }))
          check("whole again", () => whole(b))
        } else if (plan.settle === "drop") {
          check("again", () => expect(again.code, said(again)).toBe(0))
          check("layout again", () => expect(b.layout()).toEqual({ base: "S", new: "-", back: "-", old: "-" }))
          check("whole again", () => whole(b))
          const way = await run(b, back.argv)
          runs.push(["back", way])
          check("back after the drop", () => expect(way.code, said(way)).toBe(0))
          check("whole at the end", () => whole(b))
        } else {
          check("again", () => expect(again.code, said(again)).toBe(0))
          check("layout again", () => expect(b.layout()).toEqual(forward ? { base: "S", new: "-", back: "-", old: "F" } : { base: "F", new: "-", back: "-", old: "S" }))
          check("whole again", () => {
            whole(b)
            whole(b, b.paths.old)
          })
          const way = await run(b, forward ? back.argv : fwd.argv)
          runs.push(["the other way", way])
          check("the other way", () => expect(way.code, said(way)).toBe(0))
          const and = await run(b, plan.argv)
          runs.push(["and again", and])
          check("and again", () => expect(and.code, said(and)).toBe(0))
          check("whole at the end", () => {
            whole(b)
            whole(b, b.paths.old)
          })
        }
        // No end but a success or a cut goes without the three facts.
        for (const [what, r] of runs) if (r.code !== 0 && !r.signal) check(`the three facts (${what})`, () => expect(hasFacts(r.err), r.err).toBe(true))
        result.problems = problems
        appendFileSync(out, `${JSON.stringify(result)}\n`)
        if (problems.length > 0) bad.push(`site ${target.site.id} (${target.site.fn}: ${target.site.text.slice(0, 60)}): ${problems.join("; ")} [bench ${b.dir}]`)
        else rmSync(b.dir, { recursive: true, force: true })
      }),
    )
    expect(bad, bad.join("\n")).toEqual([])
  }, 7_200_000)
})

