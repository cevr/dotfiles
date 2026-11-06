#!/usr/bin/env python3
"""Per-second CPU of one thread (default: the main thread) from a strobe deep recording.

Usage: strobe-timeline.py <recording dir> [--tid N] [--bucket-ms 1000]
Prints ms of CPU per bucket (1 sample = interval_us of CPU) and the longest run of buckets at >= 90%.
"""
import collections, gzip, json, os, sys

args = sys.argv[1:]
rec = args[0]
opt = lambda name, default=None: args[args.index(name) + 1] if name in args else default
meta = json.load(open(os.path.join(rec, "meta.json")))
tid = int(opt("--tid", meta["pid"]))
bucket = int(opt("--bucket-ms", "1000")) * 1_000_000
d = json.load(gzip.open(os.path.join(rec, "deep.json.gz")))
per = d["interval_us"] / 1000
counts = collections.Counter((s[0] - d["t0_ns"]) // bucket for s in d["samples"] if s[2] == tid)
n = int((d["t1_ns"] - d["t0_ns"]) // bucket) + 1
row = [counts.get(i, 0) * per for i in range(n)]
full = bucket / 1_000_000
print(f"{os.path.basename(rec)} tid {tid}: ms of CPU per {full:.0f} ms bucket")
print(" ".join(f"{v:.0f}" for v in row))
streak = best = 0
for v in row:
    streak = streak + 1 if v >= 0.9 * full else 0
    best = max(best, streak)
busy = sum(1 for v in row if v >= 0.9 * full)
print(f"buckets >= 90% busy: {busy}/{n} · longest run: {best} buckets · mean {sum(row)/n/full*100:.0f}%")
