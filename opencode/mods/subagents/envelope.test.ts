import { describe, expect, test } from "bun:test"
import { answered, envelopes, envelopesOf, render, unwrap } from "./envelope.ts"

/** The first envelope of the text, whatever its kind. */
const first = (text: string) => envelopes(text)[0]

// Notices as the fork writes them: before upstream e51247f626 (a tag per kind) and since (one <background-result> tag).
const OLD_SHELL = '<shell id="sh_1a2b" state="completed" command="sleep 300 > /dev/null">\nsh_1a2b · killed SIGTERM · 1.2 s · next 0\n(no new output)\n</shell>'
const NEW_SHELL =
  '<background-result kind="shell" id="sh_1a2b" state="completed" command="sleep 300 > /dev/null">\nsh_1a2b · killed SIGTERM · 1.2 s · next 0\n(no new output)\n</background-result>'
const OLD_SUBAGENT = '<subagent sessionID="ses_deliver_child" state="completed" description="Deliver report">\nAll done\n</subagent>'
const NEW_SUBAGENT = '<background-result kind="subagent" sessionID="ses_deliver_child" state="completed" description="Deliver report">\nAll done\n</background-result>'
const NEW_CODEMODE = '<background-result kind="codemode" id="job_1" state="error">\nboom\n</background-result>'
const NEW_IMAGE = '<background-result kind="image" id="img_1" state="completed">\n/tmp/a.png\n</background-result>'
const OLD_VIDEO = '<video id="vid_1" state="completed">\n/tmp/a.mp4\n</video>'

describe("envelope", () => {
  test("reads a shell's notice in either form alike: its kind, attributes and handle body", () => {
    for (const [text, form] of [
      [OLD_SHELL, "kind"],
      [NEW_SHELL, "background-result"],
    ] as const)
      expect(first(text)).toMatchObject({
        kind: "shell",
        form,
        attributes: { id: "sh_1a2b", state: "completed", command: "sleep 300 > /dev/null" },
        body: "sh_1a2b · killed SIGTERM · 1.2 s · next 0\n(no new output)",
      })
  })

  test("reads a subagent's, a code-mode job's, an image's and a video's notice", () => {
    expect(first(OLD_SUBAGENT)).toMatchObject({ kind: "subagent", attributes: { sessionID: "ses_deliver_child", state: "completed" }, body: "All done" })
    expect(first(NEW_SUBAGENT)).toMatchObject({ kind: "subagent", attributes: { sessionID: "ses_deliver_child", state: "completed" }, body: "All done" })
    expect(first(NEW_SUBAGENT)!.attributes).not.toHaveProperty("kind")
    expect(first(NEW_CODEMODE)).toMatchObject({ kind: "codemode", attributes: { state: "error" }, body: "boom" })
    expect(first(NEW_IMAGE)).toMatchObject({ kind: "image", body: "/tmp/a.png" })
    expect(first(OLD_VIDEO)).toMatchObject({ kind: "video", body: "/tmp/a.mp4" })
  })

  test("a user's shell notice leads with a line before its envelope", () => {
    const text = `The following shell command was executed by the user:\n${NEW_SHELL}`
    expect(answered(text)).toBe("sh_1a2b · killed SIGTERM · 1.2 s · next 0\n(no new output)")
  })

  test("a command whose quoted value holds a newline and a `>` stays in the opening tag", () => {
    const text = '<background-result kind="shell" id="sh_9" state="error" command="echo a >b\nexit 3">\nExit code: 3\n</background-result>'
    expect(first(text)).toMatchObject({ attributes: { command: "echo a >b\nexit 3" }, body: "Exit code: 3" })
  })

  test("an envelope another holds stays in the outer one's body", () => {
    const text = `<background-result kind="subagent" sessionID="ses_1" state="completed" description="d">\nIt said:\n${NEW_SHELL}\ndone\n</background-result>`
    expect(envelopes(text)).toHaveLength(1)
    expect(answered(text)).toBe(`It said:\n${NEW_SHELL}\ndone`)
  })

  test("text without an envelope answers itself, and a tag named mid-line is prose", () => {
    expect(answered("  plain  ")).toBe("plain")
    const prose = 'You will receive a <background-result kind="subagent"> message when it goes idle, or a <subagent> one.'
    expect(envelopes(prose)).toEqual([])
    expect(unwrap(prose, "subagent")).toBe(prose)
  })

  test("unwrap drops only the tags of its kind", () => {
    expect(unwrap(`${NEW_SUBAGENT}\n${OLD_SHELL}`, "subagent")).toBe(`All done\n${OLD_SHELL}`)
    expect(unwrap(OLD_SUBAGENT, "subagent")).toBe("All done")
    // A notice cut before its closing tag still loses its opening one.
    expect(unwrap('<background-result kind="subagent" sessionID="s" state="error">\nRate limited.', "subagent")).toBe("Rate limited.")
  })

  test("render writes each form as the fork does, and reads back", () => {
    const attributes = { sessionID: "ses_deliver_child", state: "completed", description: "Deliver report" }
    expect(render("background-result", "subagent", attributes, "All done")).toBe(NEW_SUBAGENT)
    expect(render("kind", "subagent", attributes, "All done")).toBe(OLD_SUBAGENT)
  })

  test("envelopesOf reads the envelopes of one kind", () => {
    expect(envelopesOf(`${NEW_SHELL}\n${OLD_SUBAGENT}`, "subagent").map((each) => each.body)).toEqual(["All done"])
  })
})
