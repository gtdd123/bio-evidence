import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { z } from 'zod'
import { DeploymentGrantSchema, ResearchError, parseContract } from '@bio-evidence/research-core'
import { resolveConfigDir, validateNamespacePath } from '@craft-agent/shared/config/namespace'
/** Deployment operator only: never accepted from an account/RPC request. */
export function loadMaterialGrants(file = 'material-grants.json') {
  const config = resolveConfigDir(), target = validateNamespacePath(resolve(config, file))
  if (!existsSync(target)) return []
  try {
    if (relative(resolve(target), realpathSync.native(target)) !== '' || relative(resolve(config), realpathSync.native(config)) !== '') throw new ResearchError('BIO_ACCESS_DENIED')
    const info = lstatSync(target)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576) throw new ResearchError('BIO_INPUT_INVALID')
    return parseContract(z.array(DeploymentGrantSchema).max(1000), JSON.parse(readFileSync(target, 'utf8')))
  } catch (error) { throw error instanceof ResearchError ? error : new ResearchError('BIO_INPUT_INVALID') }
}
