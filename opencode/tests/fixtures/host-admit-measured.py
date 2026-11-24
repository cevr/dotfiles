"""Real Darwin samples bracketed by an independent ctypes reader."""
import ctypes
import json
import os
import subprocess
import sys

root, exe, cli = sys.argv[1:]
kernel = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
kernel.mach_host_self.restype = ctypes.c_uint
kernel.host_statistics.argtypes = [
    ctypes.c_uint, ctypes.c_int, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_uint),
]


def ticks():
    counters = (ctypes.c_uint32 * 4)()
    words = ctypes.c_uint(len(counters))
    # Compare like clock/counter sources. The separately aggregated
    # host_processor_info counters live at a different kernel update cadence.
    assert kernel.host_statistics(kernel.mach_host_self(), 3, counters, ctypes.byref(words)) == 0
    assert words.value == len(counters)
    return {"total": sum(counters), "idle": counters[2]}


def invoke(args, payload=None):
    command = [exe, cli, *args]
    result = subprocess.run(command, cwd=root, input=payload, text=True, capture_output=True,
                            timeout=6, check=False,
                            env={"HOME": root, "XDG_STATE_HOME": root, "PATH": "/usr/bin:/bin"})
    return result.returncode, json.loads(result.stdout)


rc, refused = invoke(["--test-supply", f"{root}/host-admit-supply.json"])
assert rc == 2 and refused["reason"] == "invalid-request", refused
rc, host = invoke(["host", "status", "--json"])
assert rc == 0, host
cores = int(subprocess.check_output(["/usr/sbin/sysctl", "-n", "hw.activecpu"], text=True))
memory = int(subprocess.check_output(["/usr/sbin/sysctl", "-n", "hw.memsize"], text=True))
assert host["maximumCpuMilli"] == max(0, cores * 1000 - 2000), host
assert host["maximumMemoryBytes"] == min(12 << 30, memory - (1 << 30)), host

draft = {
    "version": 1, "requestId": "real-sampler", "principal": host["principal"], "purpose": "check",
    "tier": "small", "deadlineBootMs": host["nowBootMs"] + 30000,
    "demand": {"width": "unknown", "cpuMilli": 1000, "memoryBytes": 0, "ioClass": "idle", "keys": [],
               "volumeReservations": [{"volumeId": host["defaultVolume"], "bytes": 0}]},
}
reply = None
try:
    # The smoke checks measurement, not the admission decision. Retry only
    # if there is no interval to compare against independent counters.
    for _ in range(3):
        before = ticks()
        rc, reply = invoke(["lease", "request", "--json"], json.dumps(draft))
        after = ticks()
        assert rc == 0 and reply["id"], reply
        if reply["supply"] is not None:
            break
    assert reply is not None
    measured = reply["supply"]
    assert measured is not None, reply
    interval = measured["interval"]
    for counter in ("total", "idle"):
        first, last = interval["before"][counter], interval["after"][counter]
        assert before[counter] <= first <= last <= after[counter], (before, interval, after)
    total = interval["after"]["total"] - interval["before"]["total"]
    idle = interval["after"]["idle"] - interval["before"]["idle"]
    busy = measured["outsideNoncriticalMilli"]
    assert total > 0 and 0 <= idle <= total
    assert abs(busy - (total - idle) * cores * 1000 / total) <= 1, measured
    pool = max(0, cores * 1000 - 2000)
    free = max(0, pool - busy)
    assert measured["hostCpuMilli"] == cores * 1000 and measured["freeManagedCpuMilli"] == free, measured
    print(f"real sample (no fixture load): {free} free/{pool} managed mCPU; {busy}/{cores*1000} outside mCPU")
    print("positive leg: real sample matched independent counters; no launch")
finally:
    if reply and reply.get("id"):
        rc, cancelled = invoke(["lease", "cancel", "--id", reply["id"], "--json"])
        assert rc == 0, cancelled
