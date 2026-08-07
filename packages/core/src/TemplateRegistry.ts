import { Effect } from "effect"
import { coreBlocks, coreRetryPolicies } from "./blocks.js"
import { Cartridge } from "./cartridge.js"
import { CartridgeError } from "./errors.js"
import { coreTemplates, WorkflowTemplate } from "./templates.js"
import { WorkflowCatalog } from "./WorkflowValidator.js"

export interface Registry {
  readonly templates: ReadonlyArray<WorkflowTemplate>
  readonly catalog: WorkflowCatalog
}

const duplicates = (ids: ReadonlyArray<string>) => {
  const counts = new Map<string, number>()
  for (const value of ids) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].flatMap(([value, count]) => (count > 1 ? [value] : []))
}

const reject = (what: string, ids: ReadonlyArray<string>) =>
  new CartridgeError({
    stage: "validate",
    detail: `cartridge declares ${what} more than once: ${ids.join(", ")}`,
  })

/**
 * Cartridge templates are namespaced, so a cartridge can name one `bugfix` without shadowing the
 * core template of that name. Blocks share one namespace and a collision is refused — a cartridge
 * silently replacing a core block is how a run stops meaning what its template says. Retry policies
 * are the deliberate exception (contracts §11): a cartridge overrides core defaults by id.
 */
export const buildRegistry = (cartridge?: Cartridge): Effect.Effect<Registry, CartridgeError> =>
  Effect.gen(function* () {
    if (cartridge === undefined) {
      return {
        templates: coreTemplates,
        catalog: { blocks: coreBlocks, policies: coreRetryPolicies },
      }
    }

    const blocks = cartridge.blocks ?? []
    const templates = cartridge.templates ?? []
    const policies = cartridge.retryPolicies ?? []

    const clashingBlocks = duplicates([
      ...coreBlocks.map((block) => block.id),
      ...blocks.map((block) => block.id),
    ])
    if (clashingBlocks.length > 0) return yield* reject("block ids", clashingBlocks)

    const clashingTemplates = duplicates(templates.map((template) => template.id))
    if (clashingTemplates.length > 0) return yield* reject("template ids", clashingTemplates)

    const clashingPolicies = duplicates(policies.map((policy) => policy.id))
    if (clashingPolicies.length > 0) return yield* reject("retry policy ids", clashingPolicies)

    // Transforms run in declared order and validators all run: a repeated name is not a collision
    // but a log nobody can read, since both are journaled by name alone.
    const clashingTransforms = duplicates((cartridge.transforms ?? []).map(({ name }) => name))
    if (clashingTransforms.length > 0) return yield* reject("transform names", clashingTransforms)

    const clashingValidators = duplicates((cartridge.validators ?? []).map(({ name }) => name))
    if (clashingValidators.length > 0) return yield* reject("validator names", clashingValidators)

    const overridden = new Set(policies.map((policy) => policy.id))
    return {
      templates: [
        ...coreTemplates,
        ...templates.map(
          (template): WorkflowTemplate => ({
            ...template,
            id: `${cartridge.name}/${template.id}`,
          }),
        ),
      ],
      catalog: {
        blocks: [...coreBlocks, ...blocks],
        policies: [...coreRetryPolicies.filter((policy) => !overridden.has(policy.id)), ...policies],
      },
    }
  })
