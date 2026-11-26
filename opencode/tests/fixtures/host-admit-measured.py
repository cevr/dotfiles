"""Real Darwin samples checked against independent host capacity."""
import json
import os
import subprocess
import sys

root, exe, cli = sys.argv[1:]


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
    # if there is no interval to validate.
    for _ in range(3):
        rc, reply = invoke(["lease", "request", "--json"], json.dumps(draft))
        assert rc == 0 and reply["id"], reply
        if reply["supply"] is not None:
            break
    assert reply is not None
    measured = reply["supply"]
    assert measured is not None, reply
    interval = measured["interval"]
    # Cross-process Mach calls are not a temporal bracket: even two clients
    # of host_statistics can observe snapshots in a different counter order.
    # Validate the sampler's coherent interval, not ambient utilization.
    assert 0 <= interval["before"]["at"] < interval["after"]["at"], interval
    for edge in ("before", "after"):
        assert 0 <= interval[edge]["idle"] <= interval[edge]["total"], interval
    total = interval["after"]["total"] - interval["before"]["total"]
    idle = interval["after"]["idle"] - interval["before"]["idle"]
    busy = measured["outsideNoncriticalMilli"]
    assert total > 0 and 0 <= idle <= total
    assert 0 <= busy <= cores * 1000, measured
    assert abs(busy - (total - idle) * cores * 1000 / total) <= 1, measured
    pool = max(0, cores * 1000 - 2000)
    free = max(0, pool - busy)
    assert measured["hostCpuMilli"] == cores * 1000 and measured["freeManagedCpuMilli"] == free, measured
    print(f"real sample (no fixture load): {free} free/{pool} managed mCPU; {busy}/{cores*1000} outside mCPU")
    print("positive leg: real interval and independent host capacity checks passed; no launch")
finally:
    if reply and reply.get("id"):
        rc, cancelled = invoke(["lease", "cancel", "--id", reply["id"], "--json"])
        assert rc == 0, cancelled
