const { app, BrowserWindow, Menu, session, shell, safeStorage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createCredentialStore } = require('./credentials.cjs');

let mainWindow;
let localServer;
let origin;
const externalOrigins = new Set(['https://github.com', 'https://docs.comfy.org', 'https://platform.comfy.org']);

async function openWindow() {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return; }
  mainWindow = new BrowserWindow({
    width: 1450, height: 980, minWidth: 900, minHeight: 700,
    title: 'Open Genjutsu', backgroundColor: '#101110', show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { if (externalOrigins.has(new URL(url).origin)) void shell.openExternal(url); } catch { /* No external navigation for invalid URLs. */ }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => { if (process.env.OPEN_GENJUTSU_HEADLESS !== '1') mainWindow.show(); });
  mainWindow.on('closed', () => { mainWindow = undefined; });
  await mainWindow.loadURL(origin);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    if (process.env.OPEN_GENJUTSU_HEADLESS === '1') app.dock?.hide();
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    const { startServer } = await import(pathToFileURL(path.join(__dirname, '..', 'dist-server', 'index.js')).href);
    localServer = await startServer({
      port: 0,
      dataDir: process.env.OPEN_GENJUTSU_DATA_DIR || path.join(app.getPath('userData'), 'desktop-workspace'),
      staticDir: path.join(__dirname, '..', 'dist'),
      cloudCredentials: createCredentialStore(safeStorage, app.getPath('userData')),
    });
    origin = `http://127.0.0.1:${localServer.port}`;
    console.log(`Open Genjutsu desktop server: ${origin}`);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Open Genjutsu', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
    ]));
    await openWindow();
  }).catch((error) => { console.error('Open Genjutsu startup failed:', error.message); app.quit(); });
  app.on('activate', () => { if (origin) void openWindow(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { void localServer?.close(); });
}
