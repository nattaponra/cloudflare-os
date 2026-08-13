import { useState } from 'react'
import type { CodexProviderStatus } from '@gadgets/workshop-shared/api'

type Props = {
  status: CodexProviderStatus
  onConnect(): Promise<void>
  onReconnect(accountId: number): Promise<void>
  onRefresh(): Promise<void>
  onDisconnect(accountId: number): Promise<void>
}

const BUTTON = 'rounded-lg border border-kumo-line px-3 py-1.5 text-xs font-medium text-kumo-default disabled:cursor-not-allowed disabled:opacity-50'

export default function CodexProviderCard({
  status, onConnect, onReconnect, onRefresh, onDisconnect,
}: Props) {
  const [busy, setBusy] = useState(false)
  const run = async (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try { await operation() } finally { setBusy(false) }
  }

  if (!status.available) return null
  return (
    <section className="mx-3 mb-3 rounded-xl border border-kumo-line bg-kumo-base p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-kumo-default">ChatGPT / Codex subscription</h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-kumo-subtle">
            Uses the models and quota available to your OpenAI ChatGPT account. Traffic goes
            directly to Codex and does not use Cloudflare AI Gateway billing.
          </p>
          {status.connected && (
            <p className="mt-2 text-xs text-kumo-subtle" aria-live="polite">
              {status.credentialsValid
                ? `${status.modelCount} models available`
                : 'Credentials expired — reconnect to continue.'}
              {status.stale && ' · Catalog may be out of date'}
              {status.lastUpdatedAt > 0 &&
                ` · Updated ${new Date(status.lastUpdatedAt).toLocaleString()}`}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {!status.connected ? (
            <button className={BUTTON} disabled={busy} onClick={() => run(onConnect)}>Connect</button>
          ) : (
            <>
              <button className={BUTTON} disabled={busy || !status.credentialsValid}
                onClick={() => run(onRefresh)}>Refresh models</button>
              <button className={BUTTON} disabled={busy}
                onClick={() => run(() => onReconnect(status.accountId))}>Reconnect</button>
              <button className={`${BUTTON} text-kumo-danger`} disabled={busy}
                onClick={() => {
                  if (confirm('Disconnect ChatGPT / Codex locally? This does not revoke your OpenAI session.')) {
                    void run(() => onDisconnect(status.accountId))
                  }
                }}>Disconnect</button>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
