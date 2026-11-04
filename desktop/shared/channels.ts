// 固定 IPC 通道清单；不把 ipcRenderer 本身交给页面。
// 制作人：Moriarty_Dox
export const CHANNELS = Object.freeze({
  snapshot: 'dcode:connection:snapshot',
  chooseWorkspace: 'dcode:workspace:choose',
  reconnect: 'dcode:connection:reconnect',
  prompt: 'dcode:turn:prompt',
  cancel: 'dcode:turn:cancel',
  permission: 'dcode:permission:respond',
  event: 'dcode:event',
})
