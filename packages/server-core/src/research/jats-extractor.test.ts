import { expect, test } from 'bun:test'
import { ParsedDocumentResultSchema, SnapshotSchema } from '@bio-evidence/research-core'
import { extractJats } from './jats-extractor'

const xml = (text: string) => new TextEncoder().encode(text)
test('Europe PMC inert media metadata instructions are ignored without loading paths', () => {
  const result = extractJats(xml('<?xml version="1.0"?><article><?cloudpmc-path https://127.0.0.1/private?><?cloudpmc-bucket ignored?><body><?disp-level 2?><p>Body text</p><fig><?image-server-status 1?><?original-height 12?><?scaled-width 10?></fig></body></article>'))
  expect(result.status).toBe('ok'); if (result.status !== 'ok') return
  expect(result.blocks.map(block => block.text)).toEqual(['Body text']); expect(result.coverage.level).toBe('partial')
  expect(extractJats(xml('<article><?unknown-instruction path?><body><p>x</p></body></article>')).status).toBe('invalid')
})
test('original paragraph and section identifiers remain available beside safe snapshot anchors', () => {
  const result = extractJats(xml('<article><body><sec id="section-方法"><title>方法</title><p xml:id="paragraph-细胞">甲</p></sec></body></article>'))
  expect(result.status).toBe('ok'); if (result.status !== 'ok') return
  expect(result.blocks[1]!.locator).toMatchObject({ paragraphId: 'jats-2', elementId: 'paragraph-细胞', sectionId: 'section-方法' })
})
test('JATS preserves nested inline reading order and maps section titles and paragraphs to unique locators', () => {
  const result = extractJats(xml(`<?xml version="1.0" encoding="UTF-8"?><article><front><abstract><p>Abstract excluded</p></abstract></front><body><sec id="s1"><title>Methods <italic>α</italic></title><p id="p1" special="not text">Before <bold>bold <italic>deep</italic></bold> after &amp; &#x1F9EC;.</p><sec><title>Results</title><p>First</p><p>Second</p></sec></sec></body></article>`))
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(result.blocks.map(block => block.text)).toEqual(['Methods α', 'Before bold deep after & 🧬.', 'Results', 'First', 'Second'])
  expect(result.coverage).toEqual({ level: 'full', totalUnits: 5, units: Array.from({ length: 5 }, (_, index) => ({ unit: index + 1, status: 'read' })) })
  expect(result.blocks.map(block => block.locator)).toEqual([
    { kind: 'jats-paragraph', paragraphId: 'jats-1', section: 'Methods α', sectionId: 's1' },
    { kind: 'jats-paragraph', paragraphId: 'jats-2', section: 'Methods α', sectionId: 's1', elementId: 'p1' },
    { kind: 'jats-paragraph', paragraphId: 'jats-3', section: 'Results', sectionId: 's1' },
    { kind: 'jats-paragraph', paragraphId: 'jats-4', section: 'Results', sectionId: 's1' },
    { kind: 'jats-paragraph', paragraphId: 'jats-5', section: 'Results', sectionId: 's1' },
  ])
  expect(SnapshotSchema.safeParse({ id: 'snapshot', sourceId: 'paper', scope: { kind: 'personal', ownerId: 'alice' }, policy: 'public', license: { status: 'unknown' }, format: 'jats', acquiredBy: 'europe-pmc-oa', retrievedAt: 1, contentHash: 'a'.repeat(64), coverage: result.coverage, blocks: result.blocks }).success).toBe(true)
})
test('figures, tables, and inline or displayed formulae leave explicit coverage gaps', () => {
  const result = extractJats(xml('<article><body><p>Measured <inline-formula><mml:math xmlns:mml="urn:math"><mml:mi>x</mml:mi></mml:math></inline-formula> cells.</p><fig><caption><p>Image caption</p></caption><graphic href="external.png"/></fig><table-wrap><table><tr><td>42</td></tr></table></table-wrap><disp-formula>x+y</disp-formula><p>Conclusion</p></body></article>'))
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(result.coverage.level).toBe('partial')
  expect(result.coverage.units.filter(unit => unit.status === 'unsupported')).toHaveLength(4)
  expect(result.blocks.map(block => block.text)).toEqual(['Measured cells.', 'Conclusion'])
  expect(ParsedDocumentResultSchema.safeParse(result).success).toBe(true)
})
test('depth, node, byte, text and paragraph budgets fail before accepting an oversized result', () => {
  expect(extractJats(xml('<article><body><sec><p>x</p></sec></body></article>'), { xmlMaxDepth: 3 }).status).toBe('budget')
  expect(extractJats(xml('<article><body><p>x</p></body></article>'), { xmlMaxNodes: 3 }).status).toBe('budget')
  expect(extractJats(xml('<article><body><p>x</p></body></article>'), { xmlMaxBytes: 10 }).status).toBe('budget')
  expect(extractJats(xml('<article><body><p>123456</p></body></article>'), { maxTextChars: 5 }).status).toBe('budget')
  expect(extractJats(xml(`<article><body><p>${'x'.repeat(200001)}</p></body></article>`)).status).toBe('budget')
})
test('CDATA stays literal while predefined and numeric XML escapes decode once', () => {
  const result = extractJats(xml('<article><body><p><![CDATA[A &amp; <literal> &unknown;]]> &amp;lt; &#65; &#x3B1; &quot; &apos;</p></body></article>'))
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(result.blocks[0]!.text).toBe('A &amp; <literal> &unknown; &lt; A α " \'')
})
test('empty body units are no-text, absent bodies and abstract-only inputs never claim full', () => {
  expect(extractJats(xml('<article><front><abstract><p>Only abstract</p></abstract></front></article>')).status).toBe('unsupported')
  expect(extractJats(xml('<article><body/><body/></article>')).status).toBe('unsupported')
  const empty = extractJats(xml('<article><body><p> </p></body></article>'))
  expect(empty.status).toBe('ok')
  if (empty.status !== 'ok') return
  expect(empty.coverage).toEqual({ level: 'partial', totalUnits: 1, units: [{ unit: 1, status: 'no-text', reason: 'scan-or-empty' }] })
  expect(empty.blocks).toHaveLength(0)
})
test('DTD, custom or invalid entities, malformed XML, invalid UTF8 and disallowed processing instructions are rejected', () => {
  const inputs = [
    '<!DOCTYPE article SYSTEM "https://external.invalid/evil.dtd"><article><body><p>x</p></body></article>',
    '<!DOCTYPE article [<!ENTITY secret SYSTEM "file:///c:/secret">]><article><body><p>&secret;</p></body></article>',
    '<article><body><p>&custom;</p></body></article>',
    '<article><body><p>&#0;</p></body></article>',
    '<article><body><p>&#xD800;</p></body></article>',
    '<article><body><p>&#x110000;</p></body></article>',
    '<article><body><p>Unclosed</body></article>',
    '<article><body><p duplicate="1" duplicate="2">x</p></body></article>',
    '<article><body><p attr="&custom;">x</p></body></article>',
    '<article><body><p>x\u0000</p></body></article>',
    '<article><body><p>illegal ]]></p></body></article>',
    '<article><body><!-- illegal---><p>x</p></body></article>',
    '<?xml-stylesheet href="https://external.invalid"?><article><body><p>x</p></body></article>',
  ]
  for (const input of inputs) expect(extractJats(xml(input)).status).toBe('invalid')
  expect(extractJats(new Uint8Array([0xff, 0xfe, 0x3c])).status).toBe('invalid')
  expect(extractJats(xml('<?xml version="1.0" encoding="ISO-8859-1"?><article><body><p>x</p></body></article>')).status).toBe('unsupported')
})
test('unknown body or inline content is a visible gap and attribute order cannot reorder paragraph text', () => {
  const first = extractJats(xml('<article><body><p id="a" other="b">One <unknown>omitted</unknown> two.</p><custom><p>Hidden</p></custom><p b="a" id="z">End</p></body></article>'))
  const second = extractJats(xml('<article><body><p other="b" id="a">One <unknown>omitted</unknown> two.</p><custom><p>Hidden</p></custom><p id="z" b="a">End</p></body></article>'))
  expect(first).toEqual(second)
  expect(first.status).toBe('ok')
  if (first.status !== 'ok') return
  expect(first.coverage.level).toBe('partial')
  expect(first.coverage.units.filter(unit => unit.status === 'unsupported')).toHaveLength(2)
  expect(first.blocks.map(block => block.text)).toEqual(['One two.', 'End'])
})
test('pre-cancelled parsing stops and configurable budget bounds reject invalid settings', () => {
  const abort = new AbortController(); abort.abort()
  expect(extractJats(xml('<article><body><p>x</p></body></article>'), {}, abort.signal).status).toBe('cancelled')
  expect(extractJats(xml('<article><body><p>x</p></body></article>'), { xmlMaxDepth: 65 }).status).toBe('invalid')
})
test('pre-scan stops on depth or node budget before reaching a malformed suffix', () => {
  expect(extractJats(xml('<article><body><p>x</p><p>y</p><not-valid'), { xmlMaxNodes: 4 }).status).toBe('budget')
  expect(extractJats(xml('<article><body><sec><not-valid'), { xmlMaxDepth: 2 }).status).toBe('budget')
})
test('exact byte, depth, node and total text limits succeed and the next character fails', () => {
  const input = xml('<article><body><p>🧬</p><p>α</p></body></article>')
  const result = extractJats(input, { xmlMaxBytes: input.length, xmlMaxDepth: 3, xmlMaxNodes: 6, maxTextChars: 3 })
  expect(result.status).toBe('ok')
  expect(extractJats(input, { xmlMaxBytes: input.length - 1 }).status).toBe('budget')
  expect(extractJats(input, { maxTextChars: 2 }).status).toBe('budget')
})
test('the 10000-unit contract and bounded section locators are enforced without truncating to full', () => {
  expect(extractJats(xml(`<article><body>${'<p>x</p>'.repeat(10001)}</body></article>`)).status).toBe('budget')
  expect(extractJats(xml(`<article><body><sec><title>${'x'.repeat(1001)}</title><p>text</p></sec></body></article>`)).status).toBe('budget')
})
test('UTF8 BOM, namespaces, XML comments and paragraph escapes preserve stable Unicode output', () => {
  const result = extractJats(xml('\ufeff<?xml version="1.0"?><j:article xmlns:j="urn:jats"><j:body><j:sec><j:title>标题</j:title><!-- safe --><j:p>细胞 &#x1F9EC; &lt; 5 &gt; 1</j:p></j:sec></j:body></j:article>'))
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(result.blocks.map(block => block.text)).toEqual(['标题', '细胞 🧬 < 5 > 1'])
  expect(result.coverage.level).toBe('full')
})
