import { Context, Effect, Layer } from "effect"
import { ArtifactStore } from "./ArtifactStore.js"
import { Cartridge, TransformContext } from "./cartridge.js"
import { CartridgeError, JournalError, ValidationError } from "./errors.js"
import { Journal } from "./Journal.js"
import { WorkflowTree } from "./workflow.js"
import { validateWorkflow, WorkflowCatalog } from "./WorkflowValidator.js"

export interface TransformInput {
  readonly tree: WorkflowTree
  readonly cartridge?: Cartridge
  readonly context: TransformContext
  readonly catalog: WorkflowCatalog
}

export class TransformPipeline extends Context.Tag("cockpit/TransformPipeline")<
  TransformPipeline,
  {
    readonly apply: (
      input: TransformInput,
    ) => Effect.Effect<WorkflowTree, CartridgeError | ValidationError | JournalError>
  }
>() {}

const isTree = (value: unknown): value is WorkflowTree =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as WorkflowTree).templateId === "string" &&
  typeof (value as WorkflowTree).root === "object"

const fields = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const show = (value: unknown) => (value === undefined ? "undefined" : JSON.stringify(value))

/** Field-by-field, so the journal shows what a transform changed rather than two copies of the tree. */
export const treeDiff = (before: unknown, after: unknown, path = "root"): ReadonlyArray<string> => {
  if (Object.is(before, after)) return []
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length)
    return Array.from({ length }, (_, index) =>
      treeDiff(before[index], after[index], `${path}[${index}]`),
    ).flat()
  }
  const left = fields(before)
  const right = fields(after)
  if (left === undefined || right === undefined) {
    return [`${path}: ${show(before)} -> ${show(after)}`]
  }
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) =>
    treeDiff(left[key], right[key], `${path}.${key}`),
  )
}

export const TransformPipelineLive = Layer.effect(
  TransformPipeline,
  Effect.gen(function* () {
    const journal = yield* Journal
    const artifacts = yield* ArtifactStore

    const apply = (input: TransformInput) =>
      Effect.gen(function* () {
        const { cartridge, context } = input
        let tree = input.tree

        // Declared order, synchronously, one at a time: a transform reads the tree the one before
        // it produced, which is what makes "add a mandatory block, then force its settings" work.
        for (const transform of cartridge?.transforms ?? []) {
          // A transform is free to mutate the tree in place, so the diff needs a copy taken before
          // it runs — comparing the result against a reference it may have edited shows nothing.
          const before = structuredClone(tree)
          const produced = yield* Effect.try({
            try: () => transform.apply(tree, context) as unknown,
            catch: (cause) =>
              new CartridgeError({
                stage: "transform",
                detail: `transform ${transform.name} rejected the tree: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
              }),
          })
          if (!isTree(produced)) {
            return yield* new CartridgeError({
              stage: "transform",
              detail: `transform ${transform.name} returned ${typeof produced} instead of a workflow tree`,
            })
          }
          tree = produced

          const changes = treeDiff(before, produced)
          const ref = yield* artifacts.write({
            runId: tree.runId,
            kind: "tree-diff",
            name: `transform-${transform.name}.diff`,
            content:
              changes.length === 0
                ? `${transform.name}: no change\n`
                : `${changes.join("\n")}\n`,
          })
          yield* journal.append({
            runId: tree.runId,
            payload: { _tag: "TreeTransformed", name: transform.name, diffRef: ref.id },
          })
        }

        const settled = tree
        const extra = yield* Effect.forEach(cartridge?.validators ?? [], (validator) =>
          Effect.try({
            try: () =>
              validator.check(settled, context).map(
                (error) =>
                  new ValidationError({
                    rule: `${cartridge?.name}/${validator.name}:${error.rule}`,
                    path: error.path,
                    message: error.message,
                  }),
              ),
            catch: (cause) =>
              new CartridgeError({
                stage: "validate",
                detail: `validator ${validator.name} threw: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
              }),
          }),
        )
        const errors = [...validateWorkflow(settled, input.catalog), ...extra.flat()]
        yield* journal.append({
          runId: tree.runId,
          payload: {
            _tag: "TreeValidated",
            errors: errors.map(({ rule, path, message }) => ({ rule, path, message })),
          },
        })
        const invalid = errors[0]
        return invalid === undefined ? tree : yield* Effect.fail(invalid)
      })

    return { apply }
  }),
)
