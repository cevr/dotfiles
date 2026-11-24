"""Real Darwin samples, bracketed by independent per-CPU kernel reads."""
import ctypes
import json
import os
import subprocess
import sys

root, exe, cli = sys.argv[1:]
kernel = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
kernel.mach_host_self.restype = ctypes.c_uint
kernel.host_processor_info.argtypes = [
    ctypes.c_uint, ctypes.c_int, ctypes.POINTER(ctypes.c_uint),
    ctypes.POINTER(ctypes.POINTER(ctypes.c_int)), ctypes.POINTER(ctypes.c_uint),
]
kernel.vm_deallocate.argtypes = [ctypes.c_uint, ctypes.c_void_p, ctypes.c_size_t]
task = ctypes.c_uint.in_dll(kernel, "mach_task_self_")


def ticks():
    cores = ctypes.c_uint()
    words = ctypes.c_uint()
    data = ctypes.POINTER(ctypes.c_int)()
    assert kernel.host_processor_info(kernel.mach_host_self(), 2, ctypes.byref(cores),
                                      ctypes.byref(data), ctypes.byref(words)) == 0
    try:
        assert words.value == cores.value * 4
        counts = [data[i] for i in range(words.value)]
        return {"total": sum(counts), "idle": sum(counts[2::4])}
    finally:
        assert kernel.vm_deallocate(task, data, words.value * ctypes.sizeof(ctypes.c_int)) == 0


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
    # A scheduler delay can age an interval while sampling. Retry the same
    # ticket, checking that an unreadable or stale interval never grants.
    for _ in range(3):
        before = ticks()
        rc, reply = invoke(["lease", "request", "--json"], json.dumps(draft))
        after = ticks()
        assert rc == 0 and reply["id"], reply
        if reply["supply"] is not None and reply["reason"] != "stale-sample":
            break
        assert reply["state"] == "queued" and reply["admittedDemand"] is None, reply
    assert reply is not None
    measured = reply["supply"]
    assert measured is not None and reply["reason"] != "stale-sample", reply
    interval = measured["interval"]
    # Two distinct Mach APIs sample asynchronously across CPUs. Admit one
    # tick per core at each edge of the independently bracketed interval.
    for counter in ("total", "idle"):
        first, last = interval["before"][counter], interval["after"][counter]
        assert before[counter] - cores <= first <= last <= after[counter] + cores, (before, interval, after)
    total = interval["after"]["total"] - interval["before"]["total"]
    idle = interval["after"]["idle"] - interval["before"]["idle"]
    busy = measured["outsideNoncriticalMilli"]
    assert total > 0 and 0 <= idle <= total
    assert abs(busy - (total - idle) * cores * 1000 / total) <= 1, measured
    pool = max(0, cores * 1000 - 2000)
    free = max(0, pool - busy)
    assert measured["hostCpuMilli"] == cores * 1000 and measured["freeManagedCpuMilli"] == free, measured
    print(f"real sample (no fixture load): {free} free/{pool} managed mCPU; {busy}/{cores*1000} outside mCPU")
    if 2 * free < pool and measured["qualification"] == "advisory":
        assert (reply["state"], reply["reason"], reply["admittedDemand"]) == ("queued", "outside-busy", None), reply
        print(f"positive leg not judged: host busy ({busy/1000} of {cores} cores)")
    elif (measured["qualification"] == "advisory" and measured["pressure"] != "hold"
          and measured["runnable"] < min(24, cores)):
        assert reply["state"] == "granted" and reply["admittedDemand"]["cpuMilli"] == pool, reply
        print("positive leg judged: real sampled whole-pool grant")
    else:
        assert reply["state"] == "queued" and reply["reason"] in ("pressure", "unqualified"), reply
        print(f"positive leg not judged: {reply['reason']} at {busy/1000} of {cores} cores")
finally:
    if reply and reply.get("id"):
        rc, cancelled = invoke(["lease", "cancel", "--id", reply["id"], "--json"])
        assert rc == 0 and cancelled["state"] == "cancelled", cancelled
