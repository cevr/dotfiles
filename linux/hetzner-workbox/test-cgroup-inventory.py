#!/usr/bin/python3
"""Walk every cgroup; account-owned processes and requested units must be bounded."""
import os
from pathlib import Path
import sys

root = Path("/sys/fs/cgroup")
workload = root / "user.slice"
protected = root / "workboxprotected.slice"
uid, server = map(int, sys.argv[1:3])
expected = set(sys.argv[3:])
seen = set()
count = 0

for base, _, files in os.walk(root):
    count += 1
    base = Path(base)
    if "cgroup.procs" not in files:
        continue
    try:
        pids = (base / "cgroup.procs").read_text().split()
    except FileNotFoundError:
        continue
    for pid in pids:
        try:
            fields = Path(f"/proc/{pid}/status").read_text().splitlines()
        except (FileNotFoundError, ProcessLookupError):
            continue
        if int(pid) == server:
            assert protected in base.parents, (pid, base)
            seen.add(pid)
            continue
        if pid not in expected and not any(
            line.startswith("Uid:") and str(uid) in line.split()[1:] for line in fields
        ):
            continue
        assert workload in base.parents, (pid, "escaped workload", base)
        cap = None
        for node in (base, *base.parents):
            if node == workload:
                break
            path = node / "memory.max"
            if path.is_file() and path.read_text().strip().isdigit():
                cap = node
                break
        assert cap is not None, (pid, "no cap below aggregate", base)
        if pid in expected:
            print(f"inventory: {pid} {base.relative_to(root)} → {cap.name}")
            seen.add(pid)

assert expected | {str(server)} == seen, (expected, server, seen)
print(f"inventory: walked {count} cgroups; every agent-owned process is in the capped workload tree, server in sibling")
