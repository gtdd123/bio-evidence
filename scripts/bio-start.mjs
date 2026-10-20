import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLaunch, assertInside } from './bio-launch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function createBioStartSpec(kind, purpose = 'runtime') {
  if (!['server', 'desktop'].includes(kind) || !['runtime', 'test'].includes(purpose)) throw Error('Unknown BioEvidence start mode');
  const spec = prepareLaunch({ purpose, args: ['run', 'packages/server/src/bio-index.ts', '--control-stdio'], projectRoot: root });
  let executable = spec.executable, args = spec.args;
  if (kind === 'desktop') {
    executable = createRequire(import.meta.url)('electron');
    assertInside(realpathSync(join(root, 'node_modules')), realpathSync(executable), 'Electron runtime');
    const entry = join(root, 'apps/electron/dist/bio-main.cjs');
    if (!existsSync(entry) || !existsSync(join(root, 'apps/electron/dist/renderer/bio.html'))) throw Error('Build BioEvidence desktop before starting');
    args = [entry];
  }
  return { ...spec, executable, args };
}
export function superviseBioProcess(spec, kind, { controlledInput = false } = {}) {
  // A Windows attached child is terminated with the supervisor's job before it
  // can flush. A detached service instead owns its lifetime through the bounded
  // control-pipe lease; keep its handle referenced until cleanup completes.
  const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, stdio: [kind === 'server' ? 'pipe' : 'ignore', 'inherit', 'inherit'], detached: kind === 'server', windowsHide: true });
  let stopping = false, timedOut = false, timer, inputBuffer = '';
  const heartbeat = kind === 'server' ? setInterval(() => { if (!stopping) child.stdin?.write('{"type":"heartbeat"}\n'); }, 500) : undefined;
  const armFallback = () => {
    timer ??= setTimeout(() => { timedOut = true; child.kill('SIGKILL'); process.exitCode = 1; }, 15000);
  };
  const stop = () => {
    if (stopping || child.exitCode !== null) return;
    stopping = true;
    if (kind === 'server') child.stdin?.write('{"type":"shutdown"}\n');
    else child.kill('SIGTERM');
    armFallback();
  };
  const eof = () => { stopping = true; armFallback(); child.stdin?.end(); };
  const forward = data => {
    if (stopping) return;
    inputBuffer += data.toString();
    if (Buffer.byteLength(inputBuffer) > 4096) { eof(); return; }
    for (;;) {
      const newline = inputBuffer.indexOf('\n'); if (newline < 0) return;
      const line = inputBuffer.slice(0, newline); inputBuffer = inputBuffer.slice(newline + 1);
      try {
        const frame = JSON.parse(line);
        if (!frame || Object.keys(frame).length !== 1) throw Error('Invalid owned control');
        if (frame.type === 'shutdown') { stop(); return; }
        if (frame.type !== 'heartbeat') throw Error('Invalid owned control');
        child.stdin?.write('{"type":"heartbeat"}\n');
      } catch { eof(); return; }
    }
  };
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (controlledInput) { process.stdin.off('data', forward); process.stdin.off('end', eof); process.stdin.off('error', eof); process.stdin.pause(); }
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  if (controlledInput) { process.stdin.on('data', forward); process.stdin.once('end', eof); process.stdin.once('error', eof); }
  child.stdin?.on('error', () => {});
  const exited = new Promise(resolveExit => {
    child.once('error', () => { cleanup(); console.error('BioEvidence process could not start.'); process.exitCode = 1; resolveExit(1); });
    child.once('exit', (code, signal) => { cleanup(); const status = timedOut || signal || code === null ? 1 : code; process.exitCode = status; resolveExit(status); });
  });
  return { child, stop, exited };
}
export function startBioProcess(kind, options = {}) {
  if (options.controlledInput && kind !== 'server') throw Error('Unknown BioEvidence start mode');
  return superviseBioProcess(createBioStartSpec(kind), kind, options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [kind, ...args] = process.argv.slice(2);
    if (args.some(argument => argument !== '--control-stdio')) throw Error('Unknown start option');
    await startBioProcess(kind, { controlledInput: args.includes('--control-stdio') }).exited;
  } catch (error) { console.error(`[BioEvidence start] ${error instanceof Error ? error.message : 'Launch rejected'}`); process.exitCode = 1; }
}
