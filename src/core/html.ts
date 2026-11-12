/**
 * Webview HTML builders. Kept free of `vscode` so the markup can be asserted in
 * tests; the webview message channel is the same in every page.
 */

export interface DshAction {
  act: string;
  label: string;
}

const DSH_PAGE_CSS = `
  html,body{height:100%;margin:0;padding:0;background:#1e1e1e;color:#ccc;font-family:sans-serif}
  #frame{position:absolute;inset:0;width:100%;height:100%;border:0;display:none}
  #fallback{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;text-align:center}
  button,input{font-size:13px}
  button{background:#0e639c;color:#fff;border:0;padding:6px 14px;cursor:pointer;border-radius:2px;margin:0 4px}
  input{width:90%;padding:6px;background:#3c3c3c;color:#eee;border:1px solid #555;border-radius:2px}
  .err{max-width:90%;line-height:1.5}
  code{background:#333;padding:1px 4px;border-radius:2px}
`;

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A centred message with action buttons wired to the webview message channel. */
export function dshMessage(title: string, detail: string, actions: readonly DshAction[] = []): string {
  const buttons = actions.map((a) => `<button data-act="${a.act}">${a.label}</button>`).join('');
  return `<!DOCTYPE html>
<html style="height:100%">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>${DSH_PAGE_CSS}</style>
</head>
<body>
<div id="fallback"><div class="err"><b>${title}</b><br/>${detail}</div><div>${buttons}</div></div>
<script>
  const vs = acquireVsCodeApi();
  for (const el of document.querySelectorAll('button[data-act]')) el.addEventListener('click', () => vs.postMessage({ type: el.dataset.act }));
</script>
</body>
</html>`;
}

/** The DSH web UI in an iframe, with a load-failure fallback. */
export function dshFrame(frameSrc: string): string {
  let frameOrigin = frameSrc;
  try {
    frameOrigin = new URL(frameSrc).origin;
  } catch {
    // keep the raw value; CSP will simply not match
  }
  return `<!DOCTYPE html>
<html style="height:100%">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${frameOrigin}; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">
<style>${DSH_PAGE_CSS}</style>
</head>
<body>
<iframe id="frame" src="${frameSrc}" allow="clipboard-read; clipboard-write"></iframe>
<div id="fallback" style="display:none"><div class="err">Loading DSH…</div><button data-act="retry">Retry</button></div>
<script>
  const vs = acquireVsCodeApi();
  const frame = document.getElementById('frame');
  const fallback = document.getElementById('fallback');
  let loaded = false;
  frame.addEventListener('load', () => { loaded = true; frame.style.display = 'block'; fallback.style.display = 'none'; });
  setTimeout(() => { if (!loaded) { fallback.style.display = 'flex'; fallback.querySelector('.err').textContent = 'Cannot reach the DSH web GUI. Is it running?'; } }, 12000);
  for (const el of document.querySelectorAll('button[data-act]')) el.addEventListener('click', () => vs.postMessage({ type: el.dataset.act }));
</script>
</body>
</html>`;
}

/** Prompt for the `dsh web: <url>` launch line when no token is known yet. */
export function dshTokenPrompt(url: string): string {
  return `<!DOCTYPE html>
<html style="height:100%">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>${DSH_PAGE_CSS}</style>
</head>
<body>
<div id="fallback"><div class="err">DSH web GUI needs authentication.<br/>Paste the <code>dsh web: &lt;url&gt;</code> line printed at startup:</div><input id="tok" placeholder="${url}/?token=…" /><button data-act="open">Open</button></div>
<script>
  const vs = acquireVsCodeApi();
  document.querySelector('button[data-act=open]').addEventListener('click', () => {
    const v = document.getElementById('tok').value.trim();
    if (v) vs.postMessage({ type: 'setToken', url: v });
  });
</script>
</body>
</html>`;
}

/** First-run setup when no proxy can reach the OpenCode server. */
export function opencodeSetup(serverUrl: string, hasPassword: boolean, error = ''): string {
  const errorBlock = error ? `<div class="err">${escapeHtml(error)}</div>` : '';
  return `<!DOCTYPE html>
<html style="height:100%">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>${DSH_PAGE_CSS}
  #setup{max-width:420px;width:88%;margin:0 auto}
  #setup h2{margin:0 0 8px;font-size:16px;color:#eee}
  #setup p{margin:0 0 16px;line-height:1.4}
  #setup label{display:block;margin:12px 0 4px;font-size:12px;color:#bbb}
  #setup input{display:block;width:100%;box-sizing:border-box}
  #setup .actions{margin-top:16px;display:flex;gap:8px;flex-wrap:wrap}
</style>
</head>
<body>
<div id="fallback">
  <div id="setup">
    <h2>Connect to OpenCode</h2>
    <p>Enter the OpenCode server URL and password. For a local server, the password is read from <code>~/.config/opencode/service.json</code> when the field is empty.</p>
    ${errorBlock}
    <label for="url">Server URL</label>
    <input id="url" value="${escapeHtml(serverUrl)}" spellcheck="false" />
    <label for="password">Password</label>
    <input id="password" type="password" placeholder="${hasPassword ? 'saved — leave empty to keep it' : 'service.json or opencodeWeb.password'}" />
    <div class="actions">
      <button data-act="connect">Save &amp; Connect</button>
      <button data-act="openSettings">Open Settings</button>
    </div>
  </div>
</div>
<script>
  const vs = acquireVsCodeApi();
  document.querySelector('button[data-act=connect]').addEventListener('click', () => {
    const url = document.getElementById('url').value.trim();
    const password = document.getElementById('password').value;
    vs.postMessage({ type: 'connect', serverUrl: url, password });
  });
  document.querySelector('button[data-act=openSettings]').addEventListener('click', () => {
    vs.postMessage({ type: 'openSettings' });
  });
</script>
</body>
</html>`;
}

/** The OpenCode web UI in an iframe, with a load-failure fallback. */
export function opencodeFrame(proxyUrl: string, target: string): string {
  return `<!DOCTYPE html>
<html style="height:100%">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${proxyUrl}; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">
<style>
  html,body{height:100%;margin:0;padding:0;background:#1e1e1e;color:#ccc;font-family:sans-serif}
  #frame{position:absolute;inset:0;width:100%;height:100%;border:0;visibility:hidden}
  #fallback{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}
  button{background:#0e639c;color:#fff;border:0;padding:6px 14px;cursor:pointer;border-radius:2px}
  .err{max-width:80%;text-align:center;line-height:1.5}
</style>
</head>
<body>
<iframe id="frame" src="${target}" allow="clipboard-read; clipboard-write"></iframe>
<div id="fallback">
  <div class="err">Loading OpenCode…</div>
  <button onclick="retry()">Retry</button>
</div>
<script>
  const vs = acquireVsCodeApi();
  const frame = document.getElementById('frame');
  const fallback = document.getElementById('fallback');
  let loaded = false;
  frame.addEventListener('load', () => {
    loaded = true;
    frame.style.visibility = 'visible';
    fallback.style.display = 'none';
  });
  // if src fails (proxy dead), the load event never fires; check after a timeout
  setTimeout(() => { if (!loaded) { fallback.querySelector('.err').textContent = 'Cannot reach the OpenCode proxy. Make sure the opencode server is running.'; } }, 5000);
  function retry() { location.reload(); }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source === frame.contentWindow && e.origin === ${JSON.stringify(new URL(proxyUrl).origin)}) {
      if (m && m.type === 'opencode:openExternal' && typeof m.url === 'string') {
        try {
          const url = new URL(m.url);
          if (url.protocol === 'http:' || url.protocol === 'https:') vs.postMessage({ type: 'openExternal', url: url.href });
        } catch {}
      }
      return;
    }
    if ((!e.source || e.source === window) && m && m.type === 'navigate' && m.url) {
      try { if (new URL(m.url).origin !== ${JSON.stringify(new URL(proxyUrl).origin)}) return; } catch { return; }
      loaded = false;
      frame.src = m.url;
    }
  });
</script>
</body>
</html>`;
}
