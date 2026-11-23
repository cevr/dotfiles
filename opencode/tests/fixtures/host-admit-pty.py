"""Scratch PTY driver: real terminal characters, no real workload or foreign process."""
import errno
import json
import os
import pty
import re
import select
import shlex
import signal
import sqlite3
import sys
import time

ROOT, EXE, CLI = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.chdir(ROOT)
    os.execve("/bin/bash", ["bash", "--noprofile", "--norc", "-i"], {
        "HOME": ROOT, "XDG_STATE_HOME": ROOT, "PATH": "/usr/bin:/bin",
        "PS1": "hcl> ", "TERM": "dumb",
    })

buffer = b""
history = b""


def await_line(pattern, timeout=8):
    global buffer, history
    deadline = time.monotonic() + timeout
    while not re.search(pattern, buffer):
        wait = deadline - time.monotonic()
        if wait <= 0 or not select.select([master], [], [], wait)[0]:
            raise AssertionError(f"waiting for {pattern!r}; transcript {history!r}")
        try:
            part = os.read(master, 4096)
        except OSError as e:
            if e.errno != errno.EIO:
                raise
            part = b""
        if not part:
            raise AssertionError(f"PTY closed; transcript {history!r}")
        buffer += part
        history += part
    buffer = buffer[re.search(pattern, buffer).end():]


def lease_is(state, reason):
    path = f"{ROOT}/host-admit/admission-v1.sqlite"
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        leases = json.loads(db.execute("select body from admission_v1").fetchone()[0])["leases"]
    row, = leases.values()
    return row["state"] == state and row["reason"] == reason


def owns_foreground():
    assert os.tcgetpgrp(master) == pid, f"caller {pid} did not regain terminal: {history!r}"


try:
    await_line(b"hcl> ")
    owns_foreground()
    payload = "trap 'printf \"payload-resumed\\n\"' CONT; printf 'payload-ready\\n'; while IFS= read -r line; do printf 'read:%s\\n' \"$line\"; done"
    # Give the terminal law a verified single-width payload, without running
    # Go or relying on an idle whole-host observation to test foreground I/O.
    stand_in = f"{ROOT}/go"
    with open(stand_in, "w", encoding="utf-8") as file:
        file.write(f"#!/bin/sh\n{payload}\n")
    os.chmod(stand_in, 0o700)
    command = ["/usr/bin/env", "GOMAXPROCS=1", EXE, CLI, "check", "run", "--", stand_in, "test", "-p=1"]
    os.write(master, (shlex.join(command) + "\n").encode())
    await_line(rb"(?:^|\r\n)payload-ready\r\n")
    assert os.tcgetpgrp(master) != pid
    os.write(master, b"\x1a")
    await_line(rb"\r\nhcl> ")
    owns_foreground()
    assert lease_is("running", "stopped")
    os.write(master, b"fg\n")
    await_line(rb"\r\npayload-resumed\r\n")
    os.write(master, b"terminal-input\n")
    await_line(rb"\r\nread:terminal-input\r\n")
    assert os.tcgetpgrp(master) != pid
    os.write(master, b"\x03")
    await_line(rb"hcl> ")
    owns_foreground()
    os.write(master, b"printf 'caller-status=%s\\n' \"$?\"\n")
    await_line(rb"\r\ncaller-status=130\r\n")
    assert lease_is("released", "scope-drained")
    print("PTY foreground, stopped lease, resumed input, Ctrl-C exit and drain verified")
finally:
    os.close(master)
    end = time.monotonic() + 1
    while os.waitpid(pid, os.WNOHANG)[0] == 0:
        if time.monotonic() >= end:
            # The unreaped direct child remains ours; never target a group.
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            break
        time.sleep(.01)
