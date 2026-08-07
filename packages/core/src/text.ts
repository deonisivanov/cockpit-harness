/** Cutting at a budget can split a surrogate pair, and a lone half corrupts the whole artifact. */
const wholeCodePoints = (text: string) => {
  const last = text.charCodeAt(text.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text
}

export const clip = (text: string, max: number) =>
  text.length <= max ? text : wholeCodePoints(text.slice(0, max))

/**
 * The most a single block may hand back: 1 MiB of captured stream, counted in characters, or of
 * JSON result, counted in bytes. Past it the block broke its contract rather than being truncated.
 */
export const outputBudget = 1_048_576
