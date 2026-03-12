const CDP = require("chrome-remote-interface");
const http = require("node:http");
const { execSync } = require("node:child_process");

const HTML = `<!DOCTYPE html><html><body><script>
function calledFn() { return 42; }
function neverCalledFn() { return 99; }
calledFn();
<\/script></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'text/html'});
  res.end(HTML);
});

server.listen(9001, async () => {
  console.log('Server on :9001');
  // Start Chrome via execSync (returns when Chrome exits or use &)
  execSync(`'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --headless --remote-debugging-port=9901 --no-sandbox --disable-gpu --no-first-run --disable-extensions --user-data-dir=/tmp/chrome-cov4 &`);

  await new Promise(r => setTimeout(r, 2000));
  let browser;
  try {
    const version = await CDP.Version({ port: 9901 });
    browser = await CDP({ target: version.webSocketDebuggerUrl });

    let pageSessionId;
    await browser.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    
    pageSessionId = await new Promise(resolve => {
      browser.Target.attachedToTarget(({ targetInfo, sessionId }) => {
        if (targetInfo.type === 'page') resolve(sessionId);
      });
      browser.Target.createTarget({ url: 'about:blank' });
    });

    console.log('Session:', pageSessionId);
    const send = (m, p={}) => browser.send(m, p, pageSessionId);

    await send('Profiler.enable');
    await send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
    await send('Page.enable');

    await new Promise(resolve => {
      browser.Page.loadEventFired((ev, sid) => { if (sid === pageSessionId) resolve(); });
      send('Page.navigate', { url: 'http://localhost:9001/' });
    });
    console.log('Page loaded');

    const d1 = await send('Profiler.takePreciseCoverage');
    console.log('\n=== AFTER INITIAL LOAD ===');
    for (const s of (d1.result||[])) {
      if (!s.url.includes('9001')) continue;
      console.log(`  functions: ${s.functions.length}`);
      s.functions.forEach(f => console.log(`    "${f.functionName||'(anon)'}" count=${f.ranges[0]?.count}`));
    }

    await new Promise(resolve => {
      browser.Page.loadEventFired((ev, sid) => { if (sid === pageSessionId) resolve(); });
      send('Page.reload');
    });
    console.log('Reloaded');

    const d2 = await send('Profiler.takePreciseCoverage');
    console.log('\n=== AFTER RELOAD ===');
    for (const s of (d2.result||[])) {
      if (!s.url.includes('9001')) continue;
      console.log(`  functions: ${s.functions.length}`);
      s.functions.forEach(f => console.log(`    "${f.functionName||'(anon)'}" count=${f.ranges[0]?.count}`));
    }

    // Use browser.Browser.close() to gracefully shut down Chrome
    await browser.Browser.close().catch(() => {});
    await browser.close();
  } catch(e) {
    console.error('Error:', e.message);
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 1000);
  }
});
