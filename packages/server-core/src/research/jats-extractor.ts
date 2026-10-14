import { XMLParser } from 'fast-xml-parser'
import { DocumentBudgetsSchema, ParsedDocumentResultSchema, type DocumentBudgets, type ParsedDocumentResult, type TextBlock } from '@bio-evidence/research-core'

type Failure = 'invalid' | 'unsupported' | 'budget' | 'cancelled'
class ParseFailure extends Error { constructor(readonly status: Failure) { super(status) } }
type OrderedNode = Record<string, unknown>
type Unit = { unit: number; status: 'read' | 'no-text' | 'unsupported'; reason?: 'scan-or-empty' | 'unsupported-content' }
const inline = new Set(['bold', 'italic', 'underline', 'overline', 'monospace', 'roman', 'sans-serif', 'sc', 'strike', 'sub', 'sup', 'named-content', 'styled-content', 'ext-link', 'xref', 'abbrev', 'break', 'milestone-start', 'milestone-end', 'target', 'label'])
const containers = new Set(['body', 'sec', 'list', 'list-item', 'def-list', 'def-item', 'def', 'disp-quote', 'boxed-text', 'statement', 'verse-group', 'speech', 'glossary', 'notes'])
const paragraphs = new Set(['p', 'title', 'term', 'verse-line', 'speaker'])
// Europe PMC embeds inert image metadata PIs. Values are never interpreted,
// resolved or copied into evidence; the ordered parser ignores these nodes.
const metadataInstructions = new Set(['cloudpmc-path', 'cloudpmc-bucket', 'size', 'disp-level', 'image-server-status', 'original-height', 'original-width', 'scaled-height', 'scaled-width'])
const nameOf = (node: OrderedNode) => Object.keys(node).find(key => key !== ':@') ?? ''
const localName = (name: string) => name.slice(name.lastIndexOf(':') + 1)
const normalize = (text: string) => text.replace(/[ \t\r\n]+/g, ' ').trim()
const validCharacter = (code: number) => code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff

// Decode only XML's five predefined entities and valid scalar numeric references.
// Custom declarations and all unknown references are rejected before FXP runs.
function decodeText(text: string): string {
  return text.replace(/&([^;]*);|&/g, (reference: string, name: string | undefined) => {
    const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (name !== undefined && Object.hasOwn(entities, name)) return entities[name]!
    if (name !== undefined && /^(?:#[0-9]+|#x[0-9a-fA-F]+)$/.test(name)) {
      const code = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))
      if (validCharacter(code)) return String.fromCodePoint(code)
    }
    throw new ParseFailure('invalid')
  })
}

// Scan first, with no parsed tree allocation: bounded input, element/text/attribute
// nodes, and depth. XMLParser subsequently validates the bounded grammar.
function scanXml(xml: string, limits: DocumentBudgets, check: () => void): void {
  let offset = 0, depth = 0, nodes = 0
  const addNode = () => { if (++nodes > limits.xmlMaxNodes) throw new ParseFailure('budget') }
  while (offset < xml.length) {
    check()
    if (xml[offset] !== '<') {
      const end = xml.indexOf('<', offset), next = end < 0 ? xml.length : end
      const text = xml.slice(offset, next)
      if (text.includes(']]>')) throw new ParseFailure('invalid')
      if (text.length) { addNode(); decodeText(text) }
      offset = next; continue
    }
    if (xml.startsWith('<!--', offset)) {
      const end = xml.indexOf('-->', offset + 4)
      const comment = xml.slice(offset + 4, end)
      if (end < 0 || comment.includes('--') || comment.endsWith('-')) throw new ParseFailure('invalid')
      addNode(); offset = end + 3; continue
    }
    if (xml.startsWith('<![CDATA[', offset)) {
      const end = xml.indexOf(']]>', offset + 9)
      if (end < 0) throw new ParseFailure('invalid')
      addNode(); offset = end + 3; continue
    }
    if (xml.startsWith('<!', offset)) throw new ParseFailure('invalid')
    if (xml.startsWith('<?', offset)) {
      const end = xml.indexOf('?>', offset + 2)
      if (end < 0) throw new ParseFailure('invalid')
      const declaration = xml.slice(offset + 2, end)
      const target = /^([A-Za-z_][\w:.-]*)(?:\s|$)/.exec(declaration)?.[1]
      if (target === 'xml') {
        if (offset !== 0) throw new ParseFailure('invalid')
        const encoding = /\bencoding\s*=\s*(['"])(.*?)\1/.exec(declaration)?.[2]
        if (encoding && !/^utf-?8$/i.test(encoding)) throw new ParseFailure('unsupported')
      } else if (!target || !metadataInstructions.has(target)) throw new ParseFailure('invalid')
      addNode(); offset = end + 2; continue
    }
    const closing = xml[offset + 1] === '/'
    let end = offset + (closing ? 2 : 1), quote = '', attributeStart = -1
    for (; end < xml.length; end++) {
      if ((end & 4095) === 0) check()
      const char = xml[end]!
      if (quote) {
        if (char === quote) { decodeText(xml.slice(attributeStart, end)); quote = '' }
        else if (char === '<') throw new ParseFailure('invalid')
      } else if (char === '"' || char === "'") { quote = char; attributeStart = end + 1; addNode() }
      else if (char === '>') break
      else if (char === '<') throw new ParseFailure('invalid')
    }
    if (end === xml.length || quote) throw new ParseFailure('invalid')
    if (closing) { if (--depth < 0) throw new ParseFailure('invalid') }
    else {
      addNode(); if (depth + 1 > limits.xmlMaxDepth) throw new ParseFailure('budget')
      if (xml[end - 1] !== '/') depth++
    }
    offset = end + 1
  }
  if (depth !== 0) throw new ParseFailure('invalid')
}

export function extractJats(input: Uint8Array, budgets?: Partial<DocumentBudgets>, signal?: AbortSignal): ParsedDocumentResult {
  try {
    const limits = DocumentBudgetsSchema.parse(budgets ?? {})
    const startedAt = performance.now()
    const check = () => {
      if (signal?.aborted) throw new ParseFailure('cancelled')
      if (performance.now() - startedAt > limits.timeoutMs) throw new ParseFailure('budget')
    }
    check()
    if (input.byteLength > limits.xmlMaxBytes) throw new ParseFailure('budget')
    let xml: string
    try { xml = new TextDecoder('utf-8', { fatal: true }).decode(input) } catch { throw new ParseFailure('invalid') }
    for (let index = 0; index < xml.length; index++) {
      if ((index & 4095) === 0) check()
      const code = xml.codePointAt(index)!
      if (!validCharacter(code)) throw new ParseFailure('invalid')
      if (code > 0xffff) index++
    }
    scanXml(xml, limits, check)
    const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: false, parseTagValue: false, processEntities: false, cdataPropName: '#cdata', ignoreDeclaration: true, ignorePiTags: true })
    const tree = parser.parse(xml, true) as OrderedNode[]
    check()
    const root = tree.filter(node => !nameOf(node).startsWith('#'))
    if (root.length !== 1 || localName(nameOf(root[0]!)) !== 'article') throw new ParseFailure('unsupported')
    const articleChildren = root[0]![nameOf(root[0]!)] as OrderedNode[]
    const bodies = articleChildren.filter(node => localName(nameOf(node)) === 'body')
    if (bodies.length !== 1) throw new ParseFailure('unsupported')
    const units: Unit[] = [], blocks: TextBlock[] = []
    let chars = 0
    const originalId = (node: OrderedNode): string | undefined => {
      const attributes = node[':@'] as Record<string, unknown> | undefined
      const raw = attributes?.['@_id'] ?? attributes?.['@_xml:id']
      if (typeof raw !== 'string' || !raw) return undefined
      const id = decodeText(raw)
      if (id.length > 4096) throw new ParseFailure('budget')
      return id
    }
    const addUnit = (status: Unit['status'], reason?: Unit['reason']) => {
      if (units.length >= 10000) throw new ParseFailure('budget')
      units.push({ unit: units.length + 1, status, ...(reason ? { reason } : {}) }); return units.length
    }
    const gap = () => addUnit('unsupported', 'unsupported-content')
    const textOf = (children: OrderedNode[], gaps: boolean, literal = false): string => {
      let text = ''
      for (const node of children) {
        check()
        const key = nameOf(node), name = localName(key)
        if (key === '#text') text += literal ? String(node[key]) : decodeText(String(node[key]))
        else if (key === '#cdata') text += textOf(node[key] as OrderedNode[], false, true)
        else if (inline.has(name)) text += name === 'break' ? ' ' : textOf(node[key] as OrderedNode[], gaps)
        else { if (gaps) gap(); text += ' ' }
        if (text.length > 200000 || text.length + chars > limits.maxTextChars) throw new ParseFailure('budget')
      }
      return text
    }
    const addBlock = (text: string, section?: string, elementId?: string, sectionId?: string) => {
      text = normalize(text)
      if (!text) { addUnit('no-text', 'scan-or-empty'); return }
      if (text.length > 200000 || (chars += text.length) > limits.maxTextChars) throw new ParseFailure('budget')
      const unit = addUnit('read')
      blocks.push({ id: `jats-block-${unit}`, unit, text, locator: { kind: 'jats-paragraph', paragraphId: `jats-${unit}`, ...(section ? { section } : {}), ...(elementId ? { elementId } : {}), ...(sectionId ? { sectionId } : {}) } })
    }
    const visit = (children: OrderedNode[], section?: string, sectionId?: string): void => {
      for (const node of children) {
        check()
        const key = nameOf(node), name = localName(key)
        if (key === '#text') { if (normalize(decodeText(String(node[key])))) gap(); continue }
        if (name === 'sec') {
          const nested = node[key] as OrderedNode[]
          const title = nested.find(child => localName(nameOf(child)) === 'title')
          const heading = title ? normalize(textOf(title[nameOf(title)] as OrderedNode[], false)) : undefined
          if (heading && heading.length > 1000) throw new ParseFailure('budget')
          visit(nested, heading || section, originalId(node) ?? sectionId)
        } else if (paragraphs.has(name)) addBlock(textOf(node[key] as OrderedNode[], true), section, originalId(node), sectionId)
        else if (containers.has(name)) visit(node[key] as OrderedNode[], section, sectionId)
        else gap()
      }
    }
    visit(bodies[0]![nameOf(bodies[0]!)] as OrderedNode[])
    if (!units.length) addUnit('no-text', 'scan-or-empty')
    check()
    return ParsedDocumentResultSchema.parse({ status: 'ok', format: 'jats', coverage: { level: units.every(unit => unit.status === 'read') ? 'full' : 'partial', totalUnits: units.length, units }, blocks })
  } catch (error) {
    return { status: error instanceof ParseFailure ? error.status : 'invalid' }
  }
}
