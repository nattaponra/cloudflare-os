type ConnectionTarget = { url: string }

interface LaunchCodexConnectionOptions {
  currentUrl?: string
  openWindow?: () => Window | null
  navigateCurrent?: (url: string) => void
}

/**
 * Starts a Codex connection without making popup support a requirement.
 *
 * Opening a blank window synchronously keeps the normal flow compatible with popup blockers. Some
 * browsers still reject that window entirely, so the validated Gatekeeper URL becomes a same-tab
 * navigation in that case.
 */
export async function launchCodexConnection(
  startConnection: () => Promise<ConnectionTarget>,
  options: LaunchCodexConnectionOptions = {},
): Promise<'popup' | 'same-tab'> {
  const popup = (options.openWindow ?? (() => window.open('about:blank', '_blank')))()
  if (popup) popup.opener = null

  try {
    const { url } = await startConnection()
    const currentUrl = options.currentUrl ?? window.location.href
    const target = new URL(url, currentUrl)
    const current = new URL(currentUrl)
    if (target.origin !== current.origin || !target.pathname.startsWith('/gatekeeper/codex/')) {
      throw new Error('Invalid Codex connection URL')
    }

    if (popup) {
      popup.location.href = target.href
      return 'popup'
    }

    const navigateCurrent = options.navigateCurrent ?? ((destination: string) => {
      window.location.assign(destination)
    })
    navigateCurrent(target.href)
    return 'same-tab'
  } catch (error) {
    popup?.close()
    throw error
  }
}
