// @reads all
// @reads-reason computed read at tests/review-input-publication.test.ts: const read = (file: string) => fs.readFileString(path.join(root, file))
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { describe, expect, it } from "effect-bun-test"

// Both observers exercise the public producers, including the second sink of a round receipt.
const WRITERS = `
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { strict as assert } from "node:assert";
const [rootArg, code, role, nameArg, maskArg] = process.argv.slice(2);
const root = realpathSync(rootArg);
if (role === "writer") {
  // Instrument the actual adapter at its filesystem boundary, only in this child. The creating open
  // and rename are still the real OS calls. A one-byte release from the observer permits the rename.
  Bun.plugin({ name: "review publication barrier", setup(builder) {
    builder.onLoad({ filter: /\\/work\\/process\\/landing\\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const before = "yield* io(() => renameSync(temp, file))";
      const open = /openSync\\(temp, "wx"[^\\n]*?\\)(?=\\))/;
      if (source.split(before).length !== 2 || !open.test(source)) throw new Error("lost publication barrier");
      const hook = \`
import { fstatSync as fixtureStat, readSync as release, writeSync as report } from "node:fs";
const signal = (value) => report(1, JSON.stringify(value) + "\\\\n");
const opened = (fd, temp, file) => {
  if (file === globalThis.__observedPublication) signal({ created: fixtureStat(fd).mode & 0o777, temp });
  return fd;
};
const beforeRename = (temp, file) => {
  if (file !== globalThis.__observedPublication) return;
  signal({ ready: temp });
  if (release(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error("observer closed the barrier");
};
\`;
      return { loader: "ts", contents: hook + source
        .replace(open, (call) => "opened(" + call + ", temp, file)")
        .replace(before, "yield* io(() => beforeRename(temp, file)); " + before) };
    });
  } });
}
const { Effect, Option } = await import(code + "/node_modules/effect/dist/index.js");
const work = await import(code + "/mods/work/process/landing.ts");
const { Landing } = await import(code + "/mods/work/service.ts");
const records = await import(code + "/mods/update/filestore/records.ts");
const marks = await import(code + "/mods/update/process/mark.ts");
const { stageBuild } = await import(code + "/mods/update/filestore/stage.ts");
const { Records, HandoffMark } = await import(code + "/mods/update/service.ts");
const run = Effect.runPromise;
// Count the publisher's resource classes (lock, temp, directory). The controller also has
// writer and Git subprocess sockets of its own; the independent reader law counts all fds.
const fdCount = () => readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").filter((fd) => {
  try {
    const stat = fstatSync(Number(fd));
    return stat.isFile() || stat.isDirectory() || stat.isFIFO();
  } catch (error) {
    if (error.code === "EBADF") return false;
    throw error;
  }
}).length;
async function retainingFds(label, step) {
  const before = fdCount();
  try { return await step(); }
  finally { assert.equal(fdCount(), before, "descriptor count after " + label); }
}
const sha = (digit) => digit.repeat(40);
const sites = ["receipt", "git-mirror", "land", "stage", "install", "handoff"];
function layout(root) {
  const logs = join(root, "logs");
  const receipts = join(logs, "receipts");
  const record = join(root, "state", "installed.json");
  const mark = join(root, "state", "handoff.json");
  const options = { record, launcher: join(root, "bin", "oc"), resident: root };
  const head = sha("2");
  const receipt = (n) => ({ head, tree: sha("5"), kind: "round", repo: root, at: "2026-11-23T01:00:00.000Z", checks: [{ command: "fixture " + n, code: n, seconds: 1 }] });
  const build = (n) => ({ ...options, built: join(root, "build"), share: join(root, "share"), version: "2.2.7-prime." + n + n, pid: 1000 + n,
    lock: join(root, "state", "builds.lock"), dotfiles: sha(String(n)), fork: sha(String(n)) });
  const keep = (n) => run(work.receipts(logs).write(receipt(n)));
  const land = (n) => run(Landing.use((x) => x.record({ head, base: sha("1"), units: [], merge: Option.some({ ...receipt(n), kind: "merge" }), at: receipt(n).at })).pipe(Effect.provide(work.layer({ logs }))));
  const install = (n) => run(Records.use((store) => store.write({ version: String(n), command: ["/fixture/oc"], dotfiles: sha(String(n)), fork: sha(String(n)), superseded: [] })).pipe(Effect.provide(records.layer(options, 2000 + n))));
  const marker = (n) => run(HandoffMark.use((x) => x.hold).pipe(Effect.provide(marks.layer(mark, 1000 + n))));
  const names = { receipt: [join(receipts, head + ".round.json"), keep], "git-mirror": [join(root, ".git", "rift-receipt.json"), keep],
    land: [join(receipts, head + ".land.json"), land], stage: [record, (n) => stageBuild(build(n))], install: [record, install], handoff: [mark, marker] };
  return { logs, receipts, record, mark, head, names, build };
}
function prepare(root, file) {
  if (!existsSync(join(root, ".git"))) {
    const git = Bun.spawnSync(["git", "init", "--quiet", root]);
    if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  }
  writeFileSync(join(root, "build"), "fixture");
  if (file) mkdirSync(dirname(file), { recursive: true });
}
if (role === "writer") {
  const [file, put] = layout(root).names[nameArg];
  globalThis.__observedPublication = file;
  process.umask(Number(maskArg));
  await put(2);
  process.exit(0);
}
if (role === "try-unsafe") {
  const [file, put] = layout(root).names[nameArg];
  try {
    await put(2);
  } catch (refusal) {
    if (refusal._tag !== "RiftFailed" && refusal._tag !== "UpdateFailed") throw refusal;
    console.log("typed refusal: " + refusal._tag);
    process.exit(2);
  }
  console.log("published");
  process.exit(0);
}
if (role === "refuse-and-recover") {
  const [file, put] = layout(root).names[nameArg];
  await retainingFds(nameArg + " refusal", () => assert.rejects(async () => put(2), (error) =>
    error._tag === "RiftFailed" || error._tag === "UpdateFailed"));
  rmSync(file, { recursive: true });
  await retainingFds(nameArg + " recovery", () => put(3));
  JSON.parse(readFileSync(file, "utf8"));
  console.log("refused and republished in one process");
  process.exit(0);
}
if (role === "refuse-under-lock") {
  const { build, record, names } = layout(root);
  const { dlopen, FFIType } = await import("bun:ffi");
  const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  try {
    let entered = false;
    assert.throws(() => stageBuild(build(2), (fd, op) => {
      assert.equal(libc.symbols.flock(fd, op), 0);
      assert.equal(Bun.spawnSync(["mkfifo", record]).exitCode, 0);
      entered = true;
      return 0;
    }), (error) => error._tag === "RiftFailed");
    assert.ok(entered, "the refusal must happen while actually holding the builds lock");
    unlinkSync(record);
    await names.stage[1](3);
    JSON.parse(readFileSync(record, "utf8"));
    console.log("racing hold: refused and recovered under real builds lock");
  } finally { libc.close(); }
  process.exit(0);
}
`

// Hold the old fd across publication, so in-place writes fail without a racing poll.
const OBSERVER = WRITERS + `
const { names } = layout(root);
prepare(root);
const cases = sites.map((name) => {
  const [file, put] = names[name];
  return [name, () => put(1), () => put(2), file];
});
for (const [name, putOld, putNew, path] of cases) {
  await putOld();
  const old = readFileSync(path, "utf8");
  const fd = openSync(path, "r");
  try {
    const identity = fstatSync(fd);
    await retainingFds(name + " replacement", putNew);
    const after = readFileSync(path, "utf8");
    const held = readFileSync(fd, "utf8");
    JSON.parse(old); JSON.parse(after);
    const facts = [held === old, old !== after, String(identity.ino) !== String(statSync(path).ino)];
    console.log([name, ...facts].join(":"));
    if (!facts.every(Boolean)) process.exitCode = 1;
  } finally { closeSync(fd); }
}
`

const MATRIX = WRITERS + `
const { ReceiptSource, SourceRef } = await import(code + "/mods/orchestrate/batch-input.ts");
const { receiptSource } = await import(code + "/mods/orchestrate/filestore/receipt-source.ts");
const BunServices = await import(code + "/node_modules/@effect/platform-bun/dist/BunServices.js");
const maybeText = (path) => existsSync(path) ? readFileSync(path, "utf8") : undefined;
const modeOf = (path) => statSync(path).mode & 0o777;
async function readPublished(root, layout, name, expected) {
  if (name === "git-mirror") {
    const read = await run(work.receipts(layout.logs).newest(root));
    if (expected === undefined) assert.equal(read._tag, "None");
    else {
      assert.equal(read._tag, "Some");
      assert.deepEqual(read.value, JSON.parse(expected));
    }
    return;
  }
  const ref = name === "receipt" ? SourceRef.Receipt({ head: layout.head, kind: "round" })
    : name === "land" ? SourceRef.Land({ head: layout.head })
    : name === "handoff" ? SourceRef.Handoff() : SourceRef.Installed();
  const source = receiptSource({ host: "fixture", repository: { key: "fixture", checkouts: [root] }, receipts: layout.receipts,
    installed: layout.record, handoff: layout.mark, maxBytes: 65536, readWithin: "1 second" });
  const read = await run(ReceiptSource.use((files) => files.read(ref)).pipe(Effect.provide(source), Effect.provide(BunServices.layer)));
  if (expected === undefined) assert.equal(read._tag, "Absent");
  else assert.deepEqual({ tag: read._tag, text: read.text }, { tag: "Present", text: expected });
}
async function check(name, umask, existing, crash) {
  const fixture = mkdtempSync(join(root, name + "-"));
  const paths = layout(fixture);
  const [file, put] = paths.names[name];
  prepare(fixture, file);
  if (existing !== undefined) {
    await retainingFds(name + " initial publication", () => put(1));
    chmodSync(file, existing);
  }
  const old = maybeText(file);
  const ceiling = name === "stage" || name === "install" ? 0o640 : 0o600;
  const allowed = (existing ?? 0o600) & ceiling & ~umask;
  const child = Bun.spawn([process.execPath, import.meta.path, fixture, code, "writer", name, String(umask)], {
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  const out = child.stdout.getReader();
  let buffered = "";
  async function line() {
    while (!buffered.includes("\\n")) {
      const { done, value } = await out.read();
      if (done) throw new Error("writer did not reach its barrier: " + name);
      buffered += new TextDecoder().decode(value);
    }
    const index = buffered.indexOf("\\n");
    const item = buffered.slice(0, index);
    buffered = buffered.slice(index + 1);
    return JSON.parse(item);
  }
  try {
    const atOpen = await line();
    const { ready: temp } = await line();
    assert.equal(temp, atOpen.temp);
    assert.equal(dirname(temp), dirname(file));
    assert.ok(basename(temp).startsWith(".review-input-"));
    const mode = modeOf(temp);
    const label = [name, umask.toString(8), existing?.toString(8) ?? "absent", mode.toString(8)].join("/");
    assert.equal(atOpen.created & ~allowed, 0, "widened at creation: " + label);
    assert.equal(mode & ~allowed, 0, "widened before rename: " + label);
    assert.equal(maybeText(file), old, "the final name changed before rename: " + label);
    const next = readFileSync(temp, "utf8");
    assert.notEqual(next, old);
    JSON.parse(next);
    if (crash) {
      child.kill("SIGKILL");
      assert.equal(await child.exited, 137);
      assert.equal(maybeText(file), old);
      if (old !== undefined) JSON.parse(old);
      assert.equal(readFileSync(temp, "utf8"), next, "crash must leave the controlled stray temp");
      await retainingFds(name + " old or absent read", () => readPublished(fixture, paths, name, old));
      await retainingFds(name + " recovery publish", () => put(3));
      const recovered = readFileSync(file, "utf8");
      assert.notEqual(recovered, old);
      assert.notEqual(recovered, next);
      await retainingFds(name + " recovery read", () => readPublished(fixture, paths, name, recovered));
      assert.equal(readFileSync(temp, "utf8"), next);
      assert.deepEqual(readdirSync(dirname(file)).filter((part) => part.startsWith(".review-input-")), [basename(temp)]);
    } else {
      child.stdin.write("!");
      child.stdin.end();
      assert.equal(await child.exited, 0);
      assert.equal(modeOf(file), mode, "the renamed inode kept its own mode");
      assert.equal(readFileSync(file, "utf8"), next, "complete version changed at publication");
      assert.equal(existsSync(temp), false);
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}
for (const name of sites) {
  if (role === "crash") {
    for (const existing of [undefined, 0o600]) await check(name, 0o022, existing, true);
    console.log(name + ":killed-before-rename:absent+existing:recovered");
  } else {
    for (const umask of [0o000, 0o022, 0o077])
      for (const existing of [undefined, 0o600, 0o640, 0o644]) await check(name, umask, existing, false);
    console.log(name + ":12/12");
  }
}
`

const DESTINATIONS = WRITERS + `
import { lstatSync } from "node:fs";
import { createServer } from "node:net";
const shapes = ["FIFO", "symlink", "directory", "socket"];
for (const name of sites) {
  for (const shape of shapes) {
    // Keep the UNIX socket pathname short, including on macOS.
    const fixture = mkdtempSync(join(root, "u-"));
    const [file] = layout(fixture).names[name];
    prepare(fixture, file);
    const other = join(fixture, "keep");
    writeFileSync(other, "unchanged");
    let socket;
    if (shape === "FIFO") assert.equal(Bun.spawnSync(["mkfifo", file]).exitCode, 0);
    if (shape === "symlink") symlinkSync(other, file);
    if (shape === "directory") mkdirSync(file);
    if (shape === "socket") {
      socket = createServer();
      // Bind the socket directly at the fixed sink. Relative names avoid sockaddr_un's length limit.
      const cwd = process.cwd();
      process.chdir(dirname(file));
      try { await new Promise((resolve, reject) => socket.once("error", reject).listen(basename(file), resolve)); }
      finally { process.chdir(cwd); }
    }
    const run = (role = "try-unsafe") => Bun.spawnSync([process.execPath, import.meta.path, fixture, code, role, name], {
      timeout: 1500, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const old = lstatSync(file);
    const rejected = run();
    assert.equal(rejected.exitCode, 2, name + "/" + shape + ": " + rejected.stdout + rejected.stderr);
    assert.match(rejected.stdout.toString(), /typed refusal: (?:RiftFailed|UpdateFailed)/);
    if (name === "git-mirror") assert.equal(existsSync(layout(fixture).names.receipt[0]), false, "unsafe mirror must not publish the host receipt");
    const still = lstatSync(file);
    assert.deepEqual([still.ino, still.mode, still.uid], [old.ino, old.mode, old.uid]);
    assert.equal(readFileSync(other, "utf8"), "unchanged");
    if (!socket) {
      const again = run("refuse-and-recover");
      assert.equal(again.exitCode, 0, name + "/same-process recovery: " + again.stdout + again.stderr);
      assert.match(again.stdout.toString(), /refused and republished in one process/);
    }
    if (socket) { await new Promise((resolve) => socket.close(resolve)); }
    if (existsSync(file)) rmSync(file, { recursive: true });
    const recovered = run();
    assert.equal(recovered.exitCode, 0, name + "/recovery: " + recovered.stdout + recovered.stderr);
    JSON.parse(readFileSync(file, "utf8"));
  }
  console.log(name + ":4/4 typed refusal+recovery");
}
const fixture = mkdtempSync(join(root, "race-"));
prepare(fixture, layout(fixture).record);
const raced = Bun.spawnSync([process.execPath, import.meta.path, fixture, code, "refuse-under-lock", "stage"], {
  timeout: 1500, stdin: "ignore", stdout: "pipe", stderr: "pipe",
});
assert.equal(raced.exitCode, 0, "racing builds lock/" + raced.stdout + raced.stderr);
console.log(raced.stdout.toString().trim());
`

const observe = (programText: string, phase: string, expected: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner
    const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "review-publication-" })
    const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
    const program = path.join(fixture, "observe.ts")
    yield* fs.writeFileString(program, programText)
    const child = yield* processes.spawn(ChildProcess.make("bun", [program, fixture, root, phase], { detached: true, stdin: "ignore", forceKillAfter: "100 millis" }))
    const [out, error] = yield* Effect.all([Stream.mkString(Stream.decodeText(child.stdout)), Stream.mkString(Stream.decodeText(child.stderr))], { concurrency: 2 })
    expect({ exit: Number(yield* child.exitCode), error, rows: out.trim().split("\n") }).toEqual({ exit: 0, error: "", rows: [...expected] })
  }).pipe(Effect.scoped, Effect.timeout("55 seconds"))

const sites = ["receipt", "git-mirror", "land", "stage", "install", "handoff"]

describe("review-input publication", () => {
  it.live.layer(BunServices.layer)("each producer replaces its inode; a reader of the old inode still sees the complete old version",
    () => observe(OBSERVER, "descriptor", sites.map((name) => `${name}:true:true:true`)), 60_000)
  it.live.layer(BunServices.layer)("permission matrix: each sink respects policy at the creating open and after replacement",
    () => observe(MATRIX, "mode", sites.map((name) => `${name}:12/12`)), 60_000)
  it.live.layer(BunServices.layer)("crash recovery: kill each fixture writer before rename; read old or absent and publish again with its stray temp still present",
    () => observe(MATRIX, "crash", sites.map((name) => `${name}:killed-before-rename:absent+existing:recovered`)), 60_000)
  it.live.layer(BunServices.layer)("unsafe destination matrix: each public producer refuses each special file and the next call succeeds",
    () => observe(DESTINATIONS, "unsafe", [...sites.map((name) => `${name}:4/4 typed refusal+recovery`),
      "racing hold: refused and recovered under real builds lock"]), 60_000)

  it.live.layer(BunServices.layer)("each review input sink uses its atomic writer, never the general text writer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
      const read = (file: string) => fs.readFileString(path.join(root, file))
      const landing = yield* read("mods/work/process/landing.ts")
      const update = yield* read("mods/update/filestore/files.ts")
      const stage = yield* read("mods/update/filestore/stage.ts")
      const record = yield* read("mods/update/filestore/records.ts")
      const mark = yield* read("mods/update/process/mark.ts")
      expect(landing.match(/yield\* publishReviewInput\("(?:write receipt|land record)", (?:file|kept),/g)).toHaveLength(3)
      expect(landing.match(/writeFileSync\([^,\n]+,/g)).toEqual(["writeFileSync(fd,"])
      expect(landing).toMatch(/openSync\(temp, "wx", allowed\)[\s\S]*?writeFileSync\(fd, text\)[\s\S]*?fsyncSync\(fd\)[\s\S]*?renameSync\(temp, file\)[\s\S]*?fsyncSync\(parent\)/)
      expect(update).toMatch(/publishReviewInput\(step, path, siblingReviewInputLock\(path\), access, text\)/)
      expect(record).toMatch(/publishText\("write the installed record", settings\.record,/)
      expect(mark).toMatch(/publishText\("mark the running handoff", path,/)
      expect(stage).toMatch(/changeReviewInput\(step, stage\.record,/)
      expect(stage).not.toMatch(/(?:writeFileSync|openSync)\(stage\.record|flag: "a\+"/)
    }),
  )
})
