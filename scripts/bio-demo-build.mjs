import { launch } from './bio-launch.mjs';
process.env.VITE_DEMO_MODE = 'true';
process.exitCode = launch({ purpose: 'build', args: ['run', 'scripts/bio-renderer-build.ts', 'web'] });
