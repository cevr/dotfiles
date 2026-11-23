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
| `installimage.conf` | Hetzner's installimage, from the Rescue System: Ubuntu 24.04 on DRIVE1, ESP, `/boot` ext4, swap, one btrfs with `@root`, `@home`, `@tmp`, `@workspaces` |
| `installimage-check.sh` | Runs installimage's own `read_vars`/`validate_vars` on the config, outside the Rescue System (test.sh does) |
| `layout.sh` | First boot: DRIVE2 joins. btrfs raid1 (data and metadata), mdraid1 `/boot` and swap, a second ESP kept by Ubuntu's grub-multi-install, the fstab options, btrfs simple quotas |
| `storage.conf`, `storage.sh`, `systemd/hetzner-workbox-storage.service` | The limited subvolumes (scratch and caches) and their limits; applied by provision.sh's `storage` phase and at each boot (Layout, below) |
| `provision.sh` | The system layer, in phases: hostname, `exedev`, keys, packages, the pinned tools (`workbox/system-tools.sh`: Go, PowerShell, fish/ksh/mksh, qemu-user-static, btrfs-progs, /tmp's rules, the free-space timer; pins in `workbox/pins.conf`), the limited subvolumes (`storage`), firewall, root ssh, Tailscale, the 2222 sshd, the reserve (the OpenCode service's memory floor) and the run families, unattended upgrades, backup, then `workbox/bootstrap.sh` |
| `sync.sh` | The copy from the exe box: btrfs send per subvolume, two passes, then activate; rsync for the rest; `--dry-run` prints the GB |
| `backup.sh`, `btrbk.conf`, `systemd/hetzner-backup.*` | Nightly btrbk snapshots, sent encrypted to a Storage Box |
| `firewall.nft`, `systemd/hetzner-workbox-firewall.service` | Inbound: Tailscale, ICMP, ssh 22; nothing else |
| `check.sh` | After each step: raid1, the subvolume mounts, md arrays, fstab, reflinks, firewall, sshd, backup timer |
| `authorized_keys` | The Mac's key and herdr-mobile's (public keys) |
| `test.sh` | All of it on loop devices in a Linux VM (Lima `wbtest`), root |

## Disks

| Mount | What | Why |
| --- | --- | --- |
| `/boot/efi` | ESP on each drive (512 MiB vfat) | GRUB's `grub-multi-install` writes both on every update; either drive boots |
| `/boot` | mdraid1 of p2 on both drives, ext4 1 GiB | GRUB reads mdraid1 |
| swap | mdraid1 of p3, 32 GiB | btrfs refuses a swapfile on a multi-device file system; a mirror so a dead drive does not take swapped pages with it |
| `/`, `/home/exedev`, `/tmp`, `/workspaces` | subvolumes `@root`, `@home`, `@tmp`, `@workspaces` of one btrfs, raid1 data and metadata across p4 of both drives | the same subvolumes as on exe, so Rifts, reflinks and `btrfs send` work as today; the top level is mounted nowhere (Ergo's sweep refuses a checkout it sees twice) |

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
| `/tmp/opencode` | 100G | OpenCode's run files; its own cap, so builds and runs cannot starve each other |
| `/workspaces/.cache` | 60G | a cache folder nobody listed still counts against a cap |
| `/workspaces/.cache/ergo-gocache` | 100G | Ergo's shared Go cache (a size cap: an age trim under 75 min breaks its builds) |
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
limit) stays. The daily clean runs `workbox-tmp-clean`, which takes a shared
`flock` on every path under `/tmp` and `/var/tmp` that a running process holds
(open file, working directory, mapping); tmpfiles skips a locked entry and
everything below it (tmpfiles.d(5), "Age"), so nothing a running process holds
is deleted.

**Run families** (`workbox/slices.conf`, installed by `system-tools.sh
slices`): slices of `exedev`'s own user manager, which has cpu, io and memory
delegated. `opencode.slice` (CPU/IO weight 400), `ergo.slice` (20, at most 10
CPUs, `MemoryHigh` 80%: above Ergo's own bound on its gates, so that acts
first), `bite-work.slice` (100), `personal.slice` (100). Weights share the CPU
under load only. Ergo's gate already runs in `ergo-gates.slice`, which systemd
nests in `ergo.slice` by the dash in its name, so Ergo needs no change. In the
test VM two CPU-bound runs at 100 and 20 got 4.86:1 over 20 s, and ssh
answered in 0.6 s.

The callers' contract (the host arbiter, Ergo's launcher): run a job as
`systemd-run --user --scope --slice=<family>.slice -- <command>`, with
`<family>` one of `opencode`, `ergo`, `bite-work`, `personal`; no root, no
sudo. The slices are the user manager's units from `/etc/systemd/user`;
`systemctl --user cat <family>.slice` exits 0 where they are installed. A slice
name with no unit file is not refused: systemd makes it with no settings of
its own (an ordinary sibling at the default share), so a caller that must have the family's values checks
`systemctl --user cat` first and treats exit 1 as "families not installed".

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

1. btrbk snapshots every subvolume of `/home/exedev` and `/workspaces`, each warm
   source and Rift included, into `/var/lib/btrbk/snapshots` (on the same btrfs,
   under `@root`), kept 14 days: the undo for mistakes;
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
sudo HB_BACKUP_MONTH=2026-12 linux/hetzner-workbox/backup.sh restore workspaces._rifts.bite.my-branch /restore
```

`restore` receives the month's chain for that name in order (the full backup,
then each night), so `/restore` holds one read-only snapshot per night; the
last is the newest. Copy files out, or `btrfs subvolume snapshot` one to a
writable place. A whole box: restore `home` and `workspaces` and every Rift,
then put them in place as `sync.sh activate` does.

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
