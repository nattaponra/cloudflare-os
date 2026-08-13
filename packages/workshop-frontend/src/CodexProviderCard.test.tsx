// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CodexProviderCard from './CodexProviderCard'

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

async function render(status: Parameters<typeof CodexProviderCard>[0]['status']) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(React.createElement(CodexProviderCard, {
    status,
    onConnect: vi.fn<() => Promise<void>>(),
    onReconnect: vi.fn<(accountId: number) => Promise<void>>(),
    onRefresh: vi.fn<() => Promise<void>>(),
    onDisconnect: vi.fn<(accountId: number) => Promise<void>>(),
  })))
  return container
}

describe('CodexProviderCard', () => {
  it('stays hidden when the optional worker is unavailable', async () => {
    expect((await render({ available: false, connected: false })).textContent).toBe('')
  })

  it('shows account model count and stale/expired states', async () => {
    const view = await render({
      available: true, connected: true, accountId: 4, credentialsValid: true,
      modelCount: 12, stale: true, lastUpdatedAt: 1_000,
    })
    expect(view.textContent).toContain('ChatGPT / Codex subscription')
    expect(view.textContent).toContain('12 models available')
    expect(view.textContent).toContain('Catalog may be out of date')
  })
})
