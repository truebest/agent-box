// Adapted for Substrate/ttyd from agent-sandbox/agent-sandbox (Apache-2.0).
import { ChangeEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import BusyButton from '../components/BusyButton'
import Notifications from '../components/Notifications'
import { listSandboxes } from '../lib/api/sandbox'
import { createSandboxTerminalSession } from '../lib/api/terminal'
import type {
  Sandbox,
  SandboxTerminalWSServerMessage,
  TerminalConnectionState,
} from '../lib/api/types'

function isServerMessage(value: unknown): value is SandboxTerminalWSServerMessage {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>
  return typeof candidate.type === 'string'
}

function getTerminalStatusLabel(state: TerminalConnectionState) {
  if (state === 'connecting') {
    return 'Connecting'
  }
  if (state === 'connected') {
    return 'Connected'
  }
  return 'Disconnected'
}

export default function TerminalPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([])
  const [selectedSandboxName, setSelectedSandboxName] = useState('')
  const selectedSandboxUID = searchParams.get('uid') || ''
  const selectedSandboxUIDRef = useRef('')
  selectedSandboxUIDRef.current = selectedSandboxUID
  const [isSandboxesLoading, setIsSandboxesLoading] = useState(false)
  const [sandboxesError, setSandboxesError] = useState('')
  const [terminalError, setTerminalError] = useState('')
  const [connectionState, setConnectionState] = useState<TerminalConnectionState>('disconnected')

  const selectedSandboxNameRef = useRef('')
  selectedSandboxNameRef.current = selectedSandboxName

  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const socketRef = useRef<ReturnType<typeof createSandboxTerminalSession> | null>(null)
  const connectionStateRef = useRef<TerminalConnectionState>('disconnected')
  connectionStateRef.current = connectionState

  const sendResize = useCallback(() => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    const socket = socketRef.current
    if (!terminal || !fitAddon || !socket) {
      return
    }

    fitAddon.fit()
    socket.send({
      type: 'resize',
      cols: terminal.cols,
      rows: terminal.rows,
    })
  }, [])

  const disconnectTerminal = useCallback(() => {
    const socket = socketRef.current
    socketRef.current = null
    if (socket) {
      socket.send({ type: 'close' })
      socket.close()
    }
    setConnectionState('disconnected')
  }, [])

  const connectTerminal = useCallback(
    (sandboxName: string) => {
      const name = sandboxName.trim()
      if (!name || !selectedSandboxUID) {
        return
      }

      disconnectTerminal()
      setTerminalError('')
      setConnectionState('connecting')

      const terminal = terminalRef.current
      const fitAddon = fitAddonRef.current
      if (!terminal || !fitAddon) {
        setTerminalError('Terminal is not ready.')
        setConnectionState('disconnected')
        return
      }

      terminal.clear()
      fitAddon.fit()

      const session = createSandboxTerminalSession(name, selectedSandboxUID, (event) => {
        if (selectedSandboxNameRef.current !== name || selectedSandboxUIDRef.current !== selectedSandboxUID || socketRef.current !== session) {
          return
        }

        if (event.type === 'open') {
          setConnectionState('connected')
          session.send({ type: 'init', cols: terminal.cols, rows: terminal.rows })
          return
        }

        if (event.type === 'error') {
          setTerminalError(event.message)
          return
        }

        if (event.type === 'close') {
          setConnectionState('disconnected')
          return
        }

        if (!isServerMessage(event.message)) {
          setTerminalError('Unexpected terminal message.')
          return
        }

        const payload = event.message
        if (payload.type === 'output') {
          if (payload.data) {
            terminal.write(payload.data)
          }
          return
        }

        if (payload.type === 'ready') {
          if (payload.data) {
            terminal.writeln(`\r\n[${payload.data}]\r`)
          }
          return
        }

        if (payload.type === 'error') {
          setTerminalError(payload.data || 'Terminal session error.')
          return
        }

        if (payload.type === 'exit') {
          const code = typeof payload.code === 'number' ? payload.code : 0
          terminal.writeln(`\r\n[session exited: ${code}]\r`)
          return
        }

        if (payload.type === 'closed') {
          setConnectionState('disconnected')
        }
      })

      socketRef.current = session
    },
    [disconnectTerminal, selectedSandboxUID],
  )

  const refreshSandboxes = useCallback(async () => {
    setIsSandboxesLoading(true)

    try {
      const list = await listSandboxes()
      setSandboxes(list)
      setSandboxesError('')

      if (list.length === 0) {
        setSelectedSandboxName('')
        disconnectTerminal()
        return
      }

      const fromQuery = searchParams.get('sandbox')?.trim() ?? ''
      const requested = fromQuery || selectedSandboxNameRef.current
      const nextSelected = requested && (searchParams.get('uid') || list.some(sandbox => sandbox.name === requested)) ? requested : list[0]?.name || ''
      const uid = (nextSelected === fromQuery && searchParams.get('uid')) || list.find(sandbox => sandbox.name === nextSelected)?.id || ''

      setSelectedSandboxName(nextSelected)

      if (nextSelected) {
        const nextParams = new URLSearchParams(searchParams)
        nextParams.set('sandbox', nextSelected)
        nextParams.set('uid', uid)
        setSearchParams(nextParams, { replace: true })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load sandboxes'
      setSandboxesError(message)
      setSelectedSandboxName('')
      disconnectTerminal()
    } finally {
      setIsSandboxesLoading(false)
    }
  }, [disconnectTerminal, searchParams, setSearchParams])

  useEffect(() => {
    void refreshSandboxes()
  }, [refreshSandboxes])

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
      allowTransparency: true,
    })
    const fitAddon = new FitAddon()

    terminal.loadAddon(fitAddon)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    if (containerRef.current) {
      terminal.open(containerRef.current)
      fitAddon.fit()
      terminal.writeln('Welcome to Sandbox Terminal')
    }

    const dataDisposable = terminal.onData((data) => {
      const socket = socketRef.current
      if (!socket || connectionStateRef.current !== 'connected') {
        return
      }
      socket.send({ type: 'input', data })
    })

    const observer = new ResizeObserver(() => {
      sendResize()
    })

    if (containerRef.current) {
      observer.observe(containerRef.current)
    }

    return () => {
      observer.disconnect()
      dataDisposable.dispose()
      disconnectTerminal()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [disconnectTerminal, sendResize])

  useEffect(() => {
    if (!selectedSandboxName) {
      disconnectTerminal()
      return
    }

    connectTerminal(selectedSandboxName)
  }, [connectTerminal, disconnectTerminal, selectedSandboxName])

  const handleSandboxChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = sandboxes.find(sandbox => sandbox.id === event.target.value)?.name || ''
    setSelectedSandboxName(next)
    setTerminalError('')

    const nextParams = new URLSearchParams(searchParams)
    if (next) {
      nextParams.set('sandbox', next)
      nextParams.set('uid', sandboxes.find(sandbox => sandbox.name === next)?.id || '')
    } else {
      nextParams.delete('sandbox')
      nextParams.delete('uid')
    }
    setSearchParams(nextParams, { replace: true })
  }

  return (
    <>
      <header className="card border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body gap-3">
          <div>
            <h2 className="text-2xl font-semibold">Sandbox Terminal</h2>
            <p className="text-sm text-base-content/70">Open a shell in the shared workspace. Run herdr to attach to a persistent terminal. Reconnect after resuming a sandbox.</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              <span className="text-sm">Sandbox</span>
              <select
                className="select select-sm select-bordered"
                value={selectedSandboxUID}
                onChange={handleSandboxChange}
                aria-label="Sandbox" style={{width:'min(400px, 100%)'}}
                disabled={isSandboxesLoading || sandboxes.length === 0}
              >
                {selectedSandboxUID && !sandboxes.some(sandbox => sandbox.id === selectedSandboxUID) && <option value={selectedSandboxUID} disabled>Previous sandbox no longer exists. Select a sandbox.</option>}
                {sandboxes.length === 0 ? (
                  <option value="">No sandboxes</option>
                ) : (
                  sandboxes.map((sandbox, index) => {
                    const name = sandbox.name ?? ''
                    return (
                      <option key={name || sandbox.id || `terminal-sandbox-${index}`} value={sandbox.id}>
                        {name || '-'}
                      </option>
                    )
                  })
                )}
              </select>
            </label>

            <BusyButton className="btn-sm btn-outline" type="button" onClick={() => void refreshSandboxes()} busy={isSandboxesLoading}>Reload Sandboxes</BusyButton>

            <button
              className="btn btn-sm btn-primary"
              type="button"
              onClick={() => connectTerminal(selectedSandboxName)}
              disabled={!selectedSandboxName || connectionState === 'connecting'}
            >
              Connect
            </button>

            <button className="btn btn-sm btn-outline" type="button" onClick={disconnectTerminal} disabled={connectionState === 'disconnected'}>
              Disconnect
            </button>

            <span
              className={`badge badge-sm min-w-28 ${
                connectionState === 'connected' ? 'badge-success' : connectionState === 'connecting' ? 'badge-warning' : 'badge-ghost'
              }`}
            >
              {getTerminalStatusLabel(connectionState)}
            </span>
          </div>
        </div>
      </header>

      <Notifications items={[
        { message: sandboxesError, onDismiss: () => setSandboxesError('') },
        { message: terminalError, onDismiss: () => setTerminalError('') },
      ]} />

      <section>
        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-3">
            <h3 className="card-title text-lg">Terminal -  <span className="text-sm text-base-content/70">{selectedSandboxName}</span></h3>
            <div className="mockup-code w-full">
              <div className="h-[calc(100vh-380px)] min-h-80">
                <div id="terminal" ref={containerRef} className="h-full w-full pl-2" />
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}
