// Evaluate a JS expression in the debug app's WebView via Chrome DevTools Protocol.
// usage: node scripts/cdp-eval.mjs <port> "<expr>"   (after: adb forward tcp:<port> localabstract:webview_devtools_remote_<pid>)
const [port, expr] = process.argv.slice(2);
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find((p) => p.url.includes("appassets")) || pages[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `JSON.stringify(${expr})`, awaitPromise: true, returnByValue: true } }));
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.id === 1) { console.log(d.result?.result?.value ?? JSON.stringify(d.result)); ws.close(); }
});
