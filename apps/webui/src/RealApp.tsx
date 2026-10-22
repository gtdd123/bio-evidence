import React from 'react'
import BioApp from '@/bio/BioApp'
import { createWebBioHost } from './adapter/bio-host'
const host = createWebBioHost()
export default function RealApp() { return <BioApp host={host} /> }
