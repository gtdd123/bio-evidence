export interface SdkPaths { home: string; claude: string; pi: string; xdg: string }
export function isBioEvidenceMode(env?: NodeJS.ProcessEnv): boolean;
export function resolveConfigDir(env?: NodeJS.ProcessEnv): string;
export function validateNamespacePath(directory: string, env?: NodeJS.ProcessEnv): string;
export function getSdkPaths(env?: NodeJS.ProcessEnv): SdkPaths;
export function getSdkHomeDir(env?: NodeJS.ProcessEnv): string;
export function getGlobalSkillsDir(env?: NodeJS.ProcessEnv): string;
export function buildNamespaceEnv(base?: NodeJS.ProcessEnv, overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function assertBioEvidenceRuntime(): string;
