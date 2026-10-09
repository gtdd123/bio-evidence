import { assertBioEvidenceRuntime, getSdkPaths } from '../packages/shared/src/config/namespace.mjs';
assertBioEvidenceRuntime();
const sdk = getSdkPaths();
if (process.env.HOME !== sdk.home || process.env.USERPROFILE !== sdk.home || process.env.CLAUDE_CONFIG_DIR !== sdk.claude || process.env.PI_CODING_AGENT_DIR !== sdk.pi) {
  throw new Error('BioEvidence SDK roots must be provided by the isolated launcher');
}
