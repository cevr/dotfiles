#!/usr/bin/python3
"""A server fixture with the same start/status/stop interface as the workbox launcher."""
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path.home() / ".workbox-memory-test"
ME = Path(__file__)


def publish(name, text):
    temp = ROOT / f"{name}.{os.getpid()}.new"
    temp.write_text(text)
    temp.replace(ROOT / name)


def touch_pages(mib):
    size = mib * 1024 * 1024
    pages = bytearray(size)
    pages[::4096] = b"x" * (size // 4096)
    return pages


def grow(keep, pause=0, chunks=256):
    while len(keep) < chunks:  # fail without consuming the whole VM if limits were absent
        keep.append(touch_pages(4))
        if pause:
            time.sleep(pause)
    raise SystemExit("memory limit failed to fire")


def hog(family):
    sibling = os.fork()
    if sibling == 0:
        time.sleep(145)
        os._exit(0)
    data = [touch_pages(24)]
    publish(family + ".ready", f"{os.getpid()} {sibling}\n")
    for _ in range(6500):
        if (ROOT / "hog-go").exists():
            if family == "docker":
                grow(data, pause=0.003, chunks=384)
            else:
                grow(data, pause=0.03 if family == "unnamed" else 0)
        time.sleep(0.02)
    raise SystemExit("hog start was not released")


def serve(mode):
    assert mode == "--service", mode
    unit = Path("/proc/self/cgroup").read_text().strip().rsplit("/", 1)[-1]
    publish("server", f"{os.getpid()} {unit}\n")
    child = None
    while True:
        if (ROOT / "server-grow").exists():
            (ROOT / "server-grow").unlink()
            grow([])
        if child is None and (ROOT / "start-bite").exists() and not (ROOT / "bite-work.ready").exists():
            # A protected system service cannot move itself across systemd's
            # delegation boundary. Ask the user manager to start the process.
            child = subprocess.Popen(
                ["systemd-run", "--user", "--wait", "--pipe", "--quiet", "--collect",
                 "--expand-environment=no", "--slice=bite-work.slice", "--property=MemoryMax=96M",
                 "--property=MemorySwapMax=0", "--property=OOMPolicy=kill", "--", ME, "hog", "bite-work"]
            )
            publish("broker", f"{child.pid}\n")
        if child is not None and child.poll() is not None:
            status = child.returncode
            publish("bite-work.exit", f"{128 - status if status < 0 else status}\n")
            child = None
        time.sleep(0.02)


{"serve": serve, "hog": hog}[sys.argv[1]](sys.argv[2])
