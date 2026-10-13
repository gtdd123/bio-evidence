import { z } from 'zod'
import { IdSchema, ScopeSchema, GenerationSchema } from './contracts'
export const DeploymentGrantSchema = z.strictObject({ id: IdSchema, scope: ScopeSchema, label: z.string().min(1).max(255), rootPath: z.string().min(1).max(4096) })
export type DeploymentGrant = z.infer<typeof DeploymentGrantSchema>
export const MaterialGrantViewSchema = DeploymentGrantSchema.omit({ rootPath: true })
export type MaterialGrantView = z.infer<typeof MaterialGrantViewSchema>
export const MaterialRootSchema = z.strictObject({ id: IdSchema, scope: ScopeSchema, grantId: IdSchema,
  relativeDir: z.string().max(4096), label: z.string().min(1).max(255), policy: z.literal('restricted') })
export type MaterialRoot = z.infer<typeof MaterialRootSchema>
export const MaterialEntrySchema = z.strictObject({ id: IdSchema, name: z.string().min(1).max(255), relativePath: z.string().max(4096),
  kind: z.enum(['directory', 'file']), size: GenerationSchema, modifiedAt: GenerationSchema, policy: z.literal('restricted') })
export type MaterialEntry = z.infer<typeof MaterialEntrySchema>
export const MaterialPageSchema = z.strictObject({ items: z.array(MaterialEntrySchema).max(200), generation: GenerationSchema, nextCursor: z.string().max(8192).optional() })
export type MaterialPage = z.infer<typeof MaterialPageSchema>
export interface StoredDeploymentGrant extends DeploymentGrant { authorityHash: string; active: boolean }
export const MaterialDirectoryStateSchema = z.strictObject({ key: z.string().regex(/^[a-f0-9]{64}$/), relativeDir: z.string().max(4096),
  generation: z.number().int().positive().safe(), status: z.enum(['indexing', 'complete', 'failed']), signature: z.string().min(1).max(500), count: GenerationSchema,
  reason: z.enum(['budget', 'offline', 'changed', 'interrupted']).optional() })
export type MaterialDirectoryState = z.infer<typeof MaterialDirectoryStateSchema>
export const IndexedMaterialEntrySchema = MaterialEntrySchema.extend({ directoryKey: z.string().regex(/^[a-f0-9]{64}$/),
  sortKey: z.string().max(4096), signature: z.string().min(1).max(500) })
export type IndexedMaterialEntry = z.infer<typeof IndexedMaterialEntrySchema>
export const MaterialSearchResultSchema = z.strictObject({ matches: z.array(z.strictObject({ fileId: IdSchema, name: z.string().max(255), snippet: z.string().max(400) })).max(64),
  truncated: z.boolean(), generation: z.number().int().positive(), filesRead: GenerationSchema, bytesRead: GenerationSchema, policy: z.literal('restricted'),
  skipped: z.strictObject({ oversize: GenerationSchema, unsupported: GenerationSchema, invalidEncoding: GenerationSchema }) })
export type MaterialSearchResult = z.infer<typeof MaterialSearchResultSchema>
export const MaterialAnnotationSchema = z.strictObject({ fileId: IdSchema, revision: GenerationSchema, note: z.string().max(5000),
  tags: z.array(z.string().trim().min(1).max(100)).max(20), policy: z.literal('restricted') })
export type MaterialAnnotation = z.infer<typeof MaterialAnnotationSchema>
export const MaterialBudgetsSchema = z.strictObject({ maxEntries: z.number().int().min(1).max(1000000).default(100000),
  scanMs: z.number().int().min(1).max(30000).default(30000), textFileBytes: z.number().int().min(1).max(262144).default(262144),
  textFiles: z.number().int().min(1).max(64).default(64), textTotalBytes: z.number().int().min(1).max(16777216).default(16777216),
  searchMs: z.number().int().min(1).max(2000).default(2000) })
const MaterialImageBase = z.strictObject({ rootId: IdSchema, fileId: IdSchema, generation: z.number().int().positive(), frameIndex: GenerationSchema,
  kind: z.enum(['metadata', 'thumbnail', 'view']), policy: z.literal('restricted') })
export const MaterialImageResultSchema = z.discriminatedUnion('status', [
  MaterialImageBase.extend({ status: z.literal('ok'), width: z.number().int().positive(), height: z.number().int().positive(), pages: z.number().int().positive(),
    format: z.enum(['png', 'jpeg', 'tiff']), bytes: z.instanceof(Uint8Array).refine(value => value.length <= 20971520).optional() }),
  MaterialImageBase.extend({ status: z.enum(['invalid', 'unsupported', 'budget', 'timeout', 'busy', 'unavailable']) }),
])
export type MaterialImageResult = z.infer<typeof MaterialImageResultSchema>
export const MaterialFileRequestSchema = z.strictObject({ rootId: IdSchema, fileId: IdSchema, generation: z.number().int().positive(), relativeDir: z.string().max(4096).default('') })
export const MaterialImageRequestSchema = MaterialFileRequestSchema.extend({ kind: z.enum(['metadata', 'thumbnail', 'view']).default('metadata'), frameIndex: z.number().int().min(0).max(1000000).default(0) })
export const MaterialImageBudgetsSchema = z.strictObject({ maxInputBytes: z.number().int().min(1).max(268435456).default(268435456),
  maxPixels: z.number().int().min(1).max(50000000).default(50000000), concurrency: z.number().int().min(1).max(2).default(2), timeoutMs: z.number().int().min(1).max(5000).default(5000) })
