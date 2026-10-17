import './bio-runtime-guard.mjs'
import { build } from 'vite'
import { bioRendererConfig } from './bio-vite-config'
const target = process.argv[2]
if (target !== 'web' && target !== 'desktop') throw Error('Expected renderer target web or desktop')
await build({ ...bioRendererConfig(target === 'web'), configFile: false })
