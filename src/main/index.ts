import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'AnyRemote',
    // Dark background to avoid a white flash before the renderer paints.
    backgroundColor: '#141414',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      // Sandboxed preload scripts cannot be ES modules; context isolation
      // stays enabled (default), which is the security boundary that matters.
      sandbox: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    // Dev server (electron-vite dev).
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

registerIpcHandlers()

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    // macOS: re-create the window when the dock icon is clicked.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
