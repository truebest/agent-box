// Adapted from Agent-Sandbox's terminal client to ttyd 1.7.7's binary protocol.
import { agentRuntimePath } from './sandbox'
import type { SandboxTerminalWSClientMessage, TerminalSessionEvent } from './types'
import { authRequired, readSession } from '../auth'

export function createSandboxTerminalSession(name: string, uid: string, onEvent: (event: TerminalSessionEvent) => void) {
  const url = new URL(agentRuntimePath(name, uid, 'terminal/ws'), window.location.origin)
  url.protocol = 'wss:'
  const ws = new WebSocket(url, ['tty'])
  const encoder = new TextEncoder()
  ws.binaryType = 'arraybuffer'
  ws.addEventListener('open', () => onEvent({ type: 'open' }))
  ws.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
    const data = new Uint8Array(event.data)
    if (data[0] === 48) onEvent({ type: 'message', message: { type: 'output', data: data.subarray(1) } })
  })
  ws.addEventListener('error', () => onEvent({ type: 'error', message: 'Terminal connection failed. Check the agent state, then reconnect.' }))
  ws.addEventListener('close', () => {
    onEvent({ type: 'close' })
    void readSession().then(session => { if (!session.authenticated) authRequired() }).catch(() => {})
  })
  return {
    send(message: SandboxTerminalWSClientMessage) {
      if (message.type === 'close') { ws.close(); return }
      if (ws.readyState !== WebSocket.OPEN) return
      if (message.type === 'init') ws.send(encoder.encode(JSON.stringify({ AuthToken: '', columns: message.cols, rows: message.rows })))
      else if (message.type === 'resize') ws.send(encoder.encode('1' + JSON.stringify({ columns: message.cols, rows: message.rows })))
      else ws.send(encoder.encode('0' + message.data))
    },
    close() { ws.close() },
  }
}
