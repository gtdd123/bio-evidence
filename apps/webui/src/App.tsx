import React, { lazy, Suspense } from 'react'
const Workspace = lazy(() => import.meta.env.VITE_DEMO_MODE ? import('./demo/DemoApp') : import('./RealApp'))
export default function App() { return <Suspense fallback={<p role="status">Loading BioEvidence…</p>}><Workspace /></Suspense> }
