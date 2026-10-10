// Compiles the CLI to bin/baton and links it into ~/.bun/bin.
const os = { darwin: "darwin", linux: "linux", win32: "windows" } as const
const platform = os[process.platform as keyof typeof os] ?? "linux"
const arch = process.arch === "arm64" ? "arm64" : "x64"

const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/../src/main.ts`],
  outdir: `${import.meta.dir}/../bin`,
  target: "bun",
  compile: { target: `bun-${platform}-${arch}` as Bun.Build.CompileTarget, outfile: "baton" },
})
if (!result.success) {
  console.error("build failed:", result.logs)
  process.exit(1)
}

const bin = `${import.meta.dir}/../bin/baton`
const link = `${process.env["HOME"]}/.bun/bin/baton`
const linked = Bun.spawnSync(["ln", "-sf", bin, link])
if (linked.exitCode !== 0) {
  console.error(`could not link ${link}`)
  process.exit(1)
}
console.log(`built ${bin} -> ${link}`)
