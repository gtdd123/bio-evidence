import React from 'react'
import ReactDOM from 'react-dom/client'
import { setupI18n } from '@craft-agent/shared/i18n'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import BioApp from './bio/BioApp'
import type { BioDesktopWireHost } from '../shared/bio-api'
import { createDesktopBioHost } from './bio/desktop-host'
import './index.css'
setupI18n([LanguageDetector, initReactI18next])
const wire = (window as Window & { bioBridge?: BioDesktopWireHost }).bioBridge
const host = wire ? createDesktopBioHost(wire) : undefined
ReactDOM.createRoot(document.getElementById('root')!).render(host ? <BioApp host={host} /> : <p role="alert">BioEvidence · Desktop connection unavailable.</p>)
