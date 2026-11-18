import { describe, expect, test } from "bun:test"
import { answersOf, BUILT_INS, formOf, letterOf } from "./answer.ts"

const panes = { id: "panes", text: "Close old Claude panes" }

describe("the answer form", () => {
  test("offers the agent's choices, each answering with its label, and a line of one's own", () => {
    const form = formOf("ses_root", { ...panes, choices: [{ label: "Close them", description: "All four" }, { label: "Keep two" }] }, "! Close old Claude panes · needs you")
    expect(form).toEqual({
      title: "Queue item",
      metadata: { source: "queue" },
      fields: [
        {
          key: "queue:ses_root:panes",
          type: "string",
          title: "Close old Claude panes",
          description: "! Close old Claude panes · needs you",
          options: [
            { value: "Close them", label: "Close them", description: "All four" },
            { value: "Keep two", label: "Keep two" },
          ],
          custom: true,
        },
      ],
    })
  })

  test("with no choices, offers done and still needed", () => {
    expect(formOf("ses_root", panes).fields[0].options.map((option) => option.label)).toEqual(["Done / no longer needed", "Still needed"])
    expect(formOf("ses_root", { ...panes, choices: [] }).fields[0].options.map((option) => option.value)).toEqual(BUILT_INS.map((choice) => choice.label))
  })

  test("its reply names the root and the item, an item id with a colon too; other forms' keys and blank answers give nothing", () => {
    expect(answersOf({ "queue:ses_root:unit:r1": " Still needed ", "queue:ses_root:blank": " ", "ask_user_async:q1": "SQLite", "queue:": "x", "queue:ses_root:": "x" })).toEqual([
      { root: "ses_root", id: "unit:r1", answer: "Still needed" },
    ])
  })

  test("the message names the item and the answer", () => {
    expect(letterOf(panes, "Keep two")).toBe("Owner on queue item panes (Close old Claude panes): Keep two")
  })
})
