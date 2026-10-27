import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import BusyButton from '../components/BusyButton'
import Notifications from '../components/Notifications'
import { deleteWorkerProfile, listWorkerProfiles, listWorkers, profileSummary, resizeProfile, saveWorkerProfile, type WorkerInstance, type WorkerProfile } from '../lib/api/workers'

const newProfile: WorkerProfile = { id: '', name: '', version: 0, revision: 1, cpu_milli: 8000, memory_mib: 8256, slots: 4, min_workers: 0, max_workers: 8, enabled: true, default: false, sandbox_cpu_milli: 2000, sandbox_memory_mib: 2048, reserved_cpu_milli: 0, reserved_memory_mib: 64 }
export default function WorkersPage() {
  const [enabled, setEnabled] = useState<boolean>()
  const [profiles, setProfiles] = useState<WorkerProfile[]>([])
  const [workers, setWorkers] = useState<WorkerInstance[]>([])
  const [mode, setMode] = useState('')
  const [error, setError] = useState('')
  const [edit, setEdit] = useState<WorkerProfile>()
  const [pending, setPending] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const catalog = await listWorkerProfiles(signal)
      if (signal?.aborted) return
      setEnabled(catalog.enabled)
      if (!catalog.enabled) { setError(''); return }
      const instances = await listWorkers(signal)
      if (signal?.aborted) return
      setProfiles(catalog.profiles); setWorkers(instances.workers); setMode(instances.mode)
    } catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load Workers') }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => void refresh(controller.signal), 5000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [refresh])
  useEffect(() => { if (edit) dialog.current?.showModal(); else dialog.current?.close() }, [edit])
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!edit || pending) return
    setPending(true); setError('')
    try { await saveWorkerProfile(edit); setEdit(undefined); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save profile') }
    finally { setPending(false) }
  }
  const remove = async (profile: WorkerProfile) => {
    if (!window.confirm(`Delete profile "${profile.name}"? Profiles used by sandboxes or Workers cannot be deleted.`)) return
    setPending(true); setError('')
    try { await deleteWorkerProfile(profile); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to delete profile') }
    finally { setPending(false) }
  }
  const preserveFractionalCPU = edit && edit.sandbox_cpu_milli % 1000 !== 0 && profiles.some(profile => profile.id === edit.id && profile.cpu_milli === edit.cpu_milli && profile.memory_mib === edit.memory_mib && profile.slots === edit.slots && profile.reserved_cpu_milli === edit.reserved_cpu_milli && profile.reserved_memory_mib === edit.reserved_memory_mib)
  if (enabled === false) return <section className="space-y-6"><h1 className="text-2xl font-semibold">Workers</h1><p>Worker profiles are not enabled on this Host.</p></section>
  return <section className="space-y-6">
    <header className="flex items-center justify-between gap-4"><div><h1 className="text-2xl font-semibold">Workers</h1><p className="mt-2 text-sm text-base-content/70">agent-box-host · Maximum 8 Workers · Empty Workers above the minimum stop after 5 minutes.</p></div><button className="btn btn-primary" disabled={!enabled} onClick={() => { setError(''); setEdit({ ...newProfile }) }}>New profile</button></header>
    {mode === 'quiescing' && <div role="status" className="alert">Host is saving sandboxes. New sandboxes, Resume and automatic scaling are paused.</div>}
    {!edit && <Notifications items={[{ message: error, onDismiss: () => setError('') }]} />}
    <div className="grid gap-4 xl:grid-cols-2">{profiles.map(profile => <article key={profile.id} className="rounded-box border border-base-300 bg-base-100 p-5 space-y-3">
      <h2 className="text-lg font-semibold">{profile.name} {profile.default && <span className="badge">Default</span>} {!profile.enabled && <span className="badge">Disabled for new sandboxes</span>}</h2>
      <p>{profileSummary(profile)}</p><p className="text-sm text-base-content/70">Worker budget: {profile.cpu_milli / 1000} CPU / {profile.memory_mib} MiB · Service reserve: {profile.reserved_cpu_milli / 1000} CPU / {profile.reserved_memory_mib} MiB</p>
      <p className="text-sm">{profile.min_workers}–{profile.max_workers} Workers · Up to {profile.max_workers * profile.slots} sandbox slots · Resource version {profile.revision}</p>
      <div className="flex gap-2"><button className="btn btn-sm" onClick={() => { setError(''); setEdit({ ...profile }) }}>Edit</button><button className="btn btn-sm btn-ghost" disabled={pending || profile.default} onClick={() => void remove(profile)}>Delete</button></div>
    </article>)}</div>
    <div className="rounded-box bg-base-100 p-5"><h2 className="text-lg font-semibold">Worker instances</h2><p className="my-2 text-sm text-base-content/70">CPU and RAM show allocated budgets. Actual consumption is not measured here.</p><div className="overflow-x-auto"><table className="table"><thead><tr><th>Worker</th><th>Profile / version</th><th>State</th><th>Occupied / available slots</th><th>Allocated CPU / RAM</th></tr></thead><tbody>{workers.map(worker => <tr key={worker.name}><td>{worker.name}</td><td>{worker.profile_name} / v{worker.revision}</td><td>{worker.state}</td><td>{worker.occupied} / {worker.available}</td><td>{worker.cpu_milli / 1000} CPU / {worker.memory_mib} MiB</td></tr>)}</tbody></table></div>{!workers.length && <p className="py-6 text-sm">No Workers. A Worker starts when a sandbox needs capacity.</p>}</div>
    <dialog ref={dialog} className="modal" aria-labelledby="profile-title" onCancel={event => { event.preventDefault(); if (!pending) setEdit(undefined) }}>
      {edit && <form onSubmit={event => void save(event)} className="modal-box space-y-4"><h2 id="profile-title" className="text-xl font-semibold">{edit.id ? 'Edit profile' : 'New profile'}</h2>
        <fieldset disabled={pending} className="space-y-4"><label className="flex flex-col gap-1">Name<input className="input input-bordered w-full" value={edit.name} maxLength={80} required onChange={event => setEdit({ ...edit, name: event.target.value })} /></label>
          <label className="flex flex-col gap-1 text-sm">CPU per sandbox<input className="input input-bordered w-full" type="number" step={preserveFractionalCPU ? 'any' : 1} min={preserveFractionalCPU ? 0.001 : 1} required value={edit.sandbox_cpu_milli / 1000} onChange={event => setEdit(resizeProfile(edit, { sandbox_cpu_milli: Number(event.target.value) * 1000 }))} /></label>
          <label className="flex flex-col gap-1 text-sm">RAM per sandbox (GiB)<input className="input input-bordered w-full" type="number" step={1 / 1024} min={1 / 1024} required value={edit.sandbox_memory_mib / 1024} onChange={event => setEdit(resizeProfile(edit, { sandbox_memory_mib: Number(event.target.value) * 1024 }))} /></label>
          <div className="grid grid-cols-2 gap-3">{([['slots', 'Sandbox slots per Worker', 1], ['min_workers', 'Minimum Workers', 0], ['max_workers', 'Maximum Workers', 1]] as const).map(([key, label, min]) => <label key={key} className="flex flex-col gap-1 text-sm">{label}<input className="input input-bordered w-full" type="number" step="1" min={min} max={key.includes('workers') ? 8 : undefined} required value={edit[key]} onChange={event => setEdit(key === 'slots' ? resizeProfile(edit, { slots: Number(event.target.value) }) : { ...edit, [key]: Number(event.target.value) })} /></label>)}</div>
          <p className="rounded-box bg-base-200 p-3 text-sm" aria-live="polite">{profileSummary(edit)}<br />Worker budget: {edit.cpu_milli / 1000} CPU / {edit.memory_mib} MiB.<br />Service reserve is added automatically: {edit.reserved_cpu_milli / 1000} CPU / {edit.reserved_memory_mib} MiB per Worker.<br />Maximum capacity: {edit.max_workers * edit.slots} sandbox slots, subject to the Host budget.</p>
          <label className="flex gap-2"><input type="checkbox" className="checkbox" checked={edit.enabled} onChange={event => setEdit({ ...edit, enabled: event.target.checked })} />Allow new sandboxes</label>
          <label className="flex gap-2"><input type="checkbox" className="checkbox" checked={edit.default} onChange={event => setEdit({ ...edit, default: event.target.checked })} />Default profile</label>
          <p className="text-sm text-base-content/70">Resource changes apply to new sandboxes. Existing sandboxes keep their original resource version and runtime.</p>
        </fieldset>
        {error && <p role="alert" className="text-error">{error}</p>}
        <div className="modal-action"><button type="button" className="btn btn-ghost" disabled={pending} onClick={() => setEdit(undefined)}>Cancel</button><BusyButton type="submit" className="btn-primary" busy={pending}>Save profile</BusyButton></div>
      </form>}
    </dialog>
  </section>
}
