#!/usr/bin/env node
// Scripted stand-in for the claude/codex binaries. Selected with COCKPIT_CLAUDE_BIN /
// COCKPIT_CODEX_BIN so the adapters keep using their real spawn, stream and kill path.

import { readFileSync, symlinkSync, writeFileSync } from "node:fs"

const argv = process.argv.slice(2)
const scenario = process.env.COCKPIT_FAKE_SCENARIO ?? "success"
const claudeFormat = argv.includes("--output-format")

/**
 * Engine tests script behaviour per block and per call instead of per process: COCKPIT_FAKE_SCRIPT
 * points at `{ "<block>:<nth call>" | "<block>": { output, text, isError, stderr, delayMs, hang,
 * writes } }` and the engine injects COCKPIT_BLOCK / COCKPIT_OUTPUT. Counting calls on disk is what
 * lets one script cover both block-level retries and loop iterations, which differ in neither
 * argv nor environment.
 */
const step = (() => {
  const path = process.env.COCKPIT_FAKE_SCRIPT
  if (path === undefined) return undefined
  const script = JSON.parse(readFileSync(path, "utf8"))
  const block = process.env.COCKPIT_BLOCK ?? ""
  const counter = `${path}.${block}.count`
  let calls = 1
  try {
    calls = Number(readFileSync(counter, "utf8")) + 1
  } catch {
    calls = 1
  }
  writeFileSync(counter, String(calls))
  return script[`${block}:${calls}`] ?? script[block]
})()

const flag = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

const hang = () => {
  process.on("SIGTERM", () => {})
  setInterval(() => {}, 1000)
}

const sessionId =
  flag("--session-id") ?? flag("--resume") ?? "3f1d0a4c-0000-4000-8000-000000000001"

if (step !== undefined) {
  emit(
    claudeFormat
      ? { type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd() }
      : { type: "thread.started", thread_id: sessionId },
  )
  if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs))
  if (step.hang) hang()
  else {
    if (step.output !== undefined && process.env.COCKPIT_OUTPUT) {
      writeFileSync(process.env.COCKPIT_OUTPUT, JSON.stringify(step.output))
    }
    // An agent that points its result at a file it does not own, to see whether the engine follows.
    if (step.symlinkOutputTo && process.env.COCKPIT_OUTPUT) {
      writeFileSync(step.symlinkOutputTo, JSON.stringify({ summary: "borrowed from elsewhere" }))
      symlinkSync(step.symlinkOutputTo, process.env.COCKPIT_OUTPUT)
    }
    if (step.writes) {
      for (const [name, content] of Object.entries(step.writes)) writeFileSync(name, content)
    }
    if (step.stderr) process.stderr.write(step.stderr)
    // Before any result event, so the adapter classifies it as a crash rather than a verdict.
    if (step.exitCode) process.exit(step.exitCode)
    const text = step.text ?? "done"
    emit({ type: "assistant", message: { content: [{ type: "text", text }] } })
    emit(
      claudeFormat
        ? {
            type: "result",
            subtype: step.isError ? "error_during_execution" : "success",
            is_error: step.isError === true,
            result: text,
          }
        : step.isError
          ? { type: "turn.failed", error: { message: text } }
          : { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    )
  }
} else if (claudeFormat) {
  emit({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd() })
  if (scenario === "hang") hang()
  else if (scenario === "crash") {
    emit({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } })
    process.exit(3)
  } else if (scenario === "question") {
    emit({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "AskUserQuestion",
            input: { questions: [{ question: "Which database?" }] },
          },
        ],
      },
    })
    emit({ type: "result", subtype: "success", is_error: false, result: "asked" })
  } else if (scenario === "failure") {
    process.stderr.write("fake: verification failed\n")
    emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "nope" })
  } else if (scenario === "flood") {
    // No newline ever, so line splitting can only stop on the reader's own budget.
    for (let written = 0; written < 6; written += 1) process.stdout.write("x".repeat(1024 * 1024))
    setInterval(() => {}, 1000)
  } else if (scenario === "chunked") {
    const bytes = Buffer.from(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "héllo ✓" }] } })}\n` +
        `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "héllo ✓" })}\n`,
    )
    // One cut inside the three bytes of "✓" and one mid-line, so decoding and line splitting
    // both have to carry state across reads.
    const cuts = [bytes.indexOf(Buffer.from("✓")) + 1, bytes.indexOf("\n") + 5]
    for (const [start, end] of [
      [0, cuts[0]],
      [cuts[0], cuts[1]],
      [cuts[1], bytes.length],
    ]) {
      process.stdout.write(bytes.subarray(start, end))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  } else {
    emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } })
    emit({ type: "result", subtype: "success", is_error: false, result: "ok" })
  }
} else {
  emit({ type: "thread.started", thread_id: "019fddd5-0000-7000-8000-000000000001" })
  if (scenario === "hang") hang()
  else if (scenario === "crash") {
    emit({ type: "turn.started" })
    process.exit(3)
  } else if (scenario === "failure") {
    process.stderr.write("fake: verification failed\n")
    emit({ type: "turn.failed", error: { message: "nope" } })
  } else {
    emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "ok" } })
    emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })
  }
}
