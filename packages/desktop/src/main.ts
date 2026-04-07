import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from 'electron';
import * as path from 'path';

// ── MUST run before any Electron subsystem initializes ────────
// Move ALL Electron storage off OneDrive to avoid EPERM / cache lock errors
const LOCAL_DATA = path.join(
  process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'),
  'Organism',
);
app.setPath('userData', LOCAL_DATA);
app.setPath('sessionData', path.join(LOCAL_DATA, 'session'));
app.setPath('cache', path.join(LOCAL_DATA, 'cache'));
app.setPath('crashDumps', path.join(LOCAL_DATA, 'crashDumps'));
app.setPath('temp', path.join(LOCAL_DATA, 'temp'));

// Suppress GPU shader / disk-cache errors on OneDrive-synced drives
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disk-cache-dir', path.join(LOCAL_DATA, 'disk-cache'));

import Store from 'electron-store';

const DASHBOARD_URL = 'https://organism-hq.vercel.app';

const store = new Store({
  defaults: {
    windowBounds: { x: undefined as number | undefined, y: undefined as number | undefined, width: 1200, height: 800 },
    autoStart: false,
  },
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

function createWindow(): void {
  const bounds = store.get('windowBounds') as { x?: number; y?: number; width: number; height: number };
  mainWindow = new BrowserWindow({
    title: 'Organism',
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadURL(DASHBOARD_URL);
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  const saveBounds = () => {
    if (mainWindow && !mainWindow.isMinimized() && !mainWindow.isMaximized()) {
      store.set('windowBounds', mainWindow.getBounds());
    }
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray(): void {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  let trayIcon: Electron.NativeImage;
  try {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Organism');

  const updateMenu = () => {
    const autoStart = store.get('autoStart') as boolean;
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show / Hide',
        click: () => {
          if (mainWindow?.isVisible()) mainWindow.hide();
          else { mainWindow?.show(); mainWindow?.focus(); }
        },
      },
      { type: 'separator' },
      {
        label: 'Refresh',
        click: () => { mainWindow?.webContents.reload(); },
      },
      { type: 'separator' },
      {
        label: 'Auto-start',
        type: 'checkbox',
        checked: autoStart,
        click: () => {
          const next = !store.get('autoStart');
          store.set('autoStart', next);
          app.setLoginItemSettings({ openAtLogin: next });
          updateMenu();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => { isQuitting = true; app.quit(); },
      },
    ]);
    tray?.setContextMenu(contextMenu);
  };

  updateMenu();
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', () => { /* minimize to tray, don't quit */ });

app.on('activate', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  else createWindow();
});

app.on('before-quit', () => { isQuitting = true; });
