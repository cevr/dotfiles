#!/usr/bin/env python3
"""Self and inclusive time by function (name file:line) from a .cpuprofile (Chrome/V8 format, as `bun --cpu-prof` writes).
Usage: cpuprofile-top.py <file.cpuprofile> [--top N]"""
import collections, json, os, sys

path = sys.argv[1]
top = int(sys.argv[sys.argv.index("--top") + 1]) if "--top" in sys.argv else 25
p = json.load(open(path))
nodes = {n["id"]: n for n in p["nodes"]}
parent = {}
for n in p["nodes"]:
    for c in n.get("children", []):
        parent[c] = n["id"]
deltas = p.get("timeDeltas") or [1] * len(p["samples"])


def label(n):
    f = n["callFrame"]
    return f"{f['functionName'] or '(anonymous)'} {os.path.basename(f['url'])}:{f['lineNumber'] + 1}"


self_t, incl_t = collections.Counter(), collections.Counter()
total = 0
for sid, dt in zip(p["samples"], deltas[1:] + [deltas[-1]]):
    total += dt
    self_t[label(nodes[sid])] += dt
    seen, cur = set(), sid
    while cur is not None:
        lab = label(nodes[cur])
        if lab not in seen:
            incl_t[lab] += dt
            seen.add(lab)
        cur = parent.get(cur)
print(f"total {total/1000:.0f} ms")
print("-- self")
for k, v in self_t.most_common(top):
    print(f"  {v/1000:8.0f} ms {100*v/total:5.1f}%  {k}")
print("-- inclusive")
for k, v in incl_t.most_common(top):
    print(f"  {v/1000:8.0f} ms {100*v/total:5.1f}%  {k}")
