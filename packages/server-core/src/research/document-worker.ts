import { z } from 'zod'
import { DocumentBudgetsSchema, ParsedDocumentResultSchema } from '@bio-evidence/research-core'
const Command = z.strictObject({ format: z.enum(['pdf', 'jats']), length: z.number().int().min(0).max(25 * 1024 * 1024), budgets: DocumentBudgetsSchema })
// Library diagnostics may contain document content. Only the validated protocol is emitted.
for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) console[method] = () => {}
async function run() {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > 25 * 1024 * 1024 + 2048) return { status: 'budget' }
    chunks.push(Buffer.from(chunk))
  }
  const bytes = Buffer.concat(chunks), at = bytes.indexOf(10)
  if (at < 0 || at > 2048) return { status: 'invalid' }
  const command = Command.parse(JSON.parse(bytes.subarray(0, at).toString('utf8'))), input = bytes.subarray(at + 1)
  if (input.length !== command.length) return { status: 'invalid' }
  if (command.format === 'pdf') {
    const { extractPdf } = await import(new URL('./pdf-extractor.ts', import.meta.url).href)
    return extractPdf(input, command.budgets)
  }
  const { extractJats } = await import(new URL('./jats-extractor.ts', import.meta.url).href)
  return extractJats(input, command.budgets)
}
try { process.stdout.write(JSON.stringify(ParsedDocumentResultSchema.parse(await run()))) }
catch { process.stdout.write(JSON.stringify({ status: 'invalid' })) }
