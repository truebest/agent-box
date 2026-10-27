export type Sandbox = {
  name?: string
  template?: string
  status?: string
  id?: string
  created_at?: string
  metadata?: Record<string, string>
  worker?: string
  error?: string
  session?: string
  primaryReady?: boolean
  hasSnapshot: boolean
}
export type AgentKind = 'codex' | 'pi' | 'devin' | 'none'
export type CreateSandboxRequest = { name?: string; profile_id?: string; kind: AgentKind; model?: string; cwd?: string; prompt?: string }
export type CreateEvent = {
  type: 'stage' | 'complete' | 'error'; stage?: 'sandbox' | 'agent' | 'prompt'; status?: 'running' | 'done' | 'failed'
  name: string; uid?: string; actor?: Actor; error?: string; prompt_delivery?: string
}
export type Actor = {
  metadata: { name: string; uid?: string; createTime?: string; labels?: Record<string, string> }
  actorTemplate?: { name: string }
  status?: {
    state?: string
    workerAssignment?: { worker?: { name: string }; workerPod?: string }
    crash?: { message?: string }
    snapshots?: { durableSnapshot?: { status?: string } }[]
  }
}
export type SandboxFileEntry = { name: string; path: string; isDir: boolean; size: number }
export type SandboxFilesListData = { path: string; entries: SandboxFileEntry[] }
export type SandboxFileDownloadResult = { blob: Blob; fileName: string }

export type SandboxTerminalWSClientMessage =
  | { type: 'init'; cols: number; rows: number }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'input'; data: string }
  | { type: 'close' }
export type SandboxTerminalWSServerMessage =
  | { type: 'output'; data: Uint8Array }
  | { type: 'ready' | 'error' | 'exit' | 'closed'; data?: string; code?: number }
export type TerminalConnectionState = 'disconnected' | 'connecting' | 'connected'
export type TerminalSessionEvent =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'error'; message: string }
  | { type: 'message'; message: SandboxTerminalWSServerMessage }
