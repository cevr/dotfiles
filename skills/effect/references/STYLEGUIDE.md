# Strict Effect Styleguide

Use this policy in Effect-native application packages. Platform adapters, generated code, build configuration, and third-party compatibility shims may use narrow file-level lint overrides when they must call a host API directly.

## Tool Ownership

- Oxlint owns unconditional syntax and capability rules. Its recommended preset is intentionally non-type-aware.
- Effect tsgo owns semantic and type-aware correctness: floating Effects, missing error or context channels, effects run inside Effects, leaking requirements, invalid provisioning, unnecessary generators, and schema-aware diagnostics.
- Do not enable duplicate tsgo syntax diagnostics when oxlint already reports the same construct. One violation should produce one diagnostic.
- Do not weaken either tool to make an invalid pattern pass. Move legitimate host interaction into a named adapter and override only the relevant oxlint rule for that file.

## Unconditional Syntax Policy

In Effect-native code:

- Do not use async functions or await. Wrap Promise-returning APIs with Effect.promise or Effect.tryPromise, and callback APIs with Effect.async.
- Do not use try, catch, or finally blocks. Capture synchronous failures with Effect.try, Promise failures with Effect.tryPromise, and cleanup with Effect.ensuring, Effect.acquireUseRelease, or Scope.
- Do not throw. Expected failures belong in the typed error channel.
- Do not construct or use global Promise APIs. Compose concurrency with Effect.
- Do not use ternary expressions. Use an ordinary if, Match, Option.match, or Either.match according to the data model.
- Ordinary if statements, switch statements, spread syntax, Effect.as, Option.as, Effect.never, and Effect.async are valid.
- Runtime.runFork and equivalent runners are valid only at application or runtime integration boundaries. Type-aware diagnostics own detection of nested execution inside an Effect.

## Failures and Defects

Expected failure and defects are different contracts:

- Model expected failures with the project-standard Schema tagged-error constructor (`Schema.TaggedErrorClass` in v4 or `Schema.TaggedError` in v3).
- Never throw an expected error.
- Native Error construction is permitted only as the direct argument of an explicit defect constructor: Effect.die(new Error(...)), Cause.die(new Error(...)), or Exit.die(new Error(...)).
- Constructing an Error earlier, returning it from a callback, or placing it in Effect.fail is not an explicit defect boundary.
- Preserve causes when translating infrastructure failures; do not erase them into generic messages.

## Composition

- Prefer Effect.gen for multi-step workflows and Effect.fn for named operations.
- Do not use Effect.Do or Effect.bind builder notation.
- Let requirements and typed errors bubble to the composition boundary.
- Provide layers at application, command, handler, or test boundaries rather than repeatedly inside domain workflows.
- Use Option only for genuine presence or absence.
- When absence has multiple meanings, model the states as a tagged domain type instead of proliferating Option values.
- Option modeling is a review rule, not a syntax lint: it requires domain knowledge.

## Dynamic Loading

Static imports are the default.

A dynamic import is valid only behind a descriptive named lazy boundary, for example a named module binding, named loader function, or named Effect wrapping Effect.promise or Effect.tryPromise. Do not chain directly from import(...), call .then on it, or hide require/createRequire behind aliases.

## Effect Replacements

Use these Effect capabilities in application code instead of ambient or runtime-specific APIs:

| Capability | Avoid | Use |
| --- | --- | --- |
| Time and scheduling | Date.now, new Date, performance.now, timers, Bun.sleep | Clock, DateTime, Effect.sleep, Schedule |
| Randomness | Math.random | Random |
| Secure randomness and UUIDs | crypto.getRandomValues, crypto.randomUUID, Bun.randomUUIDv7, matching node:crypto operations | Crypto |
| SHA digests | crypto.subtle.digest when the supported Effect algorithms fit | Crypto.digest |
| Configuration | process.env, Bun.env, Deno.env | Config and ConfigProvider |
| Filesystem and globbing | node:fs, Bun.file/write/Glob, Deno filesystem APIs | FileSystem |
| Paths | node:path | Path |
| Processes | node:child_process, Bun.spawn, Bun.$ | ChildProcessSpawner |
| Standard I/O and arguments | process argv/stdin/stdout/stderr, Bun stdio, Deno stdio | Stdio and Terminal |
| HTTP | fetch, node:http/https, Bun.serve, Deno.serve | HttpClient and HttpServer |
| Sockets | WebSocket and Bun connect/listen | Socket and SocketServer |
| Workers | Worker, SharedWorker, node:worker_threads | Effect Worker |
| Streaming | node:stream for application pipelines | Stream, Sink, and Channel |
| Logging | console methods | Effect logging or Console |
| JSON boundaries | JSON.parse/stringify | Schema JSON codecs |
| Base64 | atob/btoa | Encoding |
| Key-value storage | localStorage/sessionStorage | KeyValueStore |

Platform implementations provide the concrete Node, Bun, browser, or Deno layers at the edge.

## Partial Runtime Modules

Do not ban a whole runtime module when Effect covers only part of it.

- node:crypto and Web Crypto: use Effect Crypto for secure randomness, UUIDs, and supported SHA digests. HMAC, password hashing, signing, verification, encryption, and unsupported or incremental hashing remain adapter capabilities.
- node:process: use Config, Stdio, Clock, and Effect scheduling for replaced operations. Platform and resource inspection may remain in an adapter.
- DNS, UDP, compression, module resolution, FFI, VM/runtime inspection, archive/image APIs, and similar unmatched host capabilities are allowed only through named adapters.
- Node streams, EventTarget/EventEmitter, Buffer, and native sockets are legitimate interoperability types at adapters. Convert them to Effect abstractions before domain logic.
- A lint override documents an adapter boundary; it is not permission to use host APIs throughout the package.

## Recommended Lint Pairing

Enable all rules from oxlint-plugin-effect's recommended preset at error severity. In the Effect tsgo configuration, leave semantic diagnostics enabled and disable syntax duplicates owned by oxlint, including asyncFunction, cryptoRandomUUID, globalConsole, globalDate, globalFetch, globalRandom, globalTimers, newPromise, nodeBuiltinImport, and tryCatchInEffectGen when those keys exist in the pinned tsgo version.

## Agent Checklist

Before finishing Effect work:

1. Search the diff for async, await, try, catch, finally, throw, Promise, ternaries, dynamic imports, runtime builtins, and ambient globals.
2. Confirm every expected failure is typed and every defect is explicit.
3. Confirm host APIs are isolated in named adapters with the narrowest lint override.
4. Run oxlint first, then Effect tsgo diagnostics, typecheck, and focused tests.
5. Inspect the pinned Effect source before inventing a wrapper or claiming that no replacement exists.
