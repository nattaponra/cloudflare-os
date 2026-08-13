// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AddModelModal from './AddModelModal'

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

describe('AddModelModal Codex connection', () => {
  it('starts the connection without requiring an API token', async () => {
    const connectAccount = vi.fn<() => Promise<{ url: string }>>(async () => ({
      url: '/gatekeeper/codex/account/nonce',
    }))
    vi.spyOn(window, 'open').mockReturnValue({
      close: vi.fn<() => void>(),
      location: { href: 'about:blank' },
      opener: window,
    } as unknown as Window)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(React.createElement(AddModelModal, {
      visible: true,
      onCancel: vi.fn<() => void>(),
      onSuccess: vi.fn<(provider: string) => void>(),
      authenticatedApi: { connectAccount },
      aiConfig: null,
      codexAvailable: true,
    } as never)))

    const combobox = document.querySelector('[role="combobox"]') as HTMLButtonElement
    await act(async () => combobox.click())
    const option = [...document.querySelectorAll('[role="option"]')]
      .find((element) => element.textContent?.includes('ChatGPT / Codex subscription')) as HTMLElement
    await act(async () => option.click())
    const connect = [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Connect') as HTMLButtonElement
    await act(async () => connect.click())

    expect(connectAccount).toHaveBeenCalledWith('codex')
  })
})
