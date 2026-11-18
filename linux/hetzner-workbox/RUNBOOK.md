# Runbook: move the workbox from exe.dev to Hetzner

`d=~/Developer/personal/dotfiles/linux/hetzner-workbox` on the exe box (this
branch landed and synced there), and the same tree copied to `/root/dotfiles`
on the new box until its home arrives. `NEW` is the new box's public IP,
`NEWTS` its Tailscale IPv4 once it has one. Times are guesses unless marked
measured; the exe box held about 430 GB on 2026-11-14 (plan.md, measured).

## 0. The owner's part (before anything)

1. Order the AX102 in HEL1 with the Rescue System and the Mac's key
   (`~/.ssh/id_exe_getbite.pub`); send `NEW`.
2. Order a Storage Box (BX21, 5 TB, HEL1 or FSN1) and turn on "SSH support"
   (port 23); send its host (`uXXXXX.your-storagebox.de`) and user.
3. Make a one-off Tailscale auth key in the getbite.com tailnet's admin console
   (Settings, Keys; not reusable, not ephemeral, no tags: the exe node has
   none). Keep it for step 4; it is typed, never stored.

## 1. Install (on the new box, ~15 min)

1. `ssh root@NEW` (the Rescue System). `lsblk`: two NVMe, `nvme0n1` and
   `nvme1n1`. Wipe them as Hetzner says: `mdadm --stop /dev/md*`, then
   `wipefs -fa /dev/nvme*n1`.
2. From the Mac: `scp $d/installimage.conf root@NEW:/root/`. On the box:
   `installimage -a -c /root/installimage.conf -K /root/.ssh/authorized_keys`,
   then `reboot`.
3. From the Mac: `rsync -a ~/Developer/personal/dotfiles/{linux,workbox} root@NEW:/root/dotfiles/`
   (provision.sh reads `workbox/systemd`).
4. `ssh root@NEW`; `/root/dotfiles/linux/hetzner-workbox/layout.sh --dry-run`,
   then `layout.sh` (seconds: the file system is nearly empty). `reboot`, then
   `HB_CHECK_SKIP="firewall sshd backup" /root/dotfiles/linux/hetzner-workbox/check.sh`:
   every line `ok` (raid1, the four subvolumes, `/boot` and swap on md).
   `cat /proc/mdstat` may show a resync for a few minutes; that is fine.

## 2. Provision (~10 min)

1. On the exe box, a key for the copy: `ssh bite-workbox 'test -f ~/.ssh/hetzner-sync || ssh-keygen -q -t ed25519 -N "" -C hetzner-sync -f ~/.ssh/hetzner-sync'`.
2. On the new box as root:

   ```sh
   read -rs TS_AUTHKEY && export TS_AUTHKEY      # paste the key from 0.3
   export HB_EXTRA_KEYS='<the line of ssh bite-workbox cat .ssh/hetzner-sync.pub>'
   /root/dotfiles/linux/hetzner-workbox/provision.sh host user keys packages firewall rootssh tailscale sshd upgrades
   unset TS_AUTHKEY
   ```

   It joins the tailnet as `bite-cristian-hel` (the exe node keeps
   `bite-cristian` until the cutover) and prints `NEWTS`.
3. From the Mac: `ssh -p 2222 -i ~/.ssh/id_exe_getbite exedev@NEWTS true`. From
   the exe box: `ssh -p 2222 -i ~/.ssh/hetzner-sync exedev@NEWTS sudo -n true`.
   Both must exit 0. Public ssh on 22 stays for root, by key, as the way back in
   besides the Rescue System.
4. Backups: `HB_STORAGEBOX_HOST=... HB_STORAGEBOX_USER=... /root/dotfiles/linux/hetzner-workbox/provision.sh backup`.
   It prints the `install-ssh-key` line to run once (it asks for the Storage
   Box password) and makes `/etc/btrbk/backup.key`: copy that key into the
   password manager now. The timer starts backing up after the cutover's reboot.

## 3. Pass 1, while everything runs (hours)

From an hc terminal on the exe box (the copy outlives an ssh session there):

```sh
sudo HB_TO=exedev@NEWTS $d/sync.sh --dry-run pass 1    # GB per subvolume and the total
sudo HB_TO=exedev@NEWTS $d/sync.sh pass 1
sudo HB_TO=exedev@NEWTS $d/sync.sh rest                # MongoDB and the rest, live (pass 2 redoes it)
```

The dry run reads metadata only. At 1 Gbit/s on the Hetzner side and the LAX
to HEL1 path (about 150 ms), expect hours for ~430 GB; a rerun resumes, skipping
what arrived. exe bills TX past 200 GB a month at $0.05/GB: about $22 for this
pass (plan.md). Then `sudo HB_TO=exedev@NEWTS $d/sync.sh --dry-run pass 2` shows
what the final pass would move; run it once more shortly before the window.

## 4. The window (about an hour)

Run from plain ssh shells (`ssh bite-workbox`, `ssh root@NEW`), not from an hc
terminal that is about to stop.

1. **Tell the runs** (Ergo, Bite, vperf2): pause at a safe point, commit and
   push, and say so. Wait for each.
2. **Note the terminals**: `hc ls` on the exe box lists the terminals; note each
   OpenCode one's session id (`opencode session list`, or the pane's title).
   The sessions live in the home and come along; the terminals do not.
3. **Stop the writers on the exe box**: `systemctl --user stop opencode.service
   hc-core.service sideshow.service film-lab.service t3code.service
   teamclaude.service sh.executor.daemon.service`, `hc server stop`,
   `sudo systemctl stop syncthing@exedev mongod redis-server`. On the new box:
   `systemctl stop mongod redis-server`.
4. **Final copy** (minutes: only what changed since pass 1):

   ```sh
   sudo HB_TO=exedev@NEWTS $d/sync.sh pass 2
   sudo HB_TO=exedev@NEWTS $d/sync.sh rest
   sudo HB_TO=exedev@NEWTS $d/sync.sh activate 2
   ```

   `activate` prints one `activated` line for `@home` and one for `@workspaces`.
5. **Reboot the new box**: `ssh root@NEW reboot`. It comes up with the exe
   box's home, `/workspaces`, MongoDB data and the 2222 host key.
6. **Move the Tailscale name and address**, so the alias `bite-workbox`
   (`HostName 100.88.97.119` in `~/.ssh/config`) and the phone's Herdr host
   keep working:
   1. exe box: `sudo tailscale set --hostname=bite-cristian-exe`;
   2. admin console, Machines: on the exe node, Edit IPv4 to a free address;
      on the new node, Edit IPv4 to `100.88.97.119` and rename it
      `bite-cristian`;
   3. new box: `sudo systemctl restart tailscaled bite-workbox-sshd`, then from
      the Mac `ssh bite-workbox hostname` prints `bite-cristian`, with no host
      key warning (the key came along).
   If the console refuses the address, set `HostName NEWTS` for `bite-workbox`
   in `~/.ssh/config` instead, and the phone's Herdr host likewise.
7. **Bootstrap**: `ssh bite-workbox`, then
   `sudo ~/Developer/personal/dotfiles/linux/hetzner-workbox/provision.sh sshd bootstrap`
   (the sshd phase picks up the new Tailscale address; bootstrap installs the
   user units and runs its own checks). Then `sudo $d/check.sh`: every line
   `ok`, the backup timer included.
8. **Services**: `systemctl --user enable --now hc-core.service sideshow.service
   film-lab.service t3code.service teamclaude.service sh.executor.daemon.service`,
   `systemctl --user start opencode.service`, `sudo systemctl enable --now
   syncthing@exedev`. `~/Developer/personal/dotfiles/workbox/bootstrap.sh --check`
   must pass.
9. **exe-only features** (README.md, last table): `tailscale serve --bg
   --https=8228 http://127.0.0.1:8228`, the same for 8229 and for 443 to 3773;
   in `~/.config/systemd/user/film-lab.service.d/` set `FILM_LAB_HOSTS` to the
   ts.net name and the Tailscale address, `systemctl --user daemon-reload`,
   restart film-lab.
10. **hc on the Mac**: `hc machine rm workbox`, then
    `hc machine add bite-workbox --name workbox` (through the alias, never the
    exe proxy: through it the login has no XDG_RUNTIME_DIR and hc starts a
    second, empty core). `hc machine ls` lists `workbox`; `hc exec --on
    workbox hc ls` lists its terminals.
11. **The 5 OpenCode sessions**: in hc on the new box, one terminal each,
    `opencode -s <id>` with the ids from step 2.
12. **Tell the runs** to resume, with the new box's facts (same paths, same
    alias, 32 threads, 128 GB).

## 5. After

- A week of fallback: the exe box stays as it is, stopped services, renamed
  `bite-cristian-exe`. To roll back within it: start its services again, and
  swap the Tailscale names and addresses back (step 4.6 the other way).
  Anything written on the new box meanwhile stays there.
- Then the owner cancels exe.dev (billed to cristian@getbite.com).
- On the new box, once sure: `sudo mount -o subvolid=5 <btrfs device> /mnt`,
  delete `.hetzner-sync/old-*` (the provisioned home) and the received
  snapshots in `.hetzner-sync/<pass>`, `sudo umount /mnt`. On the exe box,
  `/tmp/.hetzner-sync` holds the sent snapshots until it goes.
- The first nightly backup is a full one (hours); `sudo $d/backup.sh list` the
  next morning lists a `.info` per subvolume.

## Rollback during the window

- Before step 4's `activate`: nothing on the exe box changed; start its
  services (step 3 the other way).
- After `activate`, before step 6: the exe box is untouched; start its services
  and leave Tailscale as it is. The new box's old home is in
  `.hetzner-sync/old-<time>`.
- After step 6: swap the Tailscale names and addresses back, then start the exe
  box's services.
