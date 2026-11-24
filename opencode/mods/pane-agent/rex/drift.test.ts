// @reads all
// @reads-reason subprocess reads at mods/pane-agent/rex/drift.test.ts: bun check over rex-sdk src/index.ts
import { describe, expect } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"

const DriftTsconfig = Schema.Struct({
  compilerOptions: Schema.Struct({
    lib: Schema.Array(Schema.String),
    target: Schema.String,
    module: Schema.String,
    moduleDetection: Schema.String,
    moduleResolution: Schema.String,
    allowImportingTsExtensions: Schema.Boolean,
    verbatimModuleSyntax: Schema.Boolean,
    noEmit: Schema.Boolean,
    strict: Schema.Boolean,
    exactOptionalPropertyTypes: Schema.Boolean,
    skipLibCheck: Schema.Boolean,
    paths: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  }),
  include: Schema.Array(Schema.String),
})

const encodeDriftTsconfig = Schema.encodeSync(Schema.fromJsonString(DriftTsconfig))

const makeDriftTsconfig = (effectDir: string, rexSdkDir: string) =>
  encodeDriftTsconfig({
    compilerOptions: {
      lib: ["ESNext"],
      target: "ESNext",
      module: "Preserve",
      moduleDetection: "force",
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      noEmit: true,
      strict: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: true,
      paths: {
        effect: [`${effectDir}/dist/index.d.ts`],
        "effect/*": [`${effectDir}/dist/*.d.ts`],
        "rex-sdk": [`${rexSdkDir}/src/index.d.ts`],
        "rex-sdk-real": [`${rexSdkDir}/src/index.ts`],
      },
    },
    include: ["check.ts"],
  })

const POSITIVE_CHECK = `
import type { Effect, Layer } from "effect"
import type * as Declared from "rex-sdk"
import * as Real from "rex-sdk-real"

type ExactFields<RealT, DeclT> =
  RealT extends DeclT
    ? DeclT extends Pick<RealT, keyof DeclT & keyof RealT>
      ? true
      : never
    : never

// Exact constant parity (bidirectional)
const _revToDeclared: typeof Declared.REX_API_REVISION = Real.REX_API_REVISION
const _revToReal: typeof Real.REX_API_REVISION = (18 as typeof Declared.REX_API_REVISION)

// Exact rexSdkLayerFromOptions parameter, error, and Context key parity
declare const declaredOpts: Parameters<typeof Declared.rexSdkLayerFromOptions>[0]
const _acceptsDeclaredOpts = Real.rexSdkLayerFromOptions(declaredOpts)
type RealLayerErr = Layer.Error<typeof _acceptsDeclaredOpts>
declare const realLayerErr: RealLayerErr
const _layerErr: Layer.Error<ReturnType<typeof Declared.rexSdkLayerFromOptions>> = realLayerErr
const _sdkKeyToDeclared: typeof Declared.RexSdk.key = Real.RexSdk.key
const _sdkKeyToReal: typeof Real.RexSdk.key = ("rex-sdk/RexSdk" as typeof Declared.RexSdk.key)

// Exact layout helper parity
const _terminal: typeof Declared.rexLayout.terminal = Real.rexLayout.terminal

// Exact Context service & operation parity (every method rex/client.ts & live.test.ts call)
declare const realSdk: Real.IRexSdk
const _sdk: Declared.IRexSdk = realSdk
const _idsSession: Declared.IRexSdk["ids"]["session"] = realSdk.ids.session
const _idsBlock: Declared.IRexSdk["ids"]["block"] = realSdk.ids.block
const _sessionsList: Declared.IRexSdk["sessions"]["list"] = realSdk.sessions.list
const _sessionsCreate: Declared.IRexSdk["sessions"]["create"] = realSdk.sessions.create
const _sessionsDestroy: Declared.IRexSdk["sessions"]["destroy"] = realSdk.sessions.destroy
const _blocksSplitBeside: Declared.IRexSdk["blocks"]["splitBeside"] = realSdk.blocks.splitBeside
const _blocksClose: Declared.IRexSdk["blocks"]["close"] = realSdk.blocks.close
const _terminalsWrite: Declared.IRexSdk["terminals"]["write"] = realSdk.terminals.write
const _terminalsRead: Declared.IRexSdk["terminals"]["read"] = realSdk.terminals.read
const _terminalsReadTail: Declared.IRexSdk["terminals"]["readTail"] = realSdk.terminals.readTail
const _terminalsWaitForQuiet: Declared.IRexSdk["terminals"]["waitForQuiet"] = realSdk.terminals.waitForQuiet
const _terminalsWaitForOutput: Declared.IRexSdk["terminals"]["waitForOutput"] = realSdk.terminals.waitForOutput
const _terminalsProcess: Declared.IRexSdk["terminals"]["process"] = realSdk.terminals.process

// Bidirectional return field parity (no loosened optionals on declared return types)
const _exactList: ExactFields<Effect.Success<ReturnType<Real.IRexSdk["sessions"]["list"]>>, Declared.SessionListResult> = true
const _exactCreate: ExactFields<Effect.Success<ReturnType<Real.IRexSdk["sessions"]["create"]>>, Declared.SessionCreateResult> = true
const _exactSplit: ExactFields<Effect.Success<ReturnType<Real.IRexSdk["blocks"]["splitBeside"]>>, Declared.SessionNewSplitResult> = true
const _exactClose: ExactFields<Effect.Success<ReturnType<Real.IRexSdk["blocks"]["close"]>>, Declared.BlockCloseResult> = true
const _exactWrite: ExactFields<Effect.Success<ReturnType<Real.IRexSdk["terminals"]["write"]>>, Declared.TerminalWriteResult> = true
const _exactReadTail: ExactFields<Effect.Success<ReturnType<Real.IRexSdk["terminals"]["readTail"]>>, Declared.RexTerminalText> = true
const _exactMatch: ExactFields<Effect.Success<ReturnType<Real.IRexSdk["terminals"]["waitForOutput"]>>, Declared.RexOutputMatch> = true
const _exactProcess: ExactFields<Effect.Success<ReturnType<Real.IRexSdk["terminals"]["process"]>>, Declared.TerminalProcessResult> = true

void [
  _revToDeclared,
  _revToReal,
  _acceptsDeclaredOpts,
  _layerErr,
  _sdkKeyToDeclared,
  _sdkKeyToReal,
  _terminal,
  _sdk,
  _idsSession,
  _idsBlock,
  _sessionsList,
  _sessionsCreate,
  _sessionsDestroy,
  _blocksSplitBeside,
  _blocksClose,
  _terminalsWrite,
  _terminalsRead,
  _terminalsReadTail,
  _terminalsWaitForQuiet,
  _terminalsWaitForOutput,
  _terminalsProcess,
  _exactList,
  _exactCreate,
  _exactSplit,
  _exactClose,
  _exactWrite,
  _exactReadTail,
  _exactMatch,
  _exactProcess,
]
`

const DRIFTED_PROBE = `
import * as Real from "rex-sdk-real"

// Deliberately wrong return shape (drifted declaration): must fail bun check
declare const realSdk: Real.IRexSdk
const _bad: () => import("effect").Effect.Effect<ReadonlyArray<{ readonly id: string }>, { readonly _tag: string; readonly message: string }> = realSdk.sessions.list
void _bad
`

const runBunCheck = Effect.fn("RexDrift.runBunCheck")(function* (tsconfigPath: string, cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const cmd = ChildProcess.make("bun", ["check", "--no-script", "-p", tsconfigPath], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    forceKillAfter: "5 seconds",
  })
  const handle = yield* spawner.spawn(cmd)
  const [out, err, code] = yield* Effect.all([
    handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
    handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    handle.exitCode,
  ], { concurrency: "unbounded" })
  return { code, output: `${out}\n${err}`.trim() }
})

describe("rex-sdk patch index.d.ts drift check against real upstream src/index.ts", () => {
  effectTest(
    "declared index.d.ts matches real rex-sdk/src/index.ts under exactOptionalPropertyTypes and catches drifted signatures",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const thisFile = yield* path.fromFileUrl(new URL(import.meta.url))
      const pkgDir = path.resolve(path.dirname(thisFile), "..")
      const rexSdkDir = yield* fs.realPath(path.join(pkgDir, "node_modules", "rex-sdk"))
      const effectDir = yield* fs.realPath(path.join(pkgDir, "node_modules", "effect"))

      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "rex-sdk-drift-" })
      const tsconfigPath = path.join(tempDir, "tsconfig.json")
      const checkPath = path.join(tempDir, "check.ts")
      yield* fs.writeFileString(tsconfigPath, makeDriftTsconfig(effectDir, rexSdkDir))
      yield* fs.writeFileString(checkPath, POSITIVE_CHECK)

      const ok = yield* runBunCheck(tsconfigPath, tempDir)
      expect(Number(ok.code), ok.output).toBe(0)

      yield* fs.writeFileString(checkPath, DRIFTED_PROBE)
      const drifted = yield* runBunCheck(tsconfigPath, tempDir)
      expect(Number(drifted.code)).not.toBe(0)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    hangGuard("process-fixture"),
  )
})
