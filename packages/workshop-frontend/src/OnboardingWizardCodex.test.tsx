// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => {
  const getCodexProviderStatus = vi.fn<() => Promise<{ available: true; connected: false }>>(
    async () => ({ available: true, connected: false }),
  )
  return {
    addToast: vi.fn<(toast: unknown) => void>(),
    currentUser: { id: 'user-1', name: 'Test User' },
    getCodexProviderStatus,
    authenticatedApi: {
      listModels: vi.fn<() => Promise<never[]>>(async () => []),
      getAiConfig: vi.fn<() => Promise<{ enabled: false }>>(async () => ({ enabled: false })),
      getCodexProviderStatus,
      listGatekeeperVendors: vi.fn<() => Promise<never[]>>(async () => []),
      subscribeConnectedAccounts: vi.fn<() => Promise<{ [Symbol.dispose](): void }>>(
        async () => ({ [Symbol.dispose]: vi.fn<() => void>() }),
      ),
    },
  }
})

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: testState.addToast }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({
    currentUser: testState.currentUser,
    authenticatedApi: testState.authenticatedApi,
  }),
}))

vi.mock('./AddModelModal', () => ({
  default: ({ codexAvailable }: { codexAvailable?: boolean }) =>
    React.createElement('div', { 'data-testid': 'add-model-modal', 'data-codex': String(codexAvailable) }),
}))
vi.mock('./ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'Cloudflare OS' }))
vi.mock('./useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))

import OnboardingWizard from './OnboardingWizard'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.stubGlobal('requestAnimationFrame', vi.fn<(callback: FrameRequestCallback) => number>(() => 1))

describe('OnboardingWizard Codex provider', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    vi.clearAllMocks()
  })

  it('loads Codex availability and exposes the connector in the add-model dialog', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    act(() => root!.render(React.createElement(OnboardingWizard, {
      onComplete: vi.fn<() => void>(),
    })))

    await vi.waitFor(() => {
      expect(testState.getCodexProviderStatus).toHaveBeenCalledOnce()
      expect(container!.querySelector('[data-testid="add-model-modal"]')?.getAttribute('data-codex'))
        .toBe('true')
    })
  })
})
