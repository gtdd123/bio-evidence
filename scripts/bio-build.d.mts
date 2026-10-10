export function createBuildEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function buildBunCommand(args: string[], root: string): string[];
export function createClientDefines(): Record<string, string>;
