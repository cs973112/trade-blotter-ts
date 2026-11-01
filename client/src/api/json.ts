/**
 * Parses JSON with every number kept as its exact source text (a string). JSON.parse would turn
 * 1.6666666666666666666666666666666666666666666666667 into 1.6666666666666667; this keeps every
 * digit. Number literals are quoted before parsing; string contents, including escaped quotes, are
 * copied untouched. Works in every browser, with no reliance on newer JSON.parse features.
 */
export function parseJsonKeepingNumberText(text: string): unknown {
  let quoted = ''
  let index = 0
  while (index < text.length) {
    const char = text.charAt(index)
    if (char === '"') {
      let end = index + 1
      while (end < text.length && text.charAt(end) !== '"') end += text.charAt(end) === '\\' ? 2 : 1
      quoted += text.slice(index, end + 1)
      index = end + 1
    } else if (char === '-' || (char >= '0' && char <= '9')) {
      let end = index + 1
      while (end < text.length && /[0-9eE.+-]/.test(text.charAt(end))) end++
      quoted += `"${text.slice(index, end)}"`
      index = end
    } else {
      quoted += char
      index++
    }
  }
  return JSON.parse(quoted)
}
