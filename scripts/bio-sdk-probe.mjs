// Runs only in the owned namespace created by bio-sdk.integration.test.mjs.
// Imports real installed SDKs; the Claude process boundary is a controlled
// spawner which stops before executing a native CLI or making a model call.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertBioEvidenceRuntime, getSdkPaths } from '../packages/shared/src/config/namespace.mjs';

const namespace = assertBioEvidenceRuntime();
const sdk = getSdkPaths();
assert.equal(resolve(homedir()), resolve(sdk.home));
const cwd = join(namespace, 'probe-work');
mkdirSync(cwd, { recursive: true });
mkdirSync(sdk.pi, { recursive: true });
mkdirSync(sdk.claude, { recursive: true });

// Fixture values are synthetic and never printed or sent to a provider.
writeFileSync(join(sdk.pi, 'auth.json'), JSON.stringify({
  'bio-fixture': { type: 'api_key', key: 'synthetic-owned-auth' },
}));
writeFileSync(join(sdk.pi, 'settings.json'), JSON.stringify({ defaultModel: 'owned-fixture-model' }));
writeFileSync(join(sdk.home, '.claude.json'), '\ufeff{}');

globalThis.fetch = async () => { throw new Error('SDK probe attempted network access'); };
const claude = await import('@anthropic-ai/claude-agent-sdk');
const pi = await import('@earendil-works/pi-coding-agent');
const { getDefaultOptions } = await import('../packages/shared/src/agent/options.ts');
const options = getDefaultOptions();
assert.equal(readFileSync(join(sdk.home, '.claude.json'), 'utf8'), '{}');
assert.equal(options.env.CLAUDE_CONFIG_DIR, sdk.claude);
assert.equal(options.env.HOME, sdk.home);

// SDK construction must pass our final isolated environment to its actual
// process extension point. The controlled spawner creates no OS process.
let captured;
let query;
try {
  query = claude.query({
    prompt: 'synthetic namespace probe',
    options: {
      ...options, cwd, settingSources: [], tools: [], persistSession: false,
      pathToClaudeCodeExecutable: join(namespace, 'never-executed-cli'),
      spawnClaudeCodeProcess(spawnOptions) {
        captured = spawnOptions;
        throw new Error('BIO_SDK_PROBE_STOP');
      },
    },
  });
  await query[Symbol.asyncIterator]().next();
} catch (error) {
  assert.match(String(error), /BIO_SDK_PROBE_STOP/);
} finally {
  query?.close();
}
assert.ok(captured, 'real Claude SDK did not reach controlled spawn boundary');
assert.equal(captured.env.CLAUDE_CONFIG_DIR, sdk.claude);
assert.equal(captured.env.USERPROFILE, sdk.home);
assert.equal(captured.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
assert.equal(captured.env.NODE_OPTIONS, undefined);
assert.equal(captured.env.ANTHROPIC_API_KEY, undefined);
assert.deepEqual(await claude.listSessions(), []);

assert.equal(pi.getAgentDir(), sdk.pi);
const auth = pi.AuthStorage.create();
assert.equal(auth.get('bio-fixture')?.key, 'synthetic-owned-auth');
const settings = pi.SettingsManager.create(cwd);
assert.equal(settings.getDefaultModel(), 'owned-fixture-model');
settings.setDefaultModel('owned-fixture-model-updated');
await settings.flush();
assert.equal(JSON.parse(readFileSync(join(sdk.pi, 'settings.json'), 'utf8')).defaultModel, 'owned-fixture-model-updated');
const registry = pi.ModelRegistry.create(auth);
const loader = new pi.DefaultResourceLoader({
  cwd, agentDir: sdk.pi, settingsManager: settings,
  noExtensions: true, noSkills: true, noPromptTemplates: true,
  noThemes: true, noContextFiles: true, systemPrompt: 'synthetic namespace probe',
});
await loader.reload();
const { session } = await pi.createAgentSession({
  cwd, agentDir: sdk.pi, authStorage: auth, modelRegistry: registry,
  settingsManager: settings, resourceLoader: loader,
  sessionManager: pi.SessionManager.inMemory(cwd), tools: [], noTools: 'all',
});
session.dispose();
assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
assert.equal(existsSync(join(sdk.home, '.craft-agent')), false);
assert.equal(existsSync(join(sdk.home, '.pi', 'agent')), false);

console.log(JSON.stringify({
  realSdkImports: true, claudeFinalSpawnEnvOwned: true,
  claudeOwnedConfigRepaired: true, piDefaultAuthAndSettingsOwned: true,
  piSessionConstructedWithoutModelRequest: true,
}));
