/* Exercise our own hidden Electron renderer; never attaches to the owner's browser. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const exec = promisify(execFile);
let server, window, directory;
const output = process.env.OPEN_GENJUTSU_QA_DIR;
if (!output) throw new Error('Set OPEN_GENJUTSU_QA_DIR to a dated local artifact directory.');

async function waitFor(expression, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}
async function screenshot(name) {
  await new Promise(resolve => setTimeout(resolve, 300));
  const image = await window.webContents.capturePage();
  await fs.writeFile(path.join(output, name), image.toPNG());
}

app.whenReady().then(async () => {
  app.dock?.hide();
  await fs.mkdir(output, { recursive: true });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'open-genjutsu-desktop-qa-'));
  const { startServer } = await import(pathToFileURL(path.join(__dirname, '..', 'dist-server', 'index.js')).href);
  server = await startServer({ port: 0, dataDir: path.join(directory, 'data'), staticDir: path.join(__dirname, '..', 'dist') });
  window = new BrowserWindow({ show: false, width: 1450, height: 980, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const rendererErrors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
  await window.loadURL(`http://127.0.0.1:${server.port}`);
  await waitFor('document.querySelector("#workflow")?.options.length >= 2');
  await screenshot('2026-10-23-studio-desktop-Codex.png');
  await window.webContents.executeJavaScript('document.querySelector(".engine-pill").click()');
  await waitFor('document.querySelector("dialog")?.open');
  await screenshot('2026-10-23-engine-dialog-Codex.png');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor('!document.querySelector("dialog")');

  const binary = process.env.OPEN_GENJUTSU_FFMPEG || '/opt/homebrew/bin/ffmpeg';
  const clip = path.join(directory, 'pipeline-fixture.mp4');
  const reference = path.join(directory, 'reference-fixture.png');
  await exec(binary, ['-nostdin','-y','-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=24','-frames:v','17','-pix_fmt','yuv420p',clip]);
  await exec(binary, ['-nostdin','-y','-v','error','-f','lavfi','-i','color=c=0x709cde:size=256x256','-frames:v','1',reference]);
  for (const [filename, name, type, selector] of [[clip,'pipeline-fixture.mp4','video/mp4','.upload-stage input[type=file]'],[reference,'reference-fixture.png','image/png','.asset-input input[accept^="image/"]']]) {
    const bytes = [...await fs.readFile(filename)];
    await window.webContents.executeJavaScript(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); if(!input)throw Error('Missing upload input'); const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(${JSON.stringify(bytes)})],${JSON.stringify(name)},{type:${JSON.stringify(type)}}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await waitFor(`document.body.textContent.includes(${JSON.stringify(name)})`);
  }
  await screenshot('2026-10-23-uploaded-fixtures-Codex.png');
  const failures = await window.webContents.executeJavaScript('Array.from(document.querySelectorAll("[role=alert]")).map(x=>x.textContent)');
  if (failures.length) throw new Error(`Upload flow errors: ${failures.join('; ')}`);

  await window.webContents.executeJavaScript('Array.from(document.querySelectorAll(".rail button")).find(x=>x.textContent==="Workflows").click()');
  await waitFor('document.querySelector(".workflow-card")');
  await screenshot('2026-10-23-workflow-library-Codex.png');
  await window.webContents.executeJavaScript('document.querySelector(".workflow-card .quiet-button").click()');
  await waitFor('document.querySelector("dialog")?.open');
  if (!await window.webContents.executeJavaScript('document.querySelector(".graph-code").textContent.includes("class_type")')) throw new Error('Workflow inspector did not show the real graph.');
  await window.webContents.executeJavaScript('document.querySelector("dialog .icon-button").click()');
  await window.webContents.executeJavaScript('Array.from(document.querySelectorAll(".rail button")).find(x=>x.textContent==="Library").click()');
  await waitFor('document.querySelector(".empty-state")');
  await screenshot('2026-10-23-empty-library-Codex.png');

  window.setSize(390, 844);
  await window.webContents.executeJavaScript('Array.from(document.querySelectorAll(".rail button")).find(x=>x.textContent==="Studio").click()');
  await waitFor('document.querySelector(".studio-layout")');
  const responsive = await window.webContents.executeJavaScript('({viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,inspector:!!document.querySelector(".inspector"),sourceLoaded:!!document.querySelector(".source-player")})');
  if (responsive.documentWidth > responsive.viewport) throw new Error(`Horizontal overflow: ${JSON.stringify(responsive)}`);
  await screenshot('2026-10-23-studio-mobile-Codex.png');
  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join('; ')}`);
  await fs.writeFile(path.join(output, '2026-10-23-desktop-ui-checks-Codex.json'), JSON.stringify({ passed: true, checks: ['built-frontend-load','engine-dialog','escape-dismissal','real-video-upload','real-image-upload','workflow-library','actual-graph-inspection','empty-job-library','390px-no-horizontal-overflow'], responsive, rendererErrors, generation: 'None. Inputs are labelled procedural transport fixtures.', browser: 'Isolated hidden Electron application renderer; owner Chrome untouched.' }, null, 2));
  console.log('Desktop UI checks passed. No generation was requested.');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  window?.destroy(); await server?.close(); if (directory) await fs.rm(directory, { recursive: true, force: true }); app.exit(process.exitCode || 0);
});
