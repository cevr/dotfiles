// PdfText through poppler's `pdftotext` (Homebrew's `poppler` on the Mac,
// `poppler-utils` on Linux): the PDF goes to a scratch file, since pdftotext
// seeks in its input, and its text comes back on stdout with the layout kept.
// No pdftotext on the PATH, a damaged PDF and a run past `timeoutMs` fail
// PdfUnreadable, naming the cause.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { PdfText, PdfUnreadable } from "../service.ts"

const MISSING = "pdftotext is not installed on this machine (brew install poppler, or apt install poppler-utils)"

const run = async (program: string, bytes: Uint8Array, timeoutMs: number): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "web-pdf-"))
  try {
    const file = join(dir, "page.pdf")
    writeFileSync(file, bytes)
    const child = Bun.spawn([program, "-layout", "-enc", "UTF-8", file, "-"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(stderr.trim().split("\n")[0] || `pdftotext exited ${code}`)
    return stdout
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** `program` is the pdftotext to run, by name on the PATH or by path. */
export const layer = (options: { readonly program?: string; readonly timeoutMs?: number } = {}) =>
  Layer.succeed(
    PdfText,
    PdfText.of({
      extract: Effect.fn("PdfText.extract")(function* (bytes: Uint8Array) {
        const program = options.program ?? "pdftotext"
        if (Bun.which(program) === null) return yield* new PdfUnreadable({ message: MISSING })
        return yield* Effect.tryPromise({
          try: () => run(program, bytes, options.timeoutMs ?? 30_000),
          catch: (cause) => new PdfUnreadable({ message: cause instanceof Error ? cause.message : String(cause) }),
        })
      }),
    }),
  )
