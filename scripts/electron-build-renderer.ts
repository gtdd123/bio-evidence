/**
 * Cross-platform renderer build script
 */

import { spawn } from "bun";
import { existsSync, realpathSync, rmSync } from "fs";
import { join } from "path";
import { assertInside } from './bio-launch.mjs';
import { buildBunCommand, createBuildEnv } from './bio-build.mjs';

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

// Clean renderer dist first
const rendererDir = join(ELECTRON_DIR, "dist/renderer");
if (existsSync(rendererDir)) {
  assertInside(ELECTRON_DIR, rendererDir, 'Renderer cleanup');
  assertInside(realpathSync(ELECTRON_DIR), realpathSync(rendererDir), 'Renderer cleanup');
  rmSync(rendererDir, { recursive: true, force: true });
}

const proc = spawn({
  cmd: buildBunCommand(["run", "vite", "build", "--config", "apps/electron/vite.config.ts"], ROOT_DIR),
  cwd: ROOT_DIR,
  stdout: "inherit",
  stderr: "inherit",
  env: createBuildEnv(),
});

const exitCode = await proc.exited;
process.exit(exitCode);
