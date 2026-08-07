import { Either, Schema } from "effect"
import { expect, it } from "vitest"
import { agentTask, BlockDef, verifyOutput, WorkflowNode } from "../src/index.js"

const decodeNode = Schema.decodeUnknownEither(WorkflowNode)
const decodeDef = Schema.decodeUnknownEither(BlockDef)

// What a template or cartridge will hand the engine in Phase 5: plain JSON, no branded types.
const json = {
  _tag: "Loop",
  policy: "corrective",
  kind: "corrective",
  feedbackRoute: { from: "verify", to: "implement" },
  body: {
    _tag: "Sequence",
    children: [
      {
        _tag: "Parallel",
        branches: [
          {
            workspaceAccess: "write",
            node: { _tag: "Block", id: "implement", def: "agent-task" },
          },
          {
            workspaceAccess: "read",
            node: {
              _tag: "Condition",
              predicate: { blockId: "implement", path: ["summary"], comparator: "exists" },
              onTrue: {
                _tag: "Gate",
                id: "approve",
                payload: { title: "Approve", summary: "before the verifier runs" },
              },
            },
          },
        ],
      },
      {
        _tag: "Block",
        id: "verify",
        def: "verify-output",
        inputs: ["implement"],
        overrides: { timeoutMs: 60_000 },
      },
    ],
  },
}

it("decodes a workflow tree that arrived as plain JSON", () => {
  const decoded = decodeNode(JSON.parse(JSON.stringify(json)))

  expect(Either.isRight(decoded)).toBe(true)
  const node = Either.getOrThrow(decoded)
  expect(node._tag).toBe("Loop")
  expect(Schema.encodeSync(WorkflowNode)(node)).toEqual(json)
})

it.each([
  { name: "an unknown node tag", node: { _tag: "Fanout", children: [] } },
  {
    name: "a comparator nobody defined",
    node: {
      _tag: "Condition",
      predicate: { blockId: "a", path: ["x"], comparator: "matches" },
      onTrue: { _tag: "Block", id: "b", def: "agent-task" },
    },
  },
  {
    name: "a branch missing its workspace access",
    node: { _tag: "Parallel", branches: [{ node: { _tag: "Block", id: "a", def: "agent-task" } }] },
  },
])("refuses $name", ({ node }) => {
  expect(Either.isLeft(decodeNode(node))).toBe(true)
})

it("round-trips the core block definitions", () => {
  for (const def of [agentTask, verifyOutput]) {
    expect(Either.getOrThrow(decodeDef(JSON.parse(JSON.stringify(def))))).toEqual(def)
  }
})

it("refuses a block definition with an unknown permission profile", () => {
  expect(Either.isLeft(decodeDef({ ...agentTask, permissionProfile: "root" }))).toBe(true)
})
