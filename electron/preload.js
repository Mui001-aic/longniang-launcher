// 给控制面板页面用的一点点桥：知道自己在 Electron 里，并且能开「游戏窗口」。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('longniang', {
  shell: 'electron',
  openGame: () => ipcRenderer.invoke('open-game'),
  openPath: (target) => ipcRenderer.invoke('open-path', target),
  pickFile: (options) => ipcRenderer.invoke('pick-file', options),
  minimize: () => ipcRenderer.invoke('win-minimize'),
  maximize: () => ipcRenderer.invoke('win-maximize'),
  close: () => ipcRenderer.invoke('win-close'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
});
