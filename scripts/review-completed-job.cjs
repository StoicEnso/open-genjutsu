/* Read-only UI regression for a completed local job. Never requests generation. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.OPEN_GENJUTSU_QA_BASE_URL || 'http://127.0.0.1:4317';
const id = process.env.OPEN_GENJUTSU_QA_JOB_ID;
const directory = process.env.OPEN_GENJUTSU_QA_DIR;
if (!id || !directory || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Set a local QA URL, a completed job ID, and a dated QA output directory.');
let window;
async function waitFor(expression) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${expression}`);
}
app.whenReady().then(async () => {
  app.dock?.hide();
  const job = await (await fetch(`${base}/api/jobs/${encodeURIComponent(id)}`)).json();
  if (job.status !== 'succeeded') throw new Error('This check only reads an already completed job.');
  window = new BrowserWindow({ show: false, width: 1450, height: 980, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  // Catch accidental generation or rerun requests in this read-only review.
  window.webContents.session.webRequest.onBeforeRequest({ urls: [`${base}/api/jobs*`] }, (details, callback) => callback({ cancel: details.method === 'POST' && !details.url.endsWith('/manifest') }));
  await window.loadURL(base);
  await waitFor(`document.querySelector('.rail button') && document.querySelector('#workflow')?.options.length >= 2`);
  await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.rail button')).find(button=>button.textContent.startsWith('Library')).click()`);
  await waitFor(`document.querySelector(${JSON.stringify(`[data-job-id="${id}"]`)})`);
  await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(`[data-job-id="${id}"]`)}).click()`);
  await waitFor('document.querySelectorAll(".comparison-videos video").length===2 && Array.from(document.querySelectorAll(".comparison-videos video")).every(video=>video.readyState>=2)');
  if (!await window.webContents.executeJavaScript('!!document.querySelector(".saved-recipe")')) throw new Error('Immutable recipe state was not restored.');
  const playback = await window.webContents.executeJavaScript(`(async()=>{
    document.querySelector('.player-controls button').click();
    await new Promise(resolve=>setTimeout(resolve,100));
    Array.from(document.querySelectorAll('.compare-options button')).find(button=>button.textContent==='Wipe').click();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    return {label:document.querySelector('.player-controls button').getAttribute('aria-label'),paused:Array.from(document.querySelectorAll('.comparison-videos video')).map(video=>video.paused)};
  })()`, true);
  if (playback.label !== 'Pause comparison' || playback.paused.some(Boolean)) throw new Error(`Playback changed when switching layout: ${JSON.stringify(playback)}`);
  const divider = await window.webContents.executeJavaScript("document.querySelector('.wipe-line').getBoundingClientRect().width");
  if (divider > 2) throw new Error(`Comparison divider obscures the result: ${divider}px`);
  await new Promise(resolve => setTimeout(resolve, 450));
  await fs.writeFile(path.join(directory, '2026-10-21-completed-job-Codex.png'), (await window.webContents.capturePage()).toPNG());
  const exports = await window.webContents.executeJavaScript('Array.from(document.querySelectorAll(".export-actions a")).map(link=>({label:link.textContent,url:link.getAttribute("href")}))');
  if (exports.length < 4) throw new Error('Project, graph, receipt and video exports are missing.');
  await fs.writeFile(path.join(directory, '2026-10-21-completed-job-ui-checks-Codex.json'), JSON.stringify({ passed: true, jobId: id, source: 'Actual completed local diffusion job; no new generation requested.', playback, exports, checks: ['library-reopen','immutable-recipe-banner','two-real-videos-loaded','playback-preserved-on-layout-switch','wipe-divider-does-not-obscure-result','project-graph-receipt-video-export-links'] }, null, 2));
  console.log('Completed-job UI review passed; no generation requested.');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { window?.destroy(); app.exit(process.exitCode || 0); });
