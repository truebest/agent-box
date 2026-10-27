import { request } from './http'
import type { Actor, CreateSandboxRequest, CreateEvent, Sandbox } from './types'

export const agentPath = (name: string) => `/api/agents/${encodeURIComponent(name)}`
export function agentRuntimePath(name: string, uid: string, operation: string) {
  if (!uid) throw new Error('Sandbox UID is unavailable. Reload sandboxes before continuing.')
  return `${agentPath(name)}/${operation}?${new URLSearchParams({ uid })}`
}

export async function listSandboxes(signal?: AbortSignal): Promise<Sandbox[]> {
  const data: { actors?: Actor[] } = await (await request('/api/agents', { signal })).json()
  return Promise.all((data.actors || []).map(async (actor) => {
    let session: string | undefined
    let template = actor.actorTemplate?.name?.includes('sandbox-v1') ? '—' : actor.actorTemplate?.name
    let primaryReady: boolean | undefined
    if (actor.status?.state === 'ACTOR_STATE_RUNNING') {
      try {
        const timeout = AbortSignal.timeout(3000)
        const state = await (await request(agentRuntimePath(actor.metadata.name, actor.metadata.uid || '', 'session'), { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })).json()
        primaryReady = state.ready
        if (state.kind === 'none') {
          const agents: { agent: string }[] = state.agents || []
          session = agents.length ? `${agents.length} running` : 'No agent'
          template = agents.length ? [...new Set(agents.map(agent => agent.agent))].join(', ') : 'No agent'
        } else {
          if (state.kind) template = state.kind
          session = state.ready ? state.runner.agent_status : 'Open Superterminal: agent needs attention'
        }
      } catch { session = 'Session unavailable; open Superterminal' }
    }
    return {
      session,
      primaryReady,
      name: actor.metadata.name,
      id: actor.metadata.uid,
      template: template === 'none' ? 'No agent' : template,
      status: (actor.status?.state || 'UNKNOWN').replace(/^ACTOR_STATE_/, '').toLowerCase(),
      created_at: actor.metadata.createTime,
      metadata: actor.metadata.labels,
      worker: actor.status?.workerAssignment?.worker?.name || actor.status?.workerAssignment?.workerPod,
      error: actor.status?.crash?.message,
      hasSnapshot: actor.status?.snapshots?.some((snapshot) => snapshot.durableSnapshot?.status === 'SNAPSHOT_STORAGE_STATUS_COMPLETED') || false,
    }
  }))
}
export class CreateSandboxError extends Error {
  constructor(message: string, public actor?: Actor, public uncertain = false) { super(message) }
}

export async function createSandbox(payload: CreateSandboxRequest, onEvent: (event: CreateEvent) => void, signal: AbortSignal): Promise<Actor> {
  let actor: Actor | undefined
  try {
    const response = await request('/api/agents?stream=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal })
    if (!response.body) throw new CreateSandboxError('Creation status is unavailable. Check the sandbox before creating again.', undefined, true)
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        const event = JSON.parse(line) as CreateEvent
        if (event.actor) actor = event.actor
        else if (event.uid) actor = { metadata: { name: event.name, uid: event.uid } }
        onEvent(event)
        if (event.type === 'error') throw new CreateSandboxError(event.error || 'Creation failed', actor, event.prompt_delivery === 'uncertain')
        if (event.type === 'complete' && event.actor) return event.actor
      }
      if (done) throw new CreateSandboxError('The connection was interrupted. Creation may still be running. Check its status before creating again.', actor, true)
    }
  } catch (error) {
    if (error instanceof CreateSandboxError) throw error
    if (error instanceof TypeError || error instanceof SyntaxError || signal.aborted) throw new CreateSandboxError('Creation status is uncertain. Check the sandbox before creating again.', actor, true)
    throw error
  }
}
export async function deleteSandbox(name: string, uid: string): Promise<void> {
  await (await request(`${agentPath(name)}?${new URLSearchParams({ uid })}`, { method: 'DELETE', operation: true })).json()
}
export async function operateSandbox(name: string, operation: 'suspend' | 'resume' | 'revert', uid: string): Promise<void> {
  await (await request(`${agentPath(name)}/${operation}?${new URLSearchParams({ uid })}`, { method: 'POST', operation: true })).json()
}
