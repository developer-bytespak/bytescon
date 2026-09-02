/**
 * The sign-in / consent page rendered at GET /mcp/oauth/authorize.
 *
 * The page asks the subscriber to paste their Bytescon API token (the same
 * token issued to their firm). On submit it POSTs back to the authorize
 * endpoint, which validates the token against api_tokens and, on success,
 * issues an authorization code. All reflected values are HTML-escaped; the
 * redirect_uri and client_id are validated BEFORE this page is ever rendered,
 * so nothing untrusted is echoed into a redirect.
 *
 * No external assets, no scripts, no em/en dashes (user-facing copy rule).
 */

export interface ConsentParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  scope: string;
  resource: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hiddenField(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`;
}

export function renderConsentPage(opts: {
  actionPath: string;
  clientName: string;
  params: ConsentParams;
  errorMessage?: string;
}): string {
  const { actionPath, clientName, params, errorMessage } = opts;
  const hidden = [
    hiddenField("response_type", params.response_type),
    hiddenField("client_id", params.client_id),
    hiddenField("redirect_uri", params.redirect_uri),
    hiddenField("code_challenge", params.code_challenge),
    hiddenField("code_challenge_method", params.code_challenge_method),
    hiddenField("state", params.state),
    hiddenField("scope", params.scope),
    hiddenField("resource", params.resource),
  ].join("\n        ");

  const errorBlock = errorMessage
    ? `<p class="error" role="alert">${escapeHtml(errorMessage)}</p>`
    : "";

  // Show WHERE the authorization code will be sent. This is the human trust
  // checkpoint in the paste-token model: the user must be able to spot a
  // hostile redirect destination before pasting a real API token.
  let destHost: string;
  try {
    destHost = new URL(params.redirect_uri).host;
  } catch {
    destHost = params.redirect_uri;
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Connect to Bytescon</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      background: #0f172a; color: #e2e8f0; margin: 0; display: flex;
      min-height: 100vh; align-items: center; justify-content: center; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px;
      padding: 32px; width: 100%; max-width: 420px; box-shadow: 0 10px 30px rgba(0,0,0,0.35); }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .sub { color: #94a3b8; font-size: 14px; margin: 0 0 20px; }
    .client { background: #0f172a; border: 1px solid #334155; border-radius: 8px;
      padding: 10px 12px; font-size: 13px; color: #cbd5e1; margin-bottom: 12px; }
    .dest { background: #0f172a; border: 1px solid #475569; border-radius: 8px;
      padding: 10px 12px; font-size: 13px; color: #cbd5e1; margin-bottom: 20px; }
    .dest strong { color: #fbbf24; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      word-break: break-all; }
    label { display: block; font-size: 14px; margin-bottom: 6px; color: #cbd5e1; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 11px 12px;
      border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #e2e8f0;
      font-size: 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    button { width: 100%; margin-top: 18px; padding: 12px; border: 0; border-radius: 8px;
      background: #2563eb; color: white; font-size: 15px; font-weight: 600; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .hint { color: #94a3b8; font-size: 12px; margin-top: 14px; line-height: 1.5; }
    .error { background: #7f1d1d; border: 1px solid #b91c1c; color: #fecaca;
      border-radius: 8px; padding: 10px 12px; font-size: 13px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Connect to Bytescon</h1>
    <p class="sub">Sign in to let this application reach your opportunity intelligence.</p>
    <div class="client">Requesting application: <strong>${escapeHtml(clientName)}</strong></div>
    <div class="dest">After you authorize, access will be sent to:<br /><strong>${escapeHtml(destHost)}</strong>.
      Only continue if you recognize this destination.</div>
    ${errorBlock}
    <form method="post" action="${escapeHtml(actionPath)}" autocomplete="off">
        ${hidden}
        <label for="api_token">Your Bytescon API token</label>
        <input id="api_token" name="api_token" type="password" required
          autocomplete="off" spellcheck="false"
          placeholder="Paste your API token" />
        <button type="submit">Authorize</button>
    </form>
    <p class="hint">This is the same API token your firm uses to connect Claude Desktop.
      The token is checked over an encrypted connection and is never stored by this page.
      If you do not have one, an administrator can issue it from your Bytescon account.</p>
  </main>
</body>
</html>`;
}

/**
 * A terminal error page shown when the request cannot be trusted enough to
 * redirect back to the client (unknown client_id or unregistered redirect_uri).
 */
export function renderErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Connection error</title>
  <style>
    body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      background: #0f172a; color: #e2e8f0; margin: 0; display: flex; min-height: 100vh;
      align-items: center; justify-content: center; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px;
      padding: 32px; max-width: 420px; }
    h1 { font-size: 18px; margin: 0 0 10px; }
    p { color: #cbd5e1; font-size: 14px; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Could not start sign-in</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`;
}
