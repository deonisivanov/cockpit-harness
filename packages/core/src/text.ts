/** Cutting at a budget can split a surrogate pair, and a lone half corrupts the whole artifact. */
const wholeCodePoints = (text: string) => {
  const last = text.charCodeAt(text.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text
}

export const clip = (text: string, max: number) =>
  text.length <= max ? text : wholeCodePoints(text.slice(0, max))

/** Collapsed to one budgeted line: what a brief entry or a terminal tab title can hold. */
export const oneLine = (text: string, max: number) =>
  clip(text.replace(/\s+/g, " ").trim(), max)

/**
 * The parameter slot syntax shared by workflow templates and plugin argument templates. A slot with
 * no value renders empty rather than leaking `{{name}}` into a prompt an agent has to read.
 */
export const renderSlots = (text: string, values: Readonly<Record<string, unknown>>) =>
  text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, name: string) => {
    const value = values[name]
    if (value === undefined || value === null) return ""
    return typeof value === "object" ? JSON.stringify(value) : String(value)
  })

/**
 * The most a single block may hand back: 1 MiB of captured stream, counted in characters, or of
 * JSON result, counted in bytes. Past it the block broke its contract rather than being truncated.
 */
export const outputBudget = 1_048_576

/**
 * A section of a budgeted document. Nothing is ever cut in half: each section declares how many
 * entries must survive, and the budget takes the rest from whichever section is furthest above
 * its floor. Long material is named by artifact path, never pasted in.
 */
export interface Section {
  readonly title: string
  readonly entries: ReadonlyArray<string>
  readonly floor: number
}

const render = (sections: ReadonlyArray<Section>, header: ReadonlyArray<string>) =>
  [
    ...header,
    ...sections.flatMap((section) =>
      section.entries.length === 0 ? [] : ["", `## ${section.title}`, ...section.entries],
    ),
    "",
  ].join("\n")

/** Trims the section furthest above its floor until the whole document fits, then clips the rest. */
export const fitSections = (
  sections: ReadonlyArray<Section>,
  header: ReadonlyArray<string>,
  maxChars: number,
) => {
  const kept = sections.map((section) => section.entries.length)
  const draft = () =>
    sections.map((section, at) =>
      kept[at] >= section.entries.length
        ? section
        : {
            ...section,
            entries: [
              ...section.entries.slice(0, kept[at]),
              `… ${section.entries.length - kept[at]} more, see the artifact index`,
            ],
          },
    )

  for (;;) {
    const text = render(draft(), header)
    if (text.length <= maxChars) return text
    let slack = 0
    let index = -1
    sections.forEach((section, at) => {
      const room = kept[at] - section.floor
      if (room > slack) {
        slack = room
        index = at
      }
    })
    if (index === -1) return clip(text, maxChars)
    kept[index] -= Math.ceil(slack / 2)
  }
}
