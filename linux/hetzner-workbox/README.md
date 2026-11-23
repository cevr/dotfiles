# Workbox on a Hetzner AX102

The workbox moves from the exe.dev VM `bite-cristian` (LAX, 16 vCPU, 64 GB, a
btrfs image inside an 800 GB virtual disk) to a Hetzner AX102 in HEL1 (Ryzen 9
7950X3D 16c/32t, 128 GB ECC, 2 x 1.92 TB NVMe). The owner's plan, with the
measured facts: `hetzner-move/plan.md` in the orchestrator's scratch. The move
itself: [RUNBOOK.md](RUNBOOK.md).

The paths stay the same, so nothing else changes: the user `exedev` (uid
1000), its home `/home/exedev`, `/workspaces`, the hostname `bite-cristian`
(herdr-core's core name), and ssh on the Tailscale address, port 2222, with the
exe box's host key.

| File | Purpose |
| --- | --- |
| `installimage.conf` | Hetzner's installimage, from the Rescue System: Ubuntu 24.04 on DRIVE1, ESP, `/boot` ext4, swap, one btrfs with `@root`, `@home`, `@tmp`, `@workspaces`, `@runs` |
| `installimage-check.sh` | Runs installimage's own `read_vars`/`validate_vars` on the config, outside the Rescue System (test.sh does) |
| `layout.sh` | First boot: DRIVE2 joins. btrfs raid1 (data and metadata), mdraid1 `/boot` and swap, a second ESP kept by Ubuntu's grub-multi-install, the fstab options, btrfs simple quotas |
| `storage.conf`, `storage.sh`, `systemd/hetzner-workbox-storage.service` | The limited subvolumes (scratch and caches) and their limits; applied by provision.sh's `storage` phase and at each boot (Layout, below) |
| `provision.sh` | The system layer, in phases: hostname, `exedev`, keys, packages, the pinned tools (`workbox/system-tools.sh`: Go, PowerShell, fish/ksh/mksh, qemu-user-static, btrfs-progs, /tmp's rules, the free-space timer; pins in `workbox/pins.conf`), the limited subvolumes (`storage`), firewall, root ssh, Tailscale, the 2222 sshd, the reserve (the OpenCode service's memory floor) and the run families, unattended upgrades, backup, then `workbox/bootstrap.sh` |
| `sync.sh` | The copy from the exe box: btrfs send per subvolume, two passes, then activate; rsync for the rest; `--dry-run` prints the GB |
| `backup.sh`, `btrbk.conf`, `systemd/hetzner-backup.*` | Nightly btrbk snapshots, sent encrypted to a Storage Box |
| `firewall.nft`, `systemd/hetzner-workbox-firewall.service` | Inbound: Tailscale, ICMP, ssh 22; nothing else |
| `check.sh` | After each step: raid1, the subvolume mounts, md arrays, fstab, reflinks, firewall, sshd, backup timer |
| `authorized_keys` | The Mac's key and herdr-mobile's (public keys) |
| `test.sh` | On loop devices in a Linux VM, as root (Ubuntu 24.04 on Lima `wbnoble`, newer Linux regression on `wbtest`) |

## Disks

| Mount | What | Why |
| --- | --- | --- |
| `/boot/efi` | ESP on each drive (512 MiB vfat) | GRUB's `grub-multi-install` writes both on every update; either drive boots |
| `/boot` | mdraid1 of p2 on both drives, ext4 1 GiB | GRUB reads mdraid1 |
| swap | mdraid1 of p3, 32 GiB | btrfs refuses a swapfile on a multi-device file system; a mirror so a dead drive does not take swapped pages with it |
| `/`, `/home/exedev`, `/tmp`, `/workspaces` | subvolumes `@root`, `@home`, `@tmp`, `@workspaces` of one btrfs, raid1 data and metadata across p4 of both drives | the same subvolumes as on exe, so Rifts, reflinks and `btrfs send` work as today; the top level is mounted nowhere (Ergo's sweep refuses a checkout it sees twice) |
| `/runs` | subvolume `@runs` of the same btrfs | the durable run areas: run records the owner keeps (the Bite run's `/tmp/vperf2`, OpenCode's unit folders), outside `/tmp` (emptied at boot) and outside `/workspaces` (not backed up); never cleaned, backed up nightly |

installimage cannot make this itself: it has no multi-device btrfs, and
`SWRAID` puts every partition on mdraid (btrfs on mdraid would lose btrfs's
own repair from the good copy). So installimage installs on DRIVE1 alone and
`layout.sh` brings DRIVE2 in on the first boot. Every btrfs line mounts with
`noatime,compress=zstd:3,space_cache=v2,discard=async,user_subvol_rm_allowed`, by file
system UUID (`user_subvol_rm_allowed`: Ergo's `work` deletes a workspace's subvolume as the user).

A dead drive: btrfs refuses to mount degraded on its own. Boot the Rescue
System, `mount -o degraded,subvol=@root /dev/nvmeXn1p4 /mnt`, and follow
Hetzner's drive swap; after the swap, `btrfs replace` and `mdadm --add`.

## Layout: scratch, caches, run families, free space

The exe box let scratch and caches grow without a bound (2026-11-22: `/tmp`
298 GB from one benchmark, `/tmp/opencode` 86 GB, Ergo's Go cache 85 GB in
7.5 h) and let one family of runs take the CPU from the way in. The new box
bounds each by data, read by the scripts; nothing here kills a run.

**Simple quotas.** `layout.sh` turns on btrfs simple quotas
(`btrfs quota enable --simple`) on the first boot: installimage cannot make the
file system with them, and the box holds nothing yet, so nothing goes
uncounted. Simple quotas need btrfs-progs 6.7 and kernel 6.7; Ubuntu 24.04 has
kernel 6.8 and btrfs-progs 6.6.3, so `system-tools.sh btrfs` installs the
pinned newer package first (`workbox/pins.conf`, checked by sha256). Unlike
full qgroups, simple quotas count an extent against the subvolume that wrote
it and never walk back references, so deleting a snapshot costs no qgroup
accounting (btrfs docs, "Qgroups", "Simple quotas"). Measured in the test VM,
200 snapshots made, changed and deleted to the cleaner's end: 28.9 s with
quotas off, 31.9 s with simple quotas, 97.0 s with full qgroups.

**Limited subvolumes** (`storage.conf`, applied by `storage.sh` from
provision.sh's `storage` phase and by `hetzner-workbox-storage.service` at
each boot): a write past a limit fails with `EDQUOT` ("Disk quota exceeded")
in that subvolume alone; everything else keeps writing.

| Path | Limit | Fixes |
| --- | --- | --- |
| `/tmp` | 150G | builds' temporary files (GiBs) filling the workspace disk |
| `/tmp/opencode` | 100G | OpenCode's scratch (the opencode family's temp); its own cap, so builds and runs cannot starve each other |
| `/tmp/ergo`, `/tmp/bite-work`, `/tmp/personal` | 80G, 40G, 30G | each run family's temp (its callers' `TMPDIR` and `GOTMPDIR`): Go's link and test steps write GiBs there, so one family's builds cannot fill another's temp, nor `/tmp` |
| `/runs` | 20G | the durable run areas (`@runs`): never cleaned, backed up; roughly double Bite's 5–10 GB of durable records plus OpenCode's 0.26 GB of unit folders and logs. The two session-store copies were deleted; rebuildable scratch is not part of the sizing. |
| `/workspaces/.cache` | 60G | a cache folder nobody listed still counts against a cap |
| `/workspaces/.cache/ergo-gocache` | 100G | Ergo's shared Go cache, a backstop: Ergo's size-driven trim keeps it near 80G (never entries used in the last 75 min), since at a full cache the pinned Go's `go vet` (pins.conf) exits 1 (build and test still pass) |
| `/workspaces/.cache/turbo` | 30G | above turbo's own 20 GB trim, so turbo's trim acts first |
| all of `/workspaces/.cache` | 150G (qgroup `1/100`) | the caches together, under the members' sum |
| `~/.cache/go-build`, `~/go/pkg/mod`, `~/.bun/install/cache`, `~/.npm` | 40G, 30G, 30G, 10G | the tools' default caches, with no environment change |

`storage.sh` deletes nothing: a missing path becomes a subvolume, an empty
directory is replaced by one, and a directory holding files is named and left
(exit 1). Lanes and bases are not limited; each subvolume has its own qgroup,
so its size is readable without root: `cat
/sys/fs/btrfs/<fs uuid>/qgroups/0_<subvolume id>/exclusive` (bytes it alone
holds; the kernel makes these files 0444), with the id from `btrfs
inspect-internal rootid <path>`. `btrfs qgroup show` and `limit` stay root's,
and no sudoers line grants them.

**/tmp** stays a disk subvolume, not a tmpfs: builds write GiBs there, and a
tmpfs takes that memory from the agents. `workbox/systemd/tmp/tmpfiles.d/tmp.conf`
empties `/tmp` at each boot (`D`) and ages it at 7 days; `/tmp/opencode` has its
own `D` line at 14 days, so at boot its contents go and its subvolume (and its
limit) stays; so do the families' temps (`/tmp/ergo`, `/tmp/bite-work`,
`/tmp/personal`, 7 days each). `/runs` has no line: neither a boot nor the
daily clean touches it. `/tmp/vperf2` is a link to `/runs/vperf2`, made again
at each boot after `/tmp` is emptied (`systemd/tmpfiles.d/hetzner-runs.conf`, an
`L` line; provision.sh's `storage` phase installs it and makes the link at
once): the Bite run names `/tmp/vperf2` in thousands of places, and its records
live in the durable area. On the exe box a reboot empties `/tmp/vperf2` (its
`x` line in tmp.conf holds off only the daily clean): move it before that box
reboots. The daily clean runs `workbox-tmp-clean`. It uses a process's open
files, working directory and mappings to find its run entry directly under
the temp root (including each family's root), and locks that entry. An aged
file in the entry stays even if no process has opened that particular file.
For a run that may sit idle with no files open, or reopens an aged tree,
hold a shared directory lock for its full lifetime (`flock --shared "$run_dir"
command …`) before touching its contents. This also protects a holder that
starts during the scan: tmpfiles skips a locked entry and its descendants
(`tmpfiles.d(5)`, "Age"). An unlocked path first opened after the scan can
still race the cleaner.

**Run families** (`workbox/slices.conf`, installed by `system-tools.sh
slices`): slices of `exedev`'s own user manager, which has cpu, io and memory
delegated. Weights share the CPU under load only. Ergo's cap is written as a share
(`CPUQuota=62.5%threads`) and turned into a percentage at install: 10 of the
exe box's 16 threads (`CPUQuota=1000%`, set there 2026-11-23 03:5xZ), 20 of the
AX102's 32 (`2000%`); rerun `system-tools.sh slices` on a new host. They are
unit files, so they survive a reboot (test.sh `--slices-reboot` shows it across
a real reboot of the VM; the exe box lost ergo.slice's runtime-only values at
its 2026-11-23 reboot). A user's own `~/.config/systemd/user/<family>.slice`
shadows the installed one whole: Ergo wrote one on the exe box (`CPUWeight=20`,
`CPUQuota=1000%`, equal to ours there), which comes along in the home and, on
the AX102, would hold Ergo to 10 of 32 threads. `bootstrap.sh --check` warns
while such a file exists; move it aside after the move (RUNBOOK.md).

**Guarantee: this protects against accidents in ordinary agent launches, not
commands run through `sudo` or deliberate use of root (including explicit
Docker cgroup overrides).** After a Nov 23 test OOM-killed neighboring runs
and the OpenCode server, `user.slice` became the workload-only parent.

| Slice | CPU weight | Maximum RAM |
| --- | ---: | ---: |
| `opencode.slice` (work, not the server) | 400 | 7% |
| `ergo.slice` | 20 | 22% |
| `bite-work.slice` | 100 | 30% |
| `personal.slice` | 100 | 7% |
| `app.slice` (default unplaced work) | 100 | 5% |
| `workboxprotected.slice` (system-managed server; sibling of `user.slice`) | 1000 | 9% |

Systemd resolves the shares against physical RAM. The 73% aggregate workload
cap covers accounts and jobs together; each account's whole logind subtree
is capped at 72%, including SSH, tmux, linger, user timers and arbitrary user
units and slices. The four families and `app.slice` total 71%. If present,
cron and at share `user-jobs.slice` with Docker's daemon, containerd, its
shims, and default containers (36%, within the 73%, not another reservation).
The packages phase configures Docker's systemd driver and workload parent
before the package can start the engine; reserve also reconciles an installed
engine. `check.sh docker` checks the configured parent, running driver, and
actual Docker/containerd process cgroups. An explicit Docker `--cgroup-parent`
override can choose another branch and is outside the guarantee. Workload
and server do not swap.

The root-managed `workbox-opencode@exedev.service` stays in the separate
9% branch, with `MemoryMin=2%`, `MemoryLow=7%`, and `ManagedOOMPreference=omit`.
Systemd restarts it after its own cap kills it, but not after an explicit stop.
The remaining 18% is outside both caps for system services, root and the
kernel; their use is not capped by this setup. Protection applies to the
managed server unit, not to a server a client starts in its own session.
`shell-cgroup-cap` owns the activation, client routing, and the server-to-user
launch path. `workbox-run` continues to isolate calls made from the workload
branch while that integration is pending.

Mutating provisioning commands require an independently recorded
`WORKBOX_EXPECT_MACHINE_ID` before they touch a host; migration also verifies
`HB_TARGET_MACHINE_ID` against the SSH peer. See the [runbook](RUNBOOK.md).

No IO weights: on Ubuntu 24.04 NVMe's scheduler is `none`, which weighs nothing,
so an `IOWeight` there is a no-op. io.cost would weigh, but in the noble VM it
gave 21:1 for weights 400:20 once and 1:1 in three later runs (the VM's disk
never counts as saturated), and two runs with it on saw kernel I/O errors, so
it is not shipped untested: **fit and test io.cost on the AX102 at install**,
before any family relies on I/O isolation. For the pre-data test, use `lsblk
-d -o NAME,MAJ:MIN,MODEL` and `cat /sys/fs/cgroup/io.cost.{model,qos}` to check
both NVMe devices and the controller. Fit each device against disposable
data on the same device (the kernel's `tools/cgroup/iocost_coef_gen.py` is for
a disposable device; never point it at a disk holding data). Run two
direct-I/O writers in sibling cgroups at equal weights and then at 400:20,
using the same test files and saturation conditions. Compare per-device
`io.stat` write-byte deltas, repeat both arms, and check the kernel journal
for I/O errors. Accept a model only if the equal split repeats near 1:1 and
the weighted arm repeatedly favors the heavier cgroup. Each family
has `IOAccounting=yes` instead, so its `io.stat` counts the bytes it reads and
writes. Stock `user@.service` delegates cpu, memory and pids, not io: our drop-in
adds io, and a user manager takes it at its next start (a boot), not at a
`daemon-reload` or `daemon-reexec` (test.sh shows both: without the drop-in, a
run in `ergo.slice` is not counted; with it and a reload, still not; after the
manager's restart its write is). Ergo's gate already runs in `ergo-gates.slice`, which systemd
nests in `ergo.slice` by the dash in its name, so Ergo needs no change. In the
test VM two CPU-bound runs at 100 and 20 got 4.86:1 over 20 s, and ssh
answered in 0.6 s.

The provisioned bounded-job interface is
`workbox-run <family> [--memory-max SIZE] -- command [arg ...]`, without sudo.
The four families and `default` select a fresh user scope below that family
(`default` → `app.slice`). A scope uses 12 GiB or the requested positive
byte/K/M/G size, further restricted by the enclosing family, with swap off
and `memory.oom.group=1`: a killed run dies as a group. It preserves the
working directory, argv, environment and I/O, and returns the command's status
(137 for a SIGKILL on Linux). Invalid usage is 2; a systemd host without the
installed family or working user manager refuses (125, or systemd-run's
diagnostic and nonzero status if setup itself fails). On a system without
systemd, including macOS, it says so on stderr and runs the command unchanged.
Automatic OpenCode session-shell placement belongs to `shell-cgroup-cap`;
until then, use this helper for test runs.
A job also sets its family's temp: `TMPDIR=/tmp/<family> GOTMPDIR=/tmp/<family>`
(`/tmp/opencode` for the opencode family), so its build files count against
that family's cap.

**Pressure.** `workbox/bootstrap.sh` enables `workbox-pressure.timer` in the
lingering user's manager. It records CPU, memory and I/O PSI and available,
dirty, writeback and free-swap KiB once per minute, plus the five largest
user processes by RSS (PID, KiB, cgroup and command name, no arguments). Read it with `journalctl
--user -u workbox-pressure.service`; journald bounds retention, and samples
survive a reboot when the journal is persistent.

**Free space** (`workbox-disk-free.timer`, every minute, as root): writes
`/run/workbox/disk-free`, world-readable `key=value` lines in bytes
(`device_size`, `unallocated`, `free_estimated`, `free_min`, `updated`), from
`btrfs filesystem usage`, not `df` (which sees neither raid1 nor the space held
in allocated chunks). It enforces nothing.

## Copy: sync.sh

Rifts and warm sources are subvolumes nested in `@workspaces`, and `btrfs
send` does not descend into nested subvolumes. So `sync.sh` sends each
subvolume on its own, parents first: a Rift goes with its warm source as the
parent (`-p`), so on the target it is again a snapshot of the source plus its
own changes, sharing extents (test.sh measures the sharing). Pass 1 runs while
everything works; pass 2, during the pause, sends each subvolume against its
pass 1 snapshot, so it moves only what changed. `activate` then builds the new
`@home` and `@workspaces` from the received snapshots (nested ones put back in
place, read-only ones read-only again), moves the provisioned ones aside to
`.hetzner-sync/old-<time>`, and the target reboots into them.

`--dry-run` counts the data each send would carry from a `--no-data` stream
(`btrfs receive --dump`), so it reads metadata only and changes nothing on the
target. The count is before compression; `sync.sh` sends with
`--compressed-data` where btrfs-progs has it, so zstd-compressed extents go as
they are. exe bills TX past 200 GB at $0.05/GB.

`/tmp` (`@tmp`) is not copied: it is emptied at boot on both boxes. Outside the
subvolumes, `sync.sh rest` copies MongoDB's and Redis's data, `/usr/local` (Go),
`exedev`'s crontab and the 2222 sshd's host key with `rsync -aHAX --relative
--delete`. Not `--numeric-ids` (the spec's wording): the system users
(`mongodb`, `redis`) and the `crontab` group get their ids at install time and
differ between the boxes, so rsync maps them by name; `exedev` is 1000 on both.
The subvolume streams keep numeric ids, which is right for the home.

**Run records** (`sync.sh runs`): the exe box's `/tmp/vperf2`, the Bite run's
working area, goes to `/runs/vperf2`. It is not a subvolume there, so rsync
(`-aHAX --sparse`: hard links, ACLs, xattrs and holes kept), not `btrfs send`.
It is a step of its own at the move (RUNBOOK.md), never part of pass 1 or 2:
`sync.sh --dry-run runs` (or `runs` without `--yes`) prints the rsync-selected
logical bytes, including sparse lengths, and estimates the egress price
(not an exact wire byte count). It copies nothing.
`sync.sh runs --yes` copies, then compares every file by checksum (`rsync
--checksum --dry-run`: any line is a difference, and the step fails). Nothing
is deleted on either side; the source stays on the old box until it is
retired. `HB_RUNS_INCLUDE=<file of subpaths>` narrows the copy to those
subpaths with the same command. OpenCode session stores and sidecars are
always excluded; the owner had the two copies deleted. Sizes (the Bite run,
2026-11-23): 110 GB on disk, ~89 GB rebuildable scratch it cleans itself,
and 5–10 GB of durable records.

Never copied: `/var/lib/tailscale` (the new box is its own node), `/etc` beyond
the host key, Docker's images (pulled again), and the caches (`storage.conf`'s
`cache` lines: tools rebuild them, and the old ones are unbounded). `sync.sh`
sends a snapshot of its own of `@home` and `@workspaces` with the caches
removed inside that snapshot only (the source's caches are untouched), skips
the cache subvolumes, and names each cache it leaves out. On the target, the
boot after `activate` runs `hetzner-workbox-storage.service`, which makes each
cache an empty limited subvolume before the user's session starts. A received
subvolume gets its own qgroup, counting only what the receive wrote into it (a
Rift received against its source counts its own edits); the limits come from
`storage.conf`, never from the stream.

## Backups

exe.dev kept the disk; here the raid1 covers a dead drive, not a mistake or a
lost box. `backup.sh run` (the `hetzner-backup.timer`, 02:30 UTC nightly):

1. btrbk snapshots `/home/exedev` and `/runs` and every subvolume nested in
   them but the caches (`storage.conf`'s `cache` lines), into
   `/var/lib/btrbk/snapshots` (on the same btrfs, under `@root`), kept 14 days:
   the undo for mistakes. `/workspaces` is skipped, the owner's ruling: lanes
   and bases come back from git, and pushed work is on GitHub. That is why run
   records live in `@runs`, not under `/workspaces`. `backup.sh subvolumes`
   prints the list;
2. sends each snapshot to the Storage Box as a file: zstd, then AES-256 with the
   key in `/etc/btrbk/backup.key`. The Storage Box is not btrfs and its ssh has
   no pipes or redirects, which btrbk's raw target over ssh needs, so the files
   go through an sshfs mount (port 23) that btrbk sees as a local directory;
3. one directory per month: its first night is a full backup, every other night
   an increment on the night before. `backup.sh` deletes directories older than
   last month, since btrbk never deletes raw increments. That bounds the
   Storage Box at two full copies and their increments.

The S3 snapshot backup (`workbox-backup.timer`, `workbox/README.md`, S3
backups) runs here too, installed by `provision.sh bootstrap`: the owner keeps
both. It needs the `bite-dev` AWS SSO login kept valid on this box.

The key is the backup: copy `/etc/btrbk/backup.key` into the owner's password
manager when `provision.sh backup` makes it.

### Restore

On any Linux with btrfs-progs, openssl and zstd, the key at
`/etc/btrbk/backup.key` and the Storage Box mounted by `backup.sh` (or copied):

```sh
sudo HB_BACKUP_MONTH=2026-12 linux/hetzner-workbox/backup.sh list
sudo btrfs subvolume create /restore      # on a btrfs
sudo HB_BACKUP_MONTH=2026-12 linux/hetzner-workbox/backup.sh restore runs /restore
```

`restore` receives the month's chain for that name in order (the full backup,
then each night), so `/restore` holds one read-only snapshot per night; the
last is the newest. Copy files out, or `btrfs subvolume snapshot` one to a
writable place. A whole box: restore `home` and `runs` (and the home's nested subvolumes), put
them in place as `sync.sh activate` does, and clone `/workspaces` again from git.

## exe-only features and their replacements

Listed from the dotfiles (`git grep exe.xyz exe.dev`) and the exe box (read
only, 2026-11-14: its configs, `/etc`, units, ports).

| exe.dev feature | Used by | On Hetzner |
| --- | --- | --- |
| HTTPS proxy `https://bite-cristian.exe.xyz:<port>/` (3000 to 9999) | `workbox-port` | `workbox-port` runs `tailscale serve --bg --https=<port> http://127.0.0.1:<port>` and prints `https://bite-cristian.<tailnet>.ts.net:<port>/` (needs HTTPS certificates on in the tailnet's admin console; without them it prints `http://<Tailscale IP>:<port>/`) |
| the same proxy for Sideshow `:8228` | `workbox-sideshow` in `zshrc` (Mac) | now opens `http://<bite-workbox's address>:8228/` over Tailscale (works on exe today too); `tailscale serve --bg --https=8228 http://127.0.0.1:8228` for HTTPS |
| the same proxy for film-lab `:8229` | `~/.config/systemd/user/film-lab.service` on the box (not in dotfiles): `FILM_LAB_HOSTS=bite-cristian.exe.xyz:8229,...` | `tailscale serve --bg --https=8229 http://127.0.0.1:8229`, and set `FILM_LAB_HOSTS=bite-cristian.<tailnet>.ts.net:8229,bite-cristian.<tailnet>.ts.net,<Tailscale IP>:8229` in its drop-in (RUNBOOK step 9) |
| the proxy's default port: `https://bite-cristian.exe.xyz/` to nginx `:80`/`:8000`, to t3code `:3773` | nginx's `default` site | `tailscale serve --bg --https=443 http://127.0.0.1:3773`; t3code's own cloudflared tunnel works anywhere |
| ssh proxy `bite-cristian.exe.xyz` / `exe.dev` (`~/.ssh/config` hosts `bite-cristian`, `exe.dev-bite`) | the owner's fallback login, `ssh exe.dev resize` | not needed: Tailscale ssh on 2222 (`bite-workbox`), root ssh on 22 by key, Hetzner's Rescue System and KVM console |
| Shelley agent, web terminal, `exe-setup.service`, `/etc/hosts` and `.bashrc` hints | exe.dev itself | dropped |
| the provider's firewall in front of the VM | everything binding `0.0.0.0` (Sideshow, film-lab, nginx, Syncthing `:22000`) | `firewall.nft`: inbound only from Tailscale, plus ICMP, Tailscale's UDP 41641 and ssh 22 |
| the disk kept by exe | | raid1 plus `backup.sh` |

A Hetzner server also needs what exe gave without asking: a reverse DNS name is
optional (no mail is sent), and the clock (systemd-timesyncd) is on by default.
