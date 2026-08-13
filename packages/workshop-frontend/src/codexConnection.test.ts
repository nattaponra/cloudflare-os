import { describe, expect, it, vi } from 'vitest'
import { launchCodexConnection } from './codexConnection'

describe('launchCodexConnection', () => {
  it('continues in the current tab when the browser blocks the popup', async () => {
    const startConnection = vi.fn<() => Promise<{ url: string }>>(async () => ({
      url: 'https://workshop.test/gatekeeper/codex/account/nonce',
    }))
    const navigateCurrent = vi.fn<(url: string) => void>()

    const result = await launchCodexConnection(startConnection, {
      currentUrl: 'https://workshop.test/',
      openWindow: () => null,
      navigateCurrent,
    })

    expect(startConnection).toHaveBeenCalledOnce()
    expect(navigateCurrent).toHaveBeenCalledWith(
      'https://workshop.test/gatekeeper/codex/account/nonce',
    )
    expect(result).toBe('same-tab')
  })
})
