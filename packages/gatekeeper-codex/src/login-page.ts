const DEVICE_URL = "https://auth.openai.com/codex/device";

export type DevicePollPayload =
  | { status: "pending" }
  | { status: "complete" }
  | { status: "error"; message: string };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function deviceLoginPage(options: {
  userCode: string;
  pollUrl: string;
  intervalMs: number;
}): Response {
  const code = escapeHtml(options.userCode.slice(0, 256));
  const intervalMs = Math.max(3_000, Math.min(60_000, Math.floor(options.intervalMs)));
  const scriptNonce = nonce();
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Connect ChatGPT / Codex</title>
  <style nonce="${scriptNonce}">
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { display:grid; min-height:100vh; margin:0; place-items:center; background:#f4f5f7; color:#171717; }
    main { width:min(32rem, calc(100% - 2rem)); padding:2rem; border:1px solid #ddd; border-radius:1rem; background:white; box-shadow:0 8px 30px #0001; }
    code { display:block; margin:1rem 0; padding:1rem; font-size:1.6rem; text-align:center; letter-spacing:.12em; background:#f2f2f2; border-radius:.5rem; }
    a, button { display:inline-block; padding:.7rem 1rem; border-radius:.5rem; }
    a { color:white; background:#111; text-decoration:none; }
    button { border:1px solid #bbb; background:white; color:#111; cursor:pointer; }
    #status { min-height:1.5rem; margin-top:1rem; }
  </style>
</head>
<body>
  <main>
    <h1>Connect ChatGPT / Codex</h1>
    <p>Open the OpenAI device page and enter this one-time code:</p>
    <code id="device-code">${code}</code>
    <p>
      <a href="${DEVICE_URL}" target="_blank" rel="noopener noreferrer">Open OpenAI device page</a>
      <button id="copy" type="button">Copy code</button>
    </p>
    <p id="status" role="status" aria-live="polite">Waiting for approval…</p>
  </main>
  <script nonce="${scriptNonce}">
    const pollPath = ${scriptJson(options.pollUrl)};
    const intervalMs = ${intervalMs};
    const status = document.getElementById("status");
    document.getElementById("copy").addEventListener("click", async () => {
      await navigator.clipboard.writeText(document.getElementById("device-code").textContent);
      status.textContent = "Code copied. Waiting for approval…";
    });
    async function poll() {
      try {
        const target = new URL(pollPath, window.location.origin);
        if (target.origin !== window.location.origin) throw new Error("invalid poll target");
        const response = await fetch(target, { cache: "no-store", credentials: "same-origin" });
        const result = await response.json();
        if (result.status === "complete") {
          status.textContent = "Connected. You may close this window.";
          window.close();
          window.setTimeout(() => {
            if (!window.closed) window.location.replace("/");
          }, 250);
          return;
        }
        if (result.status === "error") {
          status.textContent = result.message || "Connection failed. Return to Cloudflare OS and try again.";
          return;
        }
      } catch {
        status.textContent = "Connection check failed. Retrying…";
      }
      window.setTimeout(poll, intervalMs);
    }
    window.setTimeout(poll, intervalMs);
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${scriptNonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function devicePollResponse(payload: DevicePollPayload): Response {
  const bounded = payload.status === "error"
    ? { status: "error" as const, message: payload.message.slice(0, 256) }
    : payload;
  return Response.json(bounded, {
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
