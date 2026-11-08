#!/usr/bin/env bun
// What removing a folder of APFS clones would free, rather than what `du` says.
//
// A Rift (`rift create --copy-all`), bun's node_modules and uv environments are
// clonefile copies: their blocks are shared with the source until a file is
// written. `du` counts every clone in full, so removing a 15 GiB Rift can free
// almost nothing. On APFS each file reports the bytes no other file shares
// (ATTR_CMNEXT_PRIVATESIZE) and its clone family with the family's size
// (ATTR_CMNEXT_CLONEID, ATTR_CMNEXT_CLONE_REFCNT). A folder frees its private
// bytes, plus the shared bytes of every family that lies wholly inside it.
// Measured against df on a 4.0 GiB (du) clone with 1.56 GiB written into it:
// estimate 1.563 GiB, df freed 1.562 GiB.
//
// Elsewhere (Linux, a volume that is not APFS) a Rift falls back to the files
// written since its marker, which overcounts a file only partly rewritten;
// other folders fall back to `du`.
//
// Usage: bun clone-size.ts [--since <ms>] <path...>   prints one Part as JSON (for the survey's pool)

import { dlopen, FFIType } from 'bun:ffi';
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type Method = 'apfs' | 'mtime' | 'du';
export type Size = { own: number; du: number; method: Method };
/** One regular file: allocated bytes, bytes it shares with no file, and its clone family. */
export type Entry = { alloc: number; priv: number; family: bigint; refs: number };
/** A share of the files measured: families not yet whole are kept as [id, seen, refs, shared] to merge. */
export type Part = Size & { families: [string, number, number, number][] };

const WORST: Method[] = ['apfs', 'mtime', 'du'];

/** The bytes removing all the files of these parts frees: private bytes, plus each clone family held only by them. */
export function merge(parts: Part[]): Size {
  let own = 0;
  let du = 0;
  let method: Method = 'apfs';
  const families = new Map<string, { seen: number; refs: number; shared: number }>();
  for (const p of parts) {
    own += p.own;
    du += p.du;
    if (WORST.indexOf(p.method) > WORST.indexOf(method)) method = p.method;
    for (const [id, seen, refs, shared] of p.families) {
      const f = families.get(id);
      if (f) {
        f.seen += seen;
        f.shared = Math.max(f.shared, shared);
      } else families.set(id, { seen, refs, shared });
    }
  }
  for (const f of families.values()) if (f.seen >= f.refs) own += f.shared;
  return { own, du, method };
}

/** Tally entries into a part; a family whole inside it counts at once, the rest wait for a merge. */
export function partOf(entries: Iterable<Entry>): Part {
  const t = tally();
  for (const e of entries) t.add(e);
  return t.part();
}

function tally() {
  let own = 0;
  let du = 0;
  const families = new Map<bigint, { seen: number; refs: number; shared: number }>();
  return {
    add(e: Entry) {
      du += e.alloc;
      own += e.priv;
      if (e.refs <= 1) return;
      const f = families.get(e.family);
      if (f) {
        f.seen += 1;
        f.shared = Math.max(f.shared, e.alloc - e.priv);
      } else families.set(e.family, { seen: 1, refs: e.refs, shared: e.alloc - e.priv });
    },
    part(): Part {
      let whole = 0;
      const open: Part['families'] = [];
      for (const [id, f] of families) {
        if (f.seen >= f.refs) whole += f.shared;
        else if (f.shared > 0) open.push([id.toString(), f.seen, f.refs, f.shared]);
      }
      return { own: own + whole, du, method: 'apfs', families: open };
    },
  };
}

// ── APFS: getattrlistbulk, one call per directory chunk ──
const O_DIRECTORY = 0x100000;
const O_CLOEXEC = 0x1000000;
const FSOPT_NOFOLLOW = 0x1;
const FSOPT_PACK_INVAL_ATTRS = 0x8;
const FSOPT_ATTR_CMN_EXTENDED = 0x20;
const ATTR_CMN_RETURNED_ATTRS = 0x80000000;
const ATTR_CMN_NAME = 0x1;
const ATTR_CMN_OBJTYPE = 0x8;
const ATTR_FILE_ALLOCSIZE = 0x4;
const ATTR_CMNEXT_PRIVATESIZE = 0x8;
const ATTR_CMNEXT_CLONEID = 0x100;
const ATTR_CMNEXT_CLONE_REFCNT = 0x1000;
const VREG = 1;
const VDIR = 2;

type Apfs = { walk: (path: string, add: (e: Entry) => void) => boolean };
let apfs: Apfs | null | undefined;

function loadApfs(): Apfs | null {
  if (process.platform !== 'darwin') return null;
  try {
    const lib = dlopen('/usr/lib/libSystem.B.dylib', {
      open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      getattrlist: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32], returns: FFIType.i32 },
      getattrlistbulk: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    }).symbols;
    // Buffers go to the calls as typed arrays, not raw pointers, so nothing frees them mid-call.
    const attrs = (name: boolean) => {
      const list = new Uint8Array(24);
      const v = new DataView(list.buffer);
      v.setUint16(0, 5, true);
      v.setUint32(4, ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_OBJTYPE | (name ? ATTR_CMN_NAME : 0), true);
      v.setUint32(16, ATTR_FILE_ALLOCSIZE, true);
      v.setUint32(20, ATTR_CMNEXT_PRIVATESIZE | ATTR_CMNEXT_CLONEID | ATTR_CMNEXT_CLONE_REFCNT, true);
      return list;
    };
    const bulkList = attrs(true);
    const oneList = attrs(false);
    const SIZE = 256 * 1024;
    const buf = new Uint8Array(SIZE);
    const view = new DataView(buf.buffer);
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const cstr = (s: string) => enc.encode(`${s}\0`);
    // An entry: u32 length, attribute_set_t returned (20 bytes), [name ref (8)], objtype, alloc, private, clone id, refcount.
    // A volume without clone tracking returns no private size: the file then counts as its own.
    const entry = (at: number, base: number): Entry => {
      const alloc = Number(view.getBigInt64(base + 4, true));
      const returned = view.getUint32(at + 20, true);
      if (!(returned & ATTR_CMNEXT_PRIVATESIZE)) return { alloc, priv: alloc, family: 0n, refs: 1 };
      const refs = returned & ATTR_CMNEXT_CLONE_REFCNT ? view.getUint32(base + 28, true) : 1;
      return { alloc, priv: Number(view.getBigInt64(base + 12, true)), family: view.getBigUint64(base + 20, true), refs };
    };
    const walkDir = (dir: string, add: (e: Entry) => void) => {
      const fd = lib.open(cstr(dir), O_DIRECTORY | O_CLOEXEC);
      if (fd < 0) return;
      const subdirs: string[] = [];
      for (;;) {
        const n = lib.getattrlistbulk(fd, bulkList, buf, SIZE, FSOPT_ATTR_CMN_EXTENDED | FSOPT_PACK_INVAL_ATTRS);
        if (n <= 0) break;
        for (let i = 0, at = 0; i < n; i++) {
          const length = view.getUint32(at, true);
          const type = view.getUint32(at + 32, true);
          if (type === VDIR) {
            const name = at + 24 + view.getInt32(at + 24, true);
            subdirs.push(join(dir, dec.decode(buf.subarray(name, name + view.getUint32(at + 28, true) - 1))));
          } else if (type === VREG) add(entry(at, at + 32));
          at += length;
        }
      }
      lib.close(fd);
      for (const sub of subdirs) walkDir(sub, add);
    };
    return {
      walk(path, add) {
        const s = lstatSync(path, { throwIfNoEntry: false });
        if (!s) return true;
        if (s.isDirectory()) walkDir(path, add);
        else if (s.isFile()) {
          if (lib.getattrlist(cstr(path), oneList, buf, SIZE, FSOPT_ATTR_CMN_EXTENDED | FSOPT_PACK_INVAL_ATTRS | FSOPT_NOFOLLOW) !== 0) return false;
          add(entry(0, 24));
        }
        return true;
      },
    };
  } catch {
    return null;
  }
}

// ── Fallback: walk with lstat ──
function walkStat(path: string, visit: (bytes: number, mtimeMs: number) => void) {
  const s = lstatSync(path, { throwIfNoEntry: false });
  if (!s) return;
  if (s.isFile()) visit(s.blocks * 512, s.mtimeMs);
  if (!s.isDirectory()) return;
  let names: string[] = [];
  try {
    names = readdirSync(path);
  } catch {}
  for (const name of names) walkStat(join(path, name), visit);
}

type Opts = { since?: number; method?: Method };

/**
 * Measure a set of paths that may be clones, as a part to merge with others.
 * `since`: when the copy was made (a Rift's marker), for the fallback: files written later are its own.
 * `method`: force one way of measuring (tests); by default APFS where it works.
 */
export function measure(paths: string[], opts: Opts = {}): Part {
  apfs ??= loadApfs();
  const method = opts.method ?? (apfs ? 'apfs' : opts.since === undefined ? 'du' : 'mtime');
  if (method === 'apfs') {
    const fs = apfs;
    if (fs) {
      const t = tally();
      if (paths.every((p) => fs.walk(p, t.add))) return t.part();
    }
    return measure(paths, { ...opts, method: opts.since === undefined ? 'du' : 'mtime' });
  }
  let own = 0;
  let du = 0;
  for (const p of paths)
    walkStat(p, (bytes, mtimeMs) => {
      du += bytes;
      if (method === 'du' || mtimeMs > (opts.since ?? 0)) own += bytes;
    });
  return { own, du, method, families: [] };
}

/** Size a set of paths that may be clones, in this process. */
export const cloneSize = (paths: string[], opts: Opts = {}): Size => merge([measure(paths, opts)]);

/**
 * Size many sets at once: each job's units are measured in child processes, `jobs` at a time
 * (the walk is kernel-bound, and parallel walks of one volume run about 3x faster on four),
 * then merged per job, so a clone family split across units still counts once.
 */
export async function cloneSizes(work: { units: string[][]; since?: number }[], jobs: number): Promise<Size[]> {
  const tasks = work.flatMap((w, job) => w.units.map((paths) => ({ job, paths, since: w.since })));
  const parts: Part[][] = work.map(() => []);
  let next = 0;
  const run = async () => {
    while (next < tasks.length) {
      const t = tasks[next++]!;
      const child = Bun.spawn(['bun', import.meta.path, ...(t.since === undefined ? [] : ['--since', String(t.since)]), ...t.paths], { stdout: 'pipe', stderr: 'ignore' });
      const out = await new Response(child.stdout).text();
      await child.exited;
      try {
        parts[t.job]!.push(JSON.parse(out) as Part);
      } catch {
        parts[t.job]!.push(measure(t.paths, { since: t.since }));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, run));
  return parts.map(merge);
}

/** Split a folder of folders (a Rift trash) into `n` units, round-robin, for `cloneSizes`. */
export function split(dir: string, n: number): string[][] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {}
  const units: string[][] = Array.from({ length: Math.max(1, Math.min(n, names.length)) }, () => []);
  names.forEach((name, i) => units[i % units.length]!.push(join(dir, name)));
  return units;
}

/** When a Rift was made: the mtime of its `.rift` marker, or undefined when the folder has none. */
export function riftSince(dir: string): number | undefined {
  try {
    const marker = statSync(join(dir, '.rift'));
    return marker.isFile() ? marker.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--since');
  const since = at >= 0 ? Number(args.splice(at, 2)[1]) : undefined;
  console.log(JSON.stringify(measure(args, { since })));
}
