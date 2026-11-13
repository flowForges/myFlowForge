import { createRoot } from 'react-dom/client'
import { OverlayApp, type CuOverlayApi } from './OverlayApp'

// The preload exposes only this bridge to the overlay window (OVERLAY_ARG), never `window.forge`.
const api = (window as unknown as { cuOverlay: CuOverlayApi }).cuOverlay
createRoot(document.getElementById('cuo-root')!).render(<OverlayApp api={api} />)
