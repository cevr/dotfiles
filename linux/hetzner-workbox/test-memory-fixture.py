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


def grow(keep):
    while len(keep) < 256:  # fails the test without consuming the whole VM if limits were absent
        keep.append(touch_pages(4))
    raise SystemExit("memory limit failed to fire")


def hog(family):
    sibling = os.fork()
    if sibling == 0:
        time.sleep(25)
        os._exit(0)
    data = [touch_pages(24)]
    publish(family + ".ready", f"{os.getpid()} {sibling}\n")
    for _ in range(500):
        if (ROOT / "hog-go").exists():
            grow(data)
        time.sleep(0.02)
    raise SystemExit("hog start was not released")


def serve(unit):
    publish("server", f"{os.getpid()} {unit}\n")
    child = None
    while True:
        if (ROOT / "server-grow").exists():
            (ROOT / "server-grow").unlink()
            grow([])
        if child is None and (ROOT / "start-bite").exists() and not (ROOT / "bite-work.ready").exists():
            child = subprocess.Popen([ME.with_name("workbox-run"), "bite-work", "--memory-max", "96M", "--", ME, "hog", "bite-work"])
        if child is not None and child.poll() is not None:
            status = child.returncode
            publish("bite-work.exit", f"{128 - status if status < 0 else status}\n")
            child = None
        time.sleep(0.02)


def running():
    try:
        pid, unit = (ROOT / "server").read_text().split()
        if Path(f"/proc/{pid}/cgroup").read_text().split("/")[-1].strip() == unit:
            return unit
    except (OSError, ValueError):
        pass
    return None


def service(action):
    unit = running()
    if action == "status":
        print("running" if unit else "stopped")
    elif action == "stop":
        if unit:
            subprocess.run(["systemctl", "--user", "stop", unit], check=True)
    elif action == "start":
        if unit:
            return
        unit = f"opencode-service-fixture-{os.getpid()}.scope"
        with (ROOT / "server.log").open("a") as log:
            child = subprocess.Popen(
                ["systemd-run", "--user", "--scope", "--quiet", "--collect", "--slice=app.slice",
                 "--unit", unit, "--", ME, "serve", unit],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
            )
        for _ in range(100):
            if running() == unit:
                return
            if child.poll() is not None:
                break
            time.sleep(0.04)
        raise SystemExit("fixture server did not start")
    else:
        raise SystemExit(f"unknown fixture service action: {action}")


{"serve": serve, "hog": hog, "service": service}[sys.argv[1]](sys.argv[2])
