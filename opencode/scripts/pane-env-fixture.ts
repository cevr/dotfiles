// For scripts/pane-env.test.ts: two children through tests/owned.ts, one given this process's
// environment as a test spreads it, one with HERDR_ENV set on purpose. Prints what each saw.
import { owned } from "../tests/owned.ts"

const seen = async (env: Record<string, string | undefined>) => {
  const child = owned(["env"], { env, stdout: "pipe" })
  const text = await new Response(child.stdout).text()
  await child.exited
  return text.split("\n").filter((line) => line !== "")
}

console.log(JSON.stringify({ inherited: await seen({ ...process.env }), set: await seen({ ...process.env, HERDR_ENV: "1" }) }))
