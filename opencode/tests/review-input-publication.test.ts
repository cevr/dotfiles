import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { describe, expect, it } from "effect-bun-test"

// The writer and descriptor observer are in one fixture process. The old descriptor is held across
// publication, so an in-place write fails deterministically without depending on a racing poll.
const OBSERVER = `
import { openSync, closeSync, fstatSync, statSync, readFileSync, writeFileSync } from "node:fs";
const [root, code] = process.argv.slice(2);
const { Effect, Option } = await import(code + "/node_modules/effect/dist/index.js");
const work = await import(code + "/mods/work/process/landing.ts");
const { Landing } = await import(code + "/mods/work/service.ts");
const records = await import(code + "/mods/update/filestore/records.ts");
const marks = await import(code + "/mods/update/process/mark.ts");
const { stageBuild } = await import(code + "/mods/update/filestore/stage.ts");
const { Records, HandoffMark } = await import(code + "/mods/update/service.ts");
const run = Effect.runPromise;
const logs = root + "/receipts-test";
const record = root + "/state/installed.json";
const mark = root + "/state/handoff.json";
const git = Bun.spawnSync(["git", "init", "--quiet", root]);
if (git.exitCode !== 0) throw new Error(git.stderr.toString());
const options = { record, launcher: root + "/bin/oc", resident: root };
const sha = (digit) => digit.repeat(40);
const first = { head: sha("2"), tree: sha("5"), kind: "round", repo: root, at: "2026-11-23T01:00:00.000Z", checks: [{ command: "true", code: 0, seconds: 1 }] };
const second = { ...first, checks: [{ command: "false", code: 1, seconds: 1 }] };
const build = (n) => ({ ...options, built: root + "/build", share: root + "/share", version: "2.2.7-prime." + n + n, pid: 1000 + n,
  lock: root + "/state/builds.lock", dotfiles: sha(String(n)), fork: sha(String(n)) });
writeFileSync(root + "/build", "fixture");
const cases = [
  ["receipt", () => run(work.receipts(logs).write(first)), () => run(work.receipts(logs).write(second)), logs + "/receipts/" + first.head + ".round.json"],
  ["git-mirror", () => run(work.receipts(logs).write(first)), () => run(work.receipts(logs).write(second)), root + "/.git/rift-receipt.json"],
  ["land", () => run(Landing.use((x) => x.record({ head: first.head, base: sha("1"), units: [], merge: firstMerge(first), at: first.at })).pipe(Effect.provide(work.layer({ logs })))),
    () => run(Landing.use((x) => x.record({ head: first.head, base: sha("1"), units: [], merge: firstMerge(second), at: first.at })).pipe(Effect.provide(work.layer({ logs })))),
    logs + "/receipts/" + first.head + ".land.json"],
  ["stage", () => stageBuild(build(1)), () => stageBuild(build(2)), record],
  ["install", () => install(1), () => install(2), record],
  ["handoff", () => marker(1001), () => marker(1002), mark],
];
const firstMerge = (receipt) => Option.some({ ...receipt, kind: "merge" });
const install = (n) => run(Records.use((store) => store.write({ version: String(n), command: ["/fixture/oc"], dotfiles: sha(String(n)), fork: sha(String(n)), superseded: [] })).pipe(Effect.provide(records.layer(options, 2000 + n))));
const marker = (pid) => run(HandoffMark.use((x) => x.hold).pipe(Effect.provide(marks.layer(mark, pid))));
for (const [name, putOld, putNew, path] of cases) {
  await putOld();
  const old = readFileSync(path, "utf8");
  const fd = openSync(path, "r");
  try {
    const identity = fstatSync(fd);
    await putNew();
    const after = readFileSync(path, "utf8");
    const held = readFileSync(fd, "utf8");
    JSON.parse(old); JSON.parse(after);
    const facts = [held === old, old !== after, String(identity.ino) !== String(statSync(path).ino)];
    console.log([name, ...facts].join(":"));
    if (!facts.every(Boolean)) process.exitCode = 1;
  } finally { closeSync(fd); }
}
`

describe("review-input publication", () => {
  it.live.layer(BunServices.layer)("each producer replaces its inode; a reader of the old inode still sees the complete old version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner
      const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "review-publication-" })
      const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
      const program = path.join(fixture, "observe.ts")
      yield* fs.writeFileString(program, OBSERVER)
      const child = yield* processes.spawn(ChildProcess.make("bun", [program, fixture, root], { detached: true, stdin: "ignore", forceKillAfter: "100 millis" }))
      const [out, error] = yield* Effect.all([Stream.mkString(Stream.decodeText(child.stdout)), Stream.mkString(Stream.decodeText(child.stderr))], { concurrency: 2 })
      expect({ exit: Number(yield* child.exitCode), error, rows: out.trim().split("\n") }).toEqual({
        exit: 0,
        error: "",
        rows: ["receipt", "git-mirror", "land", "stage", "install", "handoff"].map((name) => `${name}:true:true:true`),
      })
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

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
      expect(landing).toMatch(/openSync\(temp, "wx"\)[\s\S]*?writeFileSync\(fd, text\)[\s\S]*?fsyncSync\(fd\)[\s\S]*?renameSync\(temp, file\)[\s\S]*?fsyncSync\(parent\)/)
      expect(update).toMatch(/publishReviewInput\(step, path, text\)/)
      expect(record).toMatch(/publishText\("write the installed record", settings\.record,/)
      expect(mark).toMatch(/publishText\("mark the running handoff", path,/)
      expect(stage).toMatch(/publishReviewInput\("stage the installed record", stage\.record,/)
      expect(stage).not.toMatch(/(?:writeFileSync|openSync)\(stage\.record|flag: "a\+"/)
    }),
  )
})
