import { request } from './http'

export type WorkerProfile = {
  id: string; name: string; version: number; revision: number; cpu_milli: number; memory_mib: number; slots: number
  min_workers: number; max_workers: number; enabled: boolean; default: boolean
  sandbox_cpu_milli: number; sandbox_memory_mib: number; reserved_cpu_milli: number; reserved_memory_mib: number
}
export type WorkerInstance = { name: string; profile_id: string; profile_name: string; revision: number; state: string; occupied: number; available: number; slots: number; cpu_milli: number; memory_mib: number }
export async function listWorkerProfiles(signal?: AbortSignal): Promise<{ enabled: boolean; profiles: WorkerProfile[]; default_id: string }> {
  return (await request('/api/worker-profiles', { signal })).json()
}
export async function listWorkers(signal?: AbortSignal): Promise<{ workers: WorkerInstance[]; mode: string; host_worker_limit: number }> {
  return (await request('/api/workers', { signal })).json()
}
export async function saveWorkerProfile(profile: WorkerProfile): Promise<void> {
  const { name, version, cpu_milli, memory_mib, slots, min_workers, max_workers, enabled, reserved_cpu_milli, reserved_memory_mib } = profile
  await request(`/api/worker-profiles${profile.id ? '/' + encodeURIComponent(profile.id) : ''}`, { method: profile.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, version, cpu_milli, memory_mib, slots, min_workers, max_workers, enabled, reserved_cpu_milli, reserved_memory_mib, default: profile.default }) })
}
export async function deleteWorkerProfile(profile: WorkerProfile): Promise<void> {
  await request('/api/worker-profiles/' + encodeURIComponent(profile.id), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: profile.version }) })
}
export function resizeProfile(profile: WorkerProfile, change: Partial<Pick<WorkerProfile, 'sandbox_cpu_milli' | 'sandbox_memory_mib' | 'slots'>>): WorkerProfile {
  const next = { ...profile, ...change }
  return { ...next, cpu_milli: next.sandbox_cpu_milli * next.slots, memory_mib: next.sandbox_memory_mib * next.slots + 64, reserved_cpu_milli: 0, reserved_memory_mib: 64 }
}
export function profileSummary(profile: Pick<WorkerProfile, 'cpu_milli' | 'memory_mib' | 'slots' | 'reserved_cpu_milli' | 'reserved_memory_mib'>): string {
  if (profile.slots < 1) return 'Choose at least one slot'
  const cpu = Math.floor((profile.cpu_milli - profile.reserved_cpu_milli) / profile.slots), memory = Math.floor((profile.memory_mib - profile.reserved_memory_mib) / profile.slots)
  if (cpu <= 0 || memory <= 0) return 'Insufficient resources after the service reserve'
  return `${cpu / 1000} CPU / ${memory} MiB per sandbox · ${profile.slots} slots per Worker`
}
