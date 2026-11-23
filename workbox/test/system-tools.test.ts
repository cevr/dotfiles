// workbox/system-tools.sh, which bootstrap.sh (exe.dev workbox) and provision.sh's tools and reserve
// phases (Hetzner box) run as root: the pinned Go, PowerShell from Microsoft's repository, the shells,
// qemu-user-static with its binfmt entry, and the OpenCode service's memory floor. It runs here against
// a scratch root (WORKBOX_TOOLS_ROOT), a scratch /proc and fake dpkg, dpkg-query, apt-get, curl,
// systemctl and systemd-binfmt on PATH; gpg, tar, perl and sha256sum are the host's own. Nothing touches
// the real host. SYSTEM_TOOLS_UNDER_TEST names another copy of the script (a mutant, to see cases red).
// linux/hetzner-workbox/test.sh runs the same steps for real in the Lima VM.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const workboxDir = join(import.meta.dir, "..")
const repo = join(workboxDir, "..")
const underTest = process.env.SYSTEM_TOOLS_UNDER_TEST ?? join(workboxDir, "system-tools.sh")
// Each case runs the script a few times, and each run starts tar, gpg and perl: seconds on a loaded host.
setDefaultTimeout(60_000)
const scratch = mkdtempSync(join(tmpdir(), "system-tools-test-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** pins.conf's values, read as the script reads them. */
const pinsText = readFileSync(join(workboxDir, "pins.conf"), "utf8")
const pin = (name: string) => {
  const line = pinsText.split("\n").find((each) => each.startsWith(`${name}=`))
  if (line === undefined) throw new Error(`pins.conf has no ${name}`)
  return line.slice(name.length + 1).replace(/^"|"$/g, "")
}
const goVersion = pin("GO_VERSION")
const goSha = pin("GO_SHA256")
const keyFingerprint = pin("MICROSOFT_KEY_FINGERPRINT")

const gpg = Bun.which("gpg")
if (gpg === null) throw new Error("gpg is not on PATH: the key checks need the host's gpg")

const fakes: Record<string, string> = {
  dpkg: `#!/bin/sh\n[ "$1" = --print-architecture ] && echo "$FAKE_ARCH"\n`,
  "dpkg-query": `#!/bin/sh\nfor last; do :; done\n[ -e "$FAKE_STATE/$last" ] && printf 'ii '\nexit 0\n`,
  "apt-get": `#!/bin/sh
# The -o settings go to their own log (each call must bound its network time); the rest to FAKE_LOG.
opts= words=
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then opts="$opts $2"; shift 2; else words="$words $1"; shift; fi
done
echo "apt-get$opts" >> "$FAKE_LOG.apt-opts"
echo "apt-get$words" >> "$FAKE_LOG"
set -- $words
[ "$1" = update ] && exit 0
for p; do
  case $p in
    -*|install) ;;
    */btrfs-progs_*.deb)
      basename "$p" | sed -e "s/^btrfs-progs_//" -e "s/[-_].*//" > "$FAKE_STATE/btrfs-version" ;;
    *)
      touch "$FAKE_STATE/$p"
      case $p in
        fish|ksh|mksh) printf '#!/bin/sh\\n' > "$FAKE_BIN/$p"; chmod +x "$FAKE_BIN/$p" ;;
        powershell) printf '#!/bin/sh\\n' > "$FAKE_BIN/pwsh"; chmod +x "$FAKE_BIN/pwsh" ;;
        qemu-user-static|qemu-user-binfmt)
          mkdir -p "$WORKBOX_TOOLS_ROOT/usr/lib/binfmt.d"
          for a in aarch64 x86_64; do
            printf ':qemu-%s:M::\\\\x7fELF:\\\\xff:/usr/libexec/qemu-binfmt/%s-binfmt-P:POCF\\n' "$a" "$a" > "$WORKBOX_TOOLS_ROOT/usr/lib/binfmt.d/qemu-$a.conf"
          done ;;
      esac ;;
  esac
done
`,
  curl: `#!/bin/sh
for last; do :; done
out=
while [ "$#" -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
echo "curl $last" >> "$FAKE_LOG"
echo "$*" >> "$FAKE_LOG.curl-args"
cp "$FAKE_DOWNLOADS/$(basename "$last")" "$out" 2>/dev/null || exit 22
`,
  "apt-cache": `#!/bin/sh\nfor last; do :; done\ncase " $FAKE_NO_CANDIDATE " in *" $last "*) echo "  Candidate: (none)" ;; *) echo "  Candidate: 1:1.0" ;; esac\n`,
  btrfs: `#!/bin/sh\n[ "$1" = --version ] && [ -s "$FAKE_STATE/btrfs-version" ] && echo "btrfs-progs v$(cat "$FAKE_STATE/btrfs-version")"\n`,
  systemctl: `#!/bin/sh\ncase $1 in is-*) exit 0 ;; esac\necho "systemctl $*" >> "$FAKE_LOG"\n`,
  "systemd-binfmt": `#!/bin/sh
echo "systemd-binfmt $*" >> "$FAKE_LOG"
name=$(grep -v '^#' "$1" | head -n 1 | cut -d: -f2)
flags=$(grep -v '^#' "$1" | head -n 1 | awk -F: '{ print $NF }')
printf 'enabled\\ninterpreter /usr/libexec/qemu-binfmt/x\\nflags: %s\\n' "$flags" > "$WORKBOX_PROC_DIR/sys/fs/binfmt_misc/$name"
`,
}

let n = 0
/** A scratch host: the script (and the files it reads beside it) in a tree, a root, a /proc, fakes and served files. */
const host = (opts: { arch?: string; pins?: Record<string, string>; noCandidate?: string; btrfs?: string } = {}) => {
  const dir = join(scratch, `host-${n++}`)
  const workbox = join(dir, "tree", "workbox")
  mkdirSync(join(workbox, "systemd"), { recursive: true })
  cpSync(underTest, join(workbox, "system-tools.sh"))
  chmodSync(join(workbox, "system-tools.sh"), 0o755)
  cpSync(join(workboxDir, "systemd", "reserve"), join(workbox, "systemd", "reserve"), { recursive: true })
  for (const dir of ["slices", "tmp", "disk-free"]) cpSync(join(workboxDir, "systemd", dir), join(workbox, "systemd", dir), { recursive: true })
  cpSync(join(workboxDir, "slices.conf"), join(workbox, "slices.conf"))
  const pins = Object.entries(opts.pins ?? {}).reduce(
    (text, [name, value]) => text.replace(new RegExp(`^${name}=.*$`, "m"), `${name}=${value}`),
    pinsText,
  )
  writeFileSync(join(dir, "pins.conf"), pins)
  const root = join(dir, "root")
  const proc = join(dir, "proc")
  const bin = join(dir, "bin")
  const state = join(dir, "state")
  const downloads = join(dir, "downloads")
  for (const path of [join(root, "etc", "apt", "sources.list.d"), join(proc, "sys", "fs", "binfmt_misc"), bin, state, downloads]) mkdirSync(path, { recursive: true })
  writeFileSync(join(proc, "sys", "fs", "binfmt_misc", "register"), "")
  writeFileSync(join(root, "etc", "os-release"), 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n')
  // The installed btrfs-progs: new enough by default, so the other cases download no package.
  if ((opts.btrfs ?? "6.17.1") !== "") writeFileSync(join(state, "btrfs-version"), `${opts.btrfs ?? "6.17.1"}\n`)
  for (const [name, text] of Object.entries(fakes)) {
    writeFileSync(join(bin, name), text)
    chmodSync(join(bin, name), 0o755)
  }
  symlinkSync(gpg, join(bin, "gpg"))
  const log = join(dir, "log")
  writeFileSync(log, "")
  const env = {
    HOME: dir,
    TMPDIR: dir,
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    WORKBOX_TOOLS_ROOT: root,
    WORKBOX_TOOLS_PROC: proc,
    WORKBOX_PROC_DIR: proc,
    WORKBOX_PINS: join(dir, "pins.conf"),
    FAKE_ARCH: opts.arch ?? "amd64",
    FAKE_STATE: state,
    FAKE_BIN: bin,
    FAKE_LOG: log,
    FAKE_DOWNLOADS: downloads,
    FAKE_NO_CANDIDATE: opts.noCandidate ?? "",
    COPYFILE_DISABLE: "1",
  }
  const run = (...args: Array<string>) => {
    const done = Bun.spawnSync(["sh", join(workbox, "system-tools.sh"), ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" })
    return { code: done.exitCode, stdout: done.stdout.toString(), stderr: done.stderr.toString() }
  }
  // What the script left in TMPDIR (its scratch dir, a key, a list): nothing, on every exit path.
  const leftovers = () => readdirSync(dir).filter((name) => name.startsWith("tmp."))
  const logLines = () => readFileSync(log, "utf8").split("\n").filter(Boolean)
  return { dir, root, proc, downloads, run, logLines, leftovers, local: join(root, "usr", "local"), tree: workbox }
}

/** A Go tarball as go.dev lays it out (go/VERSION, go/bin/go, go/bin/gofmt), holding `version`. */
const goTarball = (dir: string, version: string, name: string) => {
  const src = join(dir, `src-${version}-${n++}`)
  mkdirSync(join(src, "go", "bin"), { recursive: true })
  writeFileSync(join(src, "go", "VERSION"), `go${version}\ntime 2026-11-01T00:00:00Z\n`)
  for (const tool of ["go", "gofmt"]) {
    writeFileSync(join(src, "go", "bin", tool), `#!/bin/sh\necho ${tool} go${version}\n`)
    chmodSync(join(src, "go", "bin", tool), 0o755)
  }
  const out = join(dir, name)
  const made = Bun.spawnSync(["tar", "-czf", out, "-C", src, "go"], { env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" } })
  if (made.exitCode !== 0) throw new Error(made.stderr.toString())
  return out
}
const sha256 = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex")

const tarballName = `go${goVersion}.linux-amd64.tar.gz`
/** A host served a tarball of the pinned version, with its sha as the pin (the real sha is go.dev's tarball's). */
const goHost = (opts: { arch?: string } = {}) => {
  const probe = join(scratch, `tarball-${n++}`)
  mkdirSync(probe)
  const tarball = goTarball(probe, goVersion, tarballName)
  const h = host({ ...opts, pins: { GO_SHA256: sha256(tarball) } })
  cpSync(tarball, join(h.downloads, tarballName))
  return h
}

/** Every path under the scratch root and /proc, with its link target or content hash: what a run changed. */
const snapshot = (...dirs: Array<string>) => {
  const out: Array<string> = []
  const walk = (path: string) => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) out.push(`${path} -> ${readlinkSync(path)}`)
    else if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name))
    else out.push(`${path} ${stat.mode.toString(8)} ${sha256(path)}`)
  }
  for (const dir of dirs) walk(dir)
  return out
}

const reserveFiles = ["system/user.slice.d", "system/user-.slice.d", "system/user@.service.d", "user/app.slice.d", "user/opencode-service-.scope.d"].map(
  (dir) => `${dir}/30-workbox-reserve.conf`,
)

describe("system-tools.sh installs the pinned tools, once", () => {
  test("every step on a fresh amd64 root installs; a second run changes nothing; --check passes", () => {
    const h = goHost()
    cpSync(join(import.meta.dir, "fixtures", "microsoft.asc"), join(h.downloads, "microsoft.asc"))
    const first = h.run()
    expect(first.stderr).toBe("")
    expect(first.code).toBe(0)
    // Go: the versioned tree, the link to it, the command links.
    expect(readlinkSync(join(h.local, "go"))).toBe(`go-${goVersion}`)
    expect(readFileSync(join(h.local, `go-${goVersion}`, "VERSION"), "utf8")).toStartWith(`go${goVersion}\n`)
    expect(readlinkSync(join(h.local, "bin", "go"))).toBe("../go/bin/go")
    expect(readlinkSync(join(h.local, "bin", "gofmt"))).toBe("../go/bin/gofmt")
    expect(readdirSync(h.local).filter((name) => name.startsWith(".go-install"))).toEqual([])
    // qemu: the binfmt entry for the other architecture, with F.
    expect(readFileSync(join(h.proc, "sys", "fs", "binfmt_misc", "qemu-aarch64"), "utf8")).toContain("flags: POCF")
    // PowerShell: the key (the pinned one), the source line for this release, the package.
    const keyring = join(h.root, "usr", "share", "keyrings", "microsoft-prod.gpg")
    const shown = Bun.spawnSync([gpg, "--batch", "--show-keys", "--with-colons", keyring], { env: { GNUPGHOME: mkdtempSync(join(h.dir, "g")), PATH: "/usr/bin:/bin" } })
    expect(shown.stdout.toString()).toContain(`fpr:::::::::${keyFingerprint}:`)
    expect(readFileSync(join(h.root, "etc", "apt", "sources.list.d", "microsoft-prod.list"), "utf8")).toBe(
      "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/ubuntu/24.04/prod noble main\n",
    )
    // The reserve: each drop-in, then one daemon-reload (no restart).
    for (const file of reserveFiles)
      expect(readFileSync(join(h.root, "etc", "systemd", file), "utf8")).toBe(readFileSync(join(workboxDir, "systemd", "reserve", file), "utf8"))
    const installs = h.logLines().filter((line) => line.startsWith("apt-get install"))
    expect(installs.map((line) => line.split(" ").filter((word) => !word.startsWith("-")).slice(2))).toEqual([["fish", "ksh", "mksh"], ["qemu-user-static"], ["powershell"]])
    // The run families: a slice unit each for the user manager, a drop-in each for the system's slices.
    expect(readFileSync(join(h.root, "etc", "systemd", "user", "ergo.slice"), "utf8")).toContain("[Slice]\nCPUWeight=20\nCPUQuota=1000%\nIOWeight=20\nMemoryHigh=80%\n")
    expect(readFileSync(join(h.root, "etc", "systemd", "system", "user.slice.d", "40-workbox-slices.conf"), "utf8")).toContain("[Slice]\nCPUWeight=100\nIOWeight=100\n")
    expect(readFileSync(join(h.root, "etc", "systemd", "system", "user@.service.d", "40-workbox-delegate.conf"), "utf8")).toContain("Delegate=cpu io memory pids")
    // /tmp's rules and the guard; the free-space script, its unit and timer.
    for (const [src, dest] of [
      ["tmp/tmpfiles.d/tmp.conf", "etc/tmpfiles.d/tmp.conf"],
      ["tmp/system/systemd-tmpfiles-clean.service.d/30-workbox-held.conf", "etc/systemd/system/systemd-tmpfiles-clean.service.d/30-workbox-held.conf"],
      ["tmp/workbox-tmp-clean", "usr/local/sbin/workbox-tmp-clean"],
      ["disk-free/workbox-disk-free", "usr/local/sbin/workbox-disk-free"],
      ["disk-free/workbox-disk-free.timer", "etc/systemd/system/workbox-disk-free.timer"],
    ])
      expect(readFileSync(join(h.root, dest), "utf8")).toBe(readFileSync(join(workboxDir, "systemd", src), "utf8"))
    // A daemon-reload for each step that installed units; the new timer started; no restart.
    expect(h.logLines().filter((line) => line.startsWith("systemctl"))).toEqual([
      "systemctl daemon-reload",
      "systemctl daemon-reload",
      "systemctl daemon-reload",
      "systemctl daemon-reload",
      "systemctl enable --now workbox-disk-free.timer",
    ])
    expect(h.logLines().filter((line) => line.startsWith("curl"))).toEqual([`curl https://go.dev/dl/${tarballName}`, "curl https://packages.microsoft.com/keys/microsoft.asc"])
    // Every download is bounded in time, so a stalled one fails instead of hanging the provisioning.
    for (const args of readFileSync(join(h.dir, "log.curl-args"), "utf8").split("\n").filter(Boolean)) expect(args).toMatch(/--connect-timeout \d+ --max-time \d+ --retry \d/)
    for (const opts of readFileSync(join(h.dir, "log.apt-opts"), "utf8").split("\n").filter(Boolean)) expect(opts).toMatch(/Acquire::https?::Timeout=\d+ .*Acquire::Retries=\d/)

    const before = snapshot(h.root, h.proc)
    const logged = h.logLines().length
    const second = h.run()
    expect(second.code).toBe(0)
    expect(second.stderr).toBe("")
    expect(second.stdout.split("\n").filter((line) => line.startsWith("==>"))).toEqual([])
    expect(snapshot(h.root, h.proc)).toEqual(before)
    expect(h.logLines().slice(logged)).toEqual([])

    expect(h.run("--check")).toMatchObject({ code: 0, stderr: "" })
    expect(h.leftovers()).toEqual([])
  })

  test("an older Go, installed by hand as a real /usr/local/go, is replaced by the link; the old tree is gone", () => {
    const h = goHost()
    mkdirSync(join(h.local, "go", "bin"), { recursive: true })
    writeFileSync(join(h.local, "go", "VERSION"), "go1.0.1\n")
    expect(h.run("go")).toMatchObject({ code: 0, stderr: "" })
    expect(readlinkSync(join(h.local, "go"))).toBe(`go-${goVersion}`)
    expect(readdirSync(h.local).sort()).toEqual(["bin", "go", `go-${goVersion}`])
  })

  test("an older managed Go (a link to go-<old>) is swapped in one rename; the old tree is removed", () => {
    const h = goHost()
    mkdirSync(join(h.local, "go-1.0.1", "bin"), { recursive: true })
    writeFileSync(join(h.local, "go-1.0.1", "VERSION"), "go1.0.1\n")
    symlinkSync("go-1.0.1", join(h.local, "go"))
    expect(h.run("go")).toMatchObject({ code: 0, stderr: "" })
    expect(readlinkSync(join(h.local, "go"))).toBe(`go-${goVersion}`)
    expect(existsSync(join(h.local, "go-1.0.1"))).toBe(false)
    expect(h.run("--check", "go").code).toBe(0)
  })

  test("a release without qemu-user-static (Ubuntu 26.04) gets qemu-user-binfmt, which provides it; the rerun installs nothing", () => {
    const h = host({ noCandidate: "qemu-user-static" })
    expect(h.run("qemu")).toMatchObject({ code: 0, stderr: "" })
    expect(h.logLines().filter((line) => line.startsWith("apt-get install"))).toEqual(["apt-get install -y -q qemu-user-binfmt"])
    const logged = h.logLines().length
    expect(h.run("qemu").stdout).not.toContain("==>")
    expect(h.logLines().slice(logged)).toEqual([])
    expect(h.run("--check", "qemu").code).toBe(0)
  })

  test("a qemu entry registered without the F flag (or disabled) is registered again with it", () => {
    const h = host()
    writeFileSync(join(h.proc, "sys", "fs", "binfmt_misc", "qemu-aarch64"), "enabled\ninterpreter /usr/bin/qemu-aarch64-static\nflags: OC\n")
    expect(h.run("qemu")).toMatchObject({ code: 0, stderr: "" })
    expect(readFileSync(join(h.proc, "sys", "fs", "binfmt_misc", "qemu-aarch64"), "utf8")).toContain("flags: POCF")
    expect(h.logLines()).toContain(`systemd-binfmt ${join(h.root, "usr", "lib", "binfmt.d", "qemu-aarch64.conf")}`)
  })
})

const btrfsDeb = pin("BTRFS_PROGS_DEB_URL").split("/").at(-1) ?? ""
/** A host with btrfs-progs `version` installed, served a package (its sha the pin unless `servedSha` differs). */
const btrfsHost = (version: string, opts: { arch?: string; tampered?: boolean } = {}) => {
  const probe = join(scratch, `deb-${n++}`)
  mkdirSync(probe)
  writeFileSync(join(probe, btrfsDeb), "a btrfs-progs package\n")
  const h = host({ arch: opts.arch, btrfs: version, pins: { BTRFS_PROGS_SHA256: sha256(join(probe, btrfsDeb)) } })
  writeFileSync(join(h.downloads, btrfsDeb), opts.tampered === true ? "another package\n" : "a btrfs-progs package\n")
  return h
}

describe("system-tools.sh btrfs: btrfs-progs with simple quotas", () => {
  test("an older btrfs-progs (Ubuntu 24.04's) gets the pinned package, checked; the rerun changes nothing", () => {
    const h = btrfsHost("6.6.3")
    const first = h.run("btrfs")
    expect(first).toMatchObject({ code: 0, stderr: "" })
    expect(first.stdout).toContain("installed btrfs-progs 6.16")
    expect(h.logLines().filter((line) => line.startsWith("curl"))).toEqual([`curl ${pin("BTRFS_PROGS_DEB_URL")}`])
    const installs = h.logLines().filter((line) => line.startsWith("apt-get install"))
    expect(installs).toHaveLength(1)
    expect(installs[0]).toEndWith(`/${btrfsDeb}`)
    const logged = h.logLines().length
    expect(h.run("btrfs").stdout).not.toContain("==>")
    expect(h.logLines().slice(logged)).toEqual([])
    expect(h.run("--check", "btrfs").code).toBe(0)
    expect(h.leftovers()).toEqual([])
  })

  test("a new enough btrfs-progs (or a newer release's) is left as it is: no download", () => {
    const h = btrfsHost("6.7")
    expect(h.run("btrfs")).toMatchObject({ code: 0, stdout: "ok: btrfs-progs 6.7 (simple quotas)\n" })
    expect(h.logLines()).toEqual([])
  })

  test("the --check of an older one fails, naming it", () => {
    const h = btrfsHost("6.6.3")
    const done = h.run("--check", "btrfs")
    expect(done.code).toBe(1)
    expect(done.stderr).toContain("6.6.3 is older than 6.7")
  })
})

describe("system-tools.sh slices: the run families from slices.conf", () => {
  test("each line makes its unit or drop-in; a changed value is rewritten; --check sees a hand edit", () => {
    const h = host()
    expect(h.run("slices")).toMatchObject({ code: 0, stderr: "" })
    const conf = readFileSync(join(workboxDir, "slices.conf"), "utf8")
    const lines = conf.split("\n").map((line) => line.replace(/#.*/, "").trim()).filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const [unit, manager, ...settings] = line.split(/\s+/)
      const path = manager === "user" ? join(h.root, "etc", "systemd", "user", unit) : join(h.root, "etc", "systemd", "system", `${unit}.d`, "40-workbox-slices.conf")
      expect(readFileSync(path, "utf8")).toEndWith(`[Slice]\n${settings.join("\n")}\n`)
    }
    expect(h.logLines()).toEqual(["systemctl daemon-reload"])
    expect(h.run("slices").stdout).toBe(`ok: slices from ${join(h.tree, "slices.conf")}\n`)
    expect(h.run("--check", "slices").code).toBe(0)
    // A hand edit of an installed slice: --check names it; the step puts slices.conf's back.
    const ergo = join(h.root, "etc", "systemd", "user", "ergo.slice")
    writeFileSync(ergo, readFileSync(ergo, "utf8").replace("CPUWeight=20", "CPUWeight=90"))
    expect(h.run("--check", "slices")).toMatchObject({ code: 1, stderr: expect.stringContaining("ergo.slice is not what slices.conf makes") })
    expect(h.run("slices").stdout).toContain(`installed ${ergo}`)
    expect(readFileSync(ergo, "utf8")).toContain("CPUWeight=20\n")
    expect(h.leftovers()).toEqual([])
  })

  test("a line that is not a slice, or names another manager, is refused", () => {
    const h = host()
    writeFileSync(join(h.tree, "slices.conf"), "ergo.service user CPUWeight=1\n")
    expect(h.run("slices")).toMatchObject({ code: 1, stderr: expect.stringContaining("ergo.service is not a slice name") })
    writeFileSync(join(h.tree, "slices.conf"), "ergo.slice root CPUWeight=1\n")
    expect(h.run("slices")).toMatchObject({ code: 1, stderr: expect.stringContaining("names manager root") })
  })
})

describe("system-tools.sh refuses, and changes nothing", () => {
  test("a btrfs-progs package whose sha256 is not the pin: refused before it is installed", () => {
    const h = btrfsHost("6.6.3", { tampered: true })
    const before = snapshot(h.root)
    const done = h.run("btrfs")
    expect(done.code).toBe(1)
    expect(done.stderr).toContain("not the pinned")
    expect(done.stderr).toContain("nothing was installed")
    expect(h.logLines().filter((line) => line.startsWith("apt-get"))).toEqual([])
    expect(snapshot(h.root)).toEqual(before)
    expect(h.leftovers()).toEqual([])
  })

  test("an older btrfs-progs on another architecture: refused before any download", () => {
    const h = btrfsHost("6.6.3", { arch: "arm64" })
    const done = h.run("btrfs")
    expect(done.code).toBe(1)
    expect(done.stderr).toContain("this host is arm64")
    expect(h.logLines()).toEqual([])
  })

  test("a tarball whose sha256 is not the pin: refused before unpacking; nothing installed, an older Go untouched", () => {
    const h = goHost()
    // The pin is the good tarball's; go.dev now serves another one.
    goTarball(h.downloads, goVersion, tarballName)
    mkdirSync(join(h.local, "go"), { recursive: true })
    writeFileSync(join(h.local, "go", "VERSION"), "go1.0.1\n")
    const before = snapshot(h.root)
    const done = h.run("go")
    expect(done.code).toBe(1)
    expect(done.stderr).toContain("not the pinned")
    expect(done.stderr).toContain("nothing was installed")
    expect(snapshot(h.root)).toEqual(before)
    expect(h.leftovers()).toEqual([])
    expect(readdirSync(h.local).filter((name) => name.startsWith(".go-install"))).toEqual([])
  })

  test("another architecture: Go and PowerShell refused before any download", () => {
    const h = goHost({ arch: "arm64" })
    cpSync(join(import.meta.dir, "fixtures", "microsoft.asc"), join(h.downloads, "microsoft.asc"))
    const before = snapshot(h.root)
    const go = h.run("go")
    expect(go.code).toBe(1)
    expect(go.stderr).toContain("linux-amd64 only")
    expect(go.stderr).toContain("this host is arm64")
    const pwsh = h.run("pwsh")
    expect(pwsh.code).toBe(1)
    expect(pwsh.stderr).toContain("this host is arm64")
    expect(h.logLines()).toEqual([])
    expect(snapshot(h.root)).toEqual(before)
  })

  test("a Microsoft key whose fingerprint is not the pin: refused; no keyring, no source, no package", () => {
    const h = host()
    cpSync(join(import.meta.dir, "fixtures", "not-microsoft.asc"), join(h.downloads, "microsoft.asc"))
    const before = snapshot(h.root)
    const done = h.run("pwsh")
    expect(done.code).toBe(1)
    expect(done.stderr).toContain(`not the pinned ${keyFingerprint}`)
    expect(done.stderr).toContain("nothing was installed")
    expect(snapshot(h.root)).toEqual(before)
    expect(h.logLines().filter((line) => line.startsWith("apt-get"))).toEqual([])
    expect(h.leftovers()).toEqual([])
  })

  test("a keyring already in place with another key is not trusted: the key is fetched and checked again", () => {
    const h = host()
    cpSync(join(import.meta.dir, "fixtures", "not-microsoft.asc"), join(h.downloads, "microsoft.asc"))
    mkdirSync(join(h.root, "usr", "share", "keyrings"), { recursive: true })
    cpSync(join(import.meta.dir, "fixtures", "not-microsoft.asc"), join(h.root, "usr", "share", "keyrings", "microsoft-prod.gpg"))
    expect(h.run("pwsh").code).toBe(1)
    expect(h.run("--check", "pwsh").code).toBe(1)
  })
})

describe("pins.conf is the one place the pins are typed", () => {
  test("its values are well formed", () => {
    expect(goVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(goSha).toMatch(/^[0-9a-f]{64}$/)
    expect(keyFingerprint).toMatch(/^[0-9A-F]{40}$/)
    expect(pin("BTRFS_PROGS_SHA256")).toMatch(/^[0-9a-f]{64}$/)
  })

  test("no other file in the repository holds the Go sha, the key fingerprint, the Go version or the btrfs-progs package and sha", () => {
    const spaced = keyFingerprint.match(/.{4}/g)?.join(" ") ?? keyFingerprint
    const needles = [goSha, keyFingerprint, spaced, pin("BTRFS_PROGS_SHA256"), btrfsDeb, `go${goVersion}`, `go-${goVersion}`, `Go ${goVersion}`, `GO_VERSION=${goVersion}`]
    // Tracked and untracked (not ignored) files: a pin typed into a new file counts too. Exit 1: none.
    const found = Bun.spawnSync(
      ["git", "grep", "--untracked", "-I", "-n", "-F", ...needles.flatMap((needle) => ["-e", needle]), "--", ".", ":(exclude)workbox/pins.conf"],
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    )
    expect(found.stderr.toString()).toBe("")
    expect(found.stdout.toString()).toBe("")
    expect(found.exitCode).toBe(1)
  }, 60_000)
})
