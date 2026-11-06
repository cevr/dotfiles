#!/usr/bin/env python3
"""Symbolize a strobe deep recording of a compiled Bun binary (opencode) with Bun's -profile build.

A `bun build --compile` executable shares its .text with the release Bun of the same version, and
the release's `bun-linux-x64-profile.zip` keeps the symbols (same GNU build id). strobe 0.14 reads
only the target's own symbols, so its hotspots show 0.2% resolved; this resolves the rest.

Usage: strobe-symbolize.py <recording dir> <bun-profile binary> [--pid N] [--thread <name>] [--top N]
`record pid:` samples the whole process tree; --pid keeps one process (default: the recorded pid).
JIT frames (JS code JSC compiled) have no symbols; they show as [JIT], and each JIT-leaf sample is
also attributed to its nearest native frame below the JIT run ("entered from").
"""
import bisect, collections, gzip, json, os, subprocess, sys

args = sys.argv[1:]
rec, profile = args[0], args[1]
opt = lambda name, default=None: args[args.index(name) + 1] if name in args else default
thread_filter = opt("--thread")
top = int(opt("--top", "30"))

cache = profile + ".nm"
if not os.path.exists(cache):
    out = subprocess.run(["nm", "-C", "--defined-only", "-n", profile], capture_output=True, text=True).stdout
    with open(cache, "w") as f:
        f.write(out)
addrs, names = [], []
for line in open(cache):
    parts = line.rstrip("\n").split(" ", 2)
    if len(parts) == 3 and parts[1] in "tTwW":
        addrs.append(int(parts[0], 16))
        names.append(parts[2])

meta = json.load(open(os.path.join(rec, "meta.json")))
pid = int(opt("--pid", meta["pid"]))
d = json.load(gzip.open(os.path.join(rec, "deep.json.gz")))
mods = [(m["base"], m["base"] + m["size"], os.path.basename(m["path"])) for m in d["modules"] if m["pid"] == pid]
bun_mod = [m for m in mods if m[2].startswith("opencode-")]


def sym(a):
    for lo, hi, n in bun_mod:
        if lo <= a < hi:
            # non-PIE (both the compiled binary and bun-profile link .text at the same address)
            i = bisect.bisect_right(addrs, a) - 1
            return names[i][:140] if i >= 0 else "?"
    for lo, hi, n in mods:
        if lo <= a < hi:
            return f"<{n}>"
    return "[JIT]"


threads = d["threads"]
self_c, incl_c, entry_c, thr_c = collections.Counter(), collections.Counter(), collections.Counter(), collections.Counter()
total = mine = 0
for s in d["samples"]:
    if s[1] != pid:
        continue
    mine += 1
    tid = str(s[2])
    tname = threads.get(tid, "main" if s[2] == pid else "tid")
    thr_c[tname] += 1
    if thread_filter and tname != thread_filter:
        continue
    total += 1
    st = [sym(a) for a in d["stacks"][s[4]]]
    self_c[st[0]] += 1
    for n in set(st):
        incl_c[n] += 1
    if st[0] == "[JIT]":
        j = 0
        while j < len(st) and st[j] == "[JIT]":
            j += 1
        entry_c[st[j] if j < len(st) else "(top)"] += 1

secs = (d["t1_ns"] - d["t0_ns"]) / 1e9
others = collections.Counter(s[1] for s in d["samples"] if s[1] != pid)
print(f"recording {os.path.basename(rec)} · {secs:.0f}s · pid {pid}: {mine} samples ({mine/secs/1000:.2f} cores)"
      f" · other pids in the tree: {sum(others.values())} samples over {len(others)} pids")
print("threads (samples = ms of CPU):")
for n, c in thr_c.most_common(12):
    print(f"  {c:7d}  {100*c/max(mine,1):5.1f}%  {n}")
print(f"\n-- self ({thread_filter or 'all threads'}, {total} samples)")
for n, c in self_c.most_common(top):
    print(f"  {c:7d}  {100*c/total:5.1f}%  {n}")
print("\n-- inclusive")
for n, c in incl_c.most_common(top):
    print(f"  {c:7d}  {100*c/total:5.1f}%  {n}")
CATEGORIES = {
    "Solid store proxies (JSC::ProxyObject)": ("JSC::ProxyObject",),
    "microtask drain (promise continuations)": ("JSC::VM::drainMicrotasks",),
    "timers (setTimeout/setInterval)": ("Bun__JSTimeout__call",),
    "socket/HTTP data in": ("us_internal_dispatch_ready_poll",),
    "JSON parse": ("JSC::JSONParse", "JSC::LiteralParser", "jsonParse"),
    "JSON stringify": ("JSC::JSONStringify", "appendQuotedJSONString", "Stringifier"),
    "object spread / clone": ("globalFuncCopyDataProperties", "globalFuncCloneObject"),
    "`in` operator": ("opInByVal", "operationInByVal"),
    "GC (main thread)": ("JSC::Heap::collect", "JSC::Heap::stopIfNecessary", "LocalAllocator::allocateSlowCase", "MarkedBlock::Handle::sweep"),
    "OpenTUI native (render, yoga)": ("<.bun-",),
    "sqlite": ("sqlite3",),
    "RegExp": ("JSC::RegExp", "operationRegExp"),
}
cat_c = collections.Counter()
for s in d["samples"]:
    if s[1] != pid or (thread_filter and threads.get(str(s[2]), "main" if s[2] == pid else "tid") != thread_filter):
        continue
    st = [sym(a) for a in d["stacks"][s[4]]]
    for cat, keys in CATEGORIES.items():
        if any(k in f for f in st for k in keys):
            cat_c[cat] += 1
print("\n-- categories (inclusive; overlap allowed)")
for cat in CATEGORIES:
    print(f"  {cat_c[cat]:7d}  {100*cat_c[cat]/max(total,1):5.1f}%  {cat}")
print("\n-- JIT leaf samples, by nearest native caller")
for n, c in entry_c.most_common(12):
    print(f"  {c:7d}  {100*c/total:5.1f}%  {n}")
