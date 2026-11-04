/** Text sanitization and formatting helpers for plain-text previews and HTML-free Markdown in views. */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }
/** Presentation-only HTML removal; the client must still render the result as text, never raw HTML. */
function withoutHtml(text: string): string {
  let previous: string
  // Each change shortens the string. Repeat until stripping and entity decoding cannot reconstruct another tag or comment.
  do {
    previous = text
    let stripped: string
    // Keep each replacement in its own fixed-point loop so CodeQL can verify the feedback into its receiver.
    do {
      stripped = text
      text = text.replace(/<!--[\s\S]*?-->/g, '')
    } while (text !== stripped)
    do {
      stripped = text
      text = text.replace(/<\/?[a-zA-Z][^>]*>/g, '')
    } while (text !== stripped)
    text = text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_match, name: string) => ENTITIES[name]!)
  } while (text !== previous)
  return text
}
export function plain(text: string, lines = false): string {
  const result = withoutHtml(text)
    .replace(/!\[[^\]]*\]\([^)]*\)|\[Image: [^\]]*\]/g, '[image]')
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*]\s+/gm, lines ? '• ' : '').replace(/(\*\*|__|`)/g, '')
  // Reducing Markdown links to labels can also reconstruct HTML.
  const clean = withoutHtml(result)
  return lines ? clean.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : clean.replace(/\s+/g, ' ').trim()
}
export const markdown = (text: string): string => withoutHtml(text).replace(/!\[[^\]]*\]\([^)]*\)|\[Image: [^\]]*\]/g, '[image]').trim()
const scalar = (value: unknown): value is string | number | boolean | null => value === null || typeof value !== 'object'
function inline(value: unknown): string {
  if (scalar(value)) return value === null ? '' : String(value)
  return (Array.isArray(value) ? value : Object.values(value as object)).map(inline).filter(Boolean).join(Array.isArray(value) ? ', ' : ' · ')
}
function jsonLines(value: unknown): string[] {
  if (Array.isArray(value) && !value.every(scalar)) return value.map(item => `- ${inline(item)}`)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([name, item]) => scalar(item) || (Array.isArray(item) && item.every(scalar)) ? [`${name}: ${inline(item)}`]
      : [`${name}:`, ...jsonLines(item)])
  }
  return [inline(value)]
}
/** Formats JSON payloads (or `label: <JSON>` notices) as key-value lines; returns non-JSON text unchanged. */
export function readable(text: string): string {
  const match = /^(?:([^\n{[]{1,200}): )?(\{[\s\S]*\}|\[[\s\S]*\])$/.exec(text.trim())
  if (!match) return text
  try { return [...match[1] ? [match[1]] : [], ...jsonLines(JSON.parse(match[2]!))].join('\n') }
  catch (error) { void error /* Text that only looks like JSON is shown as written. */; return text }
}
export function preview(text: string, length = 160): string { return plain(readable(text)).slice(0, length) }
export const attribute = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
