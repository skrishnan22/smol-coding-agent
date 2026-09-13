import { expect, test } from "bun:test"
import { appendResponseOutput, appendUserMessage, createUserMessage } from "../src/model-context.js"

test("createUserMessage builds a Responses API user item", () => {
  expect(createUserMessage("hello")).toEqual({
    type: "message",
    role: "user",
    content: "hello",
  })
})

test("appendUserMessage adds a user item without mutating the prior context", () => {
  const prior = [createUserMessage("one")]
  const next = appendUserMessage(prior, "two")

  expect(prior).toEqual([createUserMessage("one")])
  expect(next).toEqual([createUserMessage("one"), createUserMessage("two")])
})

test("appendResponseOutput preserves provider output items as-is", () => {
  const prior = [createUserMessage("hi")]
  const output = [
    { id: "rs_1", type: "reasoning", summary: [] },
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "hello" }],
    },
  ]

  const next = appendResponseOutput(prior, output)

  expect(next).toEqual([...prior, ...output])
  expect(next[1]).toBe(output[0])
  expect(next[2]).toBe(output[1])
})
