import type { WebContents } from 'electron'

export class WindowRegistry {
  private wcs = new Set<WebContents>()

  add(wc: WebContents): void {
    this.wcs.add(wc)
    wc.once('destroyed', () => this.wcs.delete(wc))
  }

  // arrow property so `registry.broadcast` can be passed by reference
  broadcast = (channel: string, payload: unknown): void => {
    for (const wc of this.wcs) {
      if (!wc.isDestroyed()) wc.send(channel, payload)
    }
  }
}
