// `workrift subvolume`: the real script on stand-ins, on the Mac. A base is a btrfs subvolume here when its inode is
// in the bench's registry (inodes follow a folder through renames and exchanges, as a subvolume's root does): `stat`
// answers btrfs for every path under the bench, and inode 256 for a registered one; `btrfs` makes, snapshots and
// deletes registered folders; `work` is a stand-in that snapshots a registered base and copies any other; `python3`
// is the real one (renamex_np's RENAME_SWAP stands for renameat2's RENAME_EXCHANGE), with hooks around an exchange
// for the writers of the model (move.qnt); `cp -a --reflink=always` is BSD cp, slowed, failed or killed on request;
// `findmnt`, `df` and /sys/fs/btrfs are files of the bench; /proc is a folder of the bench. Nothing touches the host.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repo = join(import.meta.dir, "..", "..")
const SCRIPT = process.env.WORKRIFT_SCRIPT ?? join(repo, "workbox/bin/workrift")
const PYTHON = Bun.which("python3") ?? "/usr/bin/python3"
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "workrift-subvolume-")))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
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

/** git, logging each call (FAKE_GIT_LOG) when asked. */
const GIT_REAL = Bun.which("git") ?? "/usr/bin/git"
const GIT = ["#!/bin/sh", '[ -z "${FAKE_GIT_LOG:-}" ] || printf "%s\\n" "$*" >>"$FAKE_GIT_LOG"', `exec '${GIT_REAL}' "$@"`, ""].join("\n")

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
  /** Runs workrift in the bench's folder (outside the base). */
  const wr = (argv: ReadonlyArray<string>, extra: Env = {}): Ran => {
    const ran = Bun.spawnSync([SCRIPT, ...argv], { cwd: dir, env: envFor(extra), stdout: "pipe", stderr: "pipe" })
    return { code: ran.exitCode, signal: ran.signalCode ?? null, out: ran.stdout.toString(), err: ran.stderr.toString() }
  }
  /** The same, without blocking: cases run side by side. */
  const wrAsync = async (argv: ReadonlyArray<string>, extra: Env = {}): Promise<Ran> => {
    const child = Bun.spawn([SCRIPT, ...argv], { cwd: dir, env: envFor(extra), stdout: "pipe", stderr: "pipe" })
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    await child.exited
    return { code: child.signalCode ? null : child.exitCode, signal: child.signalCode ?? null, out, err }
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
        await task().catch((error: unknown) => failures.push(error))
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
  })

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
  })

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

  test("the carry waits for a process still in the old tree; one that stays past the wait rolls the switch back, whole", async () => {
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
    expect(ran2.err).toContain("rolled back")
    expect(c.layout()).toEqual({ base: "F", new: "-", back: "-", old: "-" })
    whole(c)
    expect(c.phase()).toBe("")
  }, 60_000)
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

/** Faults that fail a step under the hold: each rolls back to the folder base, whole, with no copy left. */
const FAULTS: ReadonlyArray<{ readonly what: string; readonly env: Env; readonly says: string }> = [
  { what: "subvolume create fails", env: { FAKE_BTRFS_FAIL: "subvolume create" }, says: "btrfs subvolume create" },
  { what: "disk full in the copy", env: { FAKE_CP: "enospc" }, says: "full disk or metadata space" },
  { what: "the exchange fails", env: { FAKE_EXCHANGE_FAIL: "1" }, says: "the exchange failed" },
  { what: "the smoke workspace is no snapshot", env: { FAKE_SMOKE_CLONER: "reflink" }, says: "not a btrfs snapshot" },
  { what: "the hold takes too long", env: { WORKRIFT_SUBVOLUME_LIMIT: "-1" }, says: "took more than -1 s" },
]

describe("workrift subvolume: failure and kill at every step", () => {
  test("a failure at each step rolls back: the folder base at its path, whole, no copy left, no phase; a rerun without the fault converts", () => {
    for (const fault of FAULTS) {
      const b = bench("fault")
      const ran = b.wr(["subvolume", "--apply"], fault.env)
      expect({ what: fault.what, code: ran.code, rolled: ran.err.includes("rolled back"), says: ran.err.includes(fault.says) }, said(ran)).toEqual({
        what: fault.what,
        code: 1,
        rolled: true,
        says: true,
      })
      expect(b.layout(), fault.what).toEqual({ base: "F", new: "-", back: "-", old: "-" })
      whole(b)
      expect(b.phase(), fault.what).toBe("")
      const again = b.wr(["subvolume", "--apply"])
      expect(again.code, said(again)).toBe(0)
      converted(b)
    }
  }, 120_000)

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
    const failing = bench("steps-rb")
    expect(failing.wr(["subvolume", "--apply"], { FAKE_SMOKE_CLONER: "reflink" }).code).toBe(1)
    const rollback = failing.steps().filter((s) => !forward.includes(s) || s.startsWith("rollback") || s === "drop-copy")
    expect(rollback).toEqual(expect.arrayContaining(["rollback", "rollback-exchange", "rollback-park", "drop-copy", "rolled-back"]))
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
      const ran = await b.wrAsync(["subvolume", "--apply"], { FAKE_SMOKE_CLONER: "reflink", WORKRIFT_SUBVOLUME_DIE_AT: step })
      expect(ran.signal, `${step}: ${said(ran)}`).toBe("SIGKILL")
      kills++
      invariant(b, `rollback ${step}`)
      // The fault still there: the rerun finishes the rollback; then, without it, a run converts.
      const finish = await b.wrAsync(["subvolume", "--apply"], { FAKE_SMOKE_CLONER: "reflink" })
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
    expect(again.err).toContain("its copy is dropped and the switch starts again")
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

describe("workrift subvolume --back and --drop-old", () => {
  /** forward, back (exchange), forward (exchange), drop the folder, back (copy into a folder), drop the subvolume. */
  const sequence = async (b: Bench, die: { readonly at: number; readonly step: string } | undefined) => {
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
    for (const [i, argv] of argvs.entries()) {
      if (die?.at === i) {
        const cut = await b.wrAsync(argv, { WORKRIFT_SUBVOLUME_DIE_AT: die.step })
        expect(cut.signal, `${argv.join(" ")} cut at ${die.step}: ${said(cut)}`).toBe("SIGKILL")
        expect(["F", "S"]).toContain(b.kind(b.base))
        whole(b)
      }
      const ran = await b.wrAsync(argv)
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
    await pool(cuts.map((die) => () => sequence(bench(`seq-${die.at}-${die.step}`), die)))
    expect(cuts.length).toBeGreaterThan(25)
  }, 900_000)

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
