// Adapted for agent-box-host Agent Substrate from agent-sandbox/agent-sandbox (Apache-2.0).
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { deleteSandbox, listSandboxes, operateSandbox } from '../lib/api/sandbox'
import CreateSandboxDialog from '../components/CreateSandboxDialog'
import SandboxActions from '../components/SandboxActions'
import BusyButton from '../components/BusyButton'
import Notifications from '../components/Notifications'
import type { Actor, AgentKind, Sandbox } from '../lib/api/types'

type SandboxSortKey = 'created-desc' | 'created-asc' | 'name-asc' | 'name-desc'
type Operation = 'resume' | 'suspend' | 'revert' | 'delete'

const refreshIntervalOptions = [2000, 5000, 10000, 30000]

function formatCreatedAt(value?: string): string {
  if (!value) {
    return '-'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString()
}

function getCreatedTimestamp(value?: string): number {
  if (!value) {
    return 0
  }

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return 0
  }

  return parsed
}

export default function SandboxesPage() {
  const navigate = useNavigate()
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([])
  const [isListLoading, setIsListLoading] = useState(false)
  const [deletingName, setDeletingName] = useState<string | null>(null)
  const [pendingOperation, setPendingOperation] = useState('')
  const [pendingIds, setPendingIds] = useState<string[]>([])
  const [confirmDelete, setConfirmDelete] = useState<{ targets: Sandbox[]; bulk: boolean } | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [bulkProgress, setBulkProgress] = useState<{ processed: number; total: number } | null>(null)
  const [pageError, setPageError] = useState('')
  const [actionError, setActionError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [created, setCreated] = useState<{ actor: Actor; kind: AgentKind }>()
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [isAutoRefresh, setIsAutoRefresh] = useState(true)
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(5000)
  const [sortKey, setSortKey] = useState<SandboxSortKey>('created-desc')
  const [filterKey, setFilterKey] = useState('')
  const [filterValue, setFilterValue] = useState('')

  const listRequest = useRef<AbortController | null>(null)
  const pageActive = useRef(true)
  const deletingNameRef = useRef<string | null>(null)
  const deleteDialog = useRef<HTMLDialogElement>(null)

  deletingNameRef.current = deletingName

  useEffect(() => {
    if (confirmDelete) {
      deleteDialog.current?.showModal()
      deleteDialog.current?.querySelector('button')?.focus()
    } else deleteDialog.current?.close()
  }, [confirmDelete])

  useEffect(() => {
    pageActive.current = true
    return () => { pageActive.current = false; listRequest.current?.abort(); listRequest.current = null }
  }, [])
  useEffect(() => { setSelectedIds([]) }, [filterKey, filterValue])

  const refreshSandboxes = useCallback(async (options?: { keepMessages?: boolean; silent?: boolean }) => {
    if (listRequest.current) {
      return
    }

    const controller = new AbortController()
    listRequest.current = controller
    if (!options?.silent) setIsListLoading(true)

    if (!options?.keepMessages) {
      setActionError('')
      setSuccessMessage('')
    }

    try {
      const list = await listSandboxes(controller.signal)
      if (controller.signal.aborted) return
      setSandboxes(list)
      setSelectedIds(previous => previous.filter(id => list.some(sandbox => sandbox.id === id)))
      setPageError('')
    } catch (error) {
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : 'Failed to load sandboxes'
      setPageError(message)
    } finally {
      if (listRequest.current === controller) {
        listRequest.current = null
        setIsListLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void refreshSandboxes()
  }, [refreshSandboxes])

  useEffect(() => {
    if (!isAutoRefresh) {
      return
    }

    const timer = window.setInterval(() => {
      if (deletingNameRef.current) {
        return
      }
      void refreshSandboxes({ keepMessages: true, silent: true })
    }, refreshIntervalMs)

    return () => {
      window.clearInterval(timer)
    }
  }, [isAutoRefresh, refreshIntervalMs, refreshSandboxes])

  const metadataFacets = useMemo(() => {
    const byKey = new Map<string, Set<string>>()
    for (const sandbox of sandboxes) {
      for (const [key, value] of Object.entries(sandbox.metadata ?? {})) {
        if (!byKey.has(key)) {
          byKey.set(key, new Set())
        }
        byKey.get(key)?.add(value)
      }
    }
    return [...byKey.entries()]
      .map(([key, values]) => [key, [...values].sort((a, b) => a.localeCompare(b))] as const)
      .sort((a, b) => a[0].localeCompare(b[0]))
  }, [sandboxes])

  const filterValues = useMemo(
    () => metadataFacets.find(([key]) => key === filterKey)?.[1] ?? [],
    [metadataFacets, filterKey],
  )

  const sortedSandboxes = useMemo(() => {
    const next = sandboxes.filter((sandbox) => {
      if (filterKey === '') {
        return true
      }
      const value = (sandbox.metadata ?? {})[filterKey]
      if (value === undefined) {
        return false
      }
      return filterValue === '' || value === filterValue
    })

    next.sort((a, b) => {
      if (sortKey === 'created-desc') {
        return getCreatedTimestamp(b.created_at) - getCreatedTimestamp(a.created_at)
      }

      if (sortKey === 'created-asc') {
        return getCreatedTimestamp(a.created_at) - getCreatedTimestamp(b.created_at)
      }

      const nameA = (a.name ?? '').toLocaleLowerCase()
      const nameB = (b.name ?? '').toLocaleLowerCase()
      if (sortKey === 'name-asc') {
        return nameA.localeCompare(nameB)
      }

      return nameB.localeCompare(nameA)
    })

    return next
  }, [sandboxes, sortKey, filterKey, filterValue])

  const selectable = sortedSandboxes.filter(sandbox => sandbox.id && sandbox.name)
  const selected = selectable.filter(sandbox => selectedIds.includes(sandbox.id!))
  const resumable = selected.filter(sandbox => sandbox.status === 'suspended')
  const suspendable = selected.filter(sandbox => sandbox.status === 'running')

  const handleDeleteClick = (sandbox: Sandbox) => {
    if (sandbox.name && sandbox.id && !deletingNameRef.current) setConfirmDelete({ targets: [sandbox], bulk: false })
  }

  const handleRefresh = async () => {
    await refreshSandboxes({ keepMessages: true })
  }

  const handleOperation = async (targets: Sandbox[], operation: Operation, bulk = false) => {
    if (deletingNameRef.current || targets.length === 0) return false
    if (targets.some(sandbox => !sandbox.name || !sandbox.id)) return false
    if (operation === 'revert' && !window.confirm('Restore the last snapshot? All later changes will be lost.')) return false
    deletingNameRef.current = targets[0].name!
    setDeletingName(targets[0].name!)
    setPendingOperation(operation)
    if (bulk) setBulkProgress({ processed: 0, total: targets.length })
    listRequest.current?.abort()
    listRequest.current = null
    setIsListLoading(false)
    setCreated(undefined)
    setActionError('')
    setSuccessMessage('')
    const succeeded: string[] = [], errors: string[] = []
    let next = 0, processed = 0
    const run = async () => {
      while (pageActive.current && next < targets.length) {
        const sandbox = targets[next++]
        setPendingIds(previous => [...previous, sandbox.id!])
        try {
          if (operation === 'delete') await deleteSandbox(sandbox.name!, sandbox.id!)
          else await operateSandbox(sandbox.name!, operation, sandbox.id!)
          succeeded.push(sandbox.id!)
          setSelectedIds(previous => previous.filter(id => id !== sandbox.id))
          setSandboxes(previous => operation === 'delete' ? previous.filter(item => item.id !== sandbox.id) : previous.map(item => item.id === sandbox.id ? { ...item, status: operation === 'suspend' ? 'suspended' : 'running', session: undefined } : item))
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Operation failed'
          errors.push(bulk ? `${sandbox.name}: ${message}` : message)
        }
        setPendingIds(previous => previous.filter(id => id !== sandbox.id))
        processed++
        if (bulk) setBulkProgress({ processed, total: targets.length })
      }
    }
    try {
      const concurrency = bulk && (operation === 'resume' || operation === 'suspend') ? 2 : 1
      await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, run))
      if (!pageActive.current) return false
      if (succeeded.length) {
        const result = operation === 'delete' ? 'deleted' : operation === 'resume' ? 'resumed' : operation === 'suspend' ? 'suspended' : 'restored'
        setSuccessMessage(bulk ? `${succeeded.length} of ${targets.length} ${targets.length === 1 ? 'sandbox' : 'sandboxes'} ${result}.` : operation === 'delete' ? `Sandbox "${targets[0].name}" deleted successfully.` : `${targets[0].name}: ${operation} completed.`)
      }
      setActionError(errors.join('\n'))
      await refreshSandboxes({ keepMessages: true })
      return errors.length === 0
    } finally {
      deletingNameRef.current = null
      setDeletingName(null)
      setPendingOperation('')
      setPendingIds([])
      setBulkProgress(null)
      setConfirmDelete(null)
    }
  }

  const handleOpen = async (sandbox: Sandbox) => {
    if (!sandbox.id || deletingNameRef.current) return
    if (sandbox.status === 'suspended' && !await handleOperation([sandbox], 'resume')) return
    navigate(`/console?uid=${encodeURIComponent(sandbox.id)}`)
  }

  const handleRefreshIntervalChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const parsed = Number.parseInt(event.target.value, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      setRefreshIntervalMs(parsed)
    }
  }

  const handleSortChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setSortKey(event.target.value as SandboxSortKey)
  }

  return (
    <>
      <header className="card border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-2xl font-semibold">Sandbox Management</h2>
              <p className="text-sm text-base-content/70">Run Codex, Pi and Devin CLI in isolated workspaces.</p>
              <p className="text-sm text-base-content/70">Suspend sandboxes before restarting workers or the host to save their state.</p>
            </div>
          </div>
        </div>
      </header>

      <Notifications items={[
        { message: pageError, onDismiss: () => setPageError('') },
        { message: actionError, onDismiss: () => setActionError('') },
        { message: successMessage, tone: 'success', onDismiss: () => setSuccessMessage(''), action: created && <button className="btn btn-sm btn-ghost" type="button" onClick={() => navigate(created.kind === 'none' ? `/terminal?sandbox=${encodeURIComponent(created.actor.metadata.name)}&uid=${encodeURIComponent(created.actor.metadata.uid || '')}` : `/console?uid=${encodeURIComponent(created.actor.metadata.uid || '')}`)}>{created.kind === 'none' ? 'Open Terminal' : 'Open Superterminal'}</button> },
      ]} />

      <section>
        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="card-title text-lg">Sandboxes</h3>
              <div className="flex flex-wrap items-center gap-2">
                <label className="label cursor-pointer gap-2 py-0">
                  <span className="label-text text-sm">Auto Refresh</span>
                  <input
                    className="toggle toggle-sm"
                    type="checkbox"
                    checked={isAutoRefresh}
                    onChange={() => {
                      setIsAutoRefresh((prev) => !prev)
                    }}
                    disabled={Boolean(deletingName)}
                  />
                </label>

                <label className="flex items-center gap-2">
                  <span className="text-sm">Interval</span>
                  <select className="select select-sm select-bordered" value={String(refreshIntervalMs)} onChange={handleRefreshIntervalChange} disabled={!isAutoRefresh || Boolean(deletingName)}>
                    {refreshIntervalOptions.map((interval) => (
                      <option key={interval} value={interval}>
                        {interval / 1000}s
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-2">
                  <span className="text-sm">Label</span>
                  <select
                    className="select select-sm select-bordered"
                    aria-label="Label"
                    value={filterKey}
                    disabled={Boolean(deletingName)}
                    onChange={(event) => {
                      setFilterKey(event.target.value)
                      setFilterValue('')
                    }}
                  >
                    <option value="">All sandboxes</option>
                    {metadataFacets.map(([key]) => (
                      <option key={key} value={key}>
                        {key}
                      </option>
                    ))}
                  </select>
                </label>

                {filterKey !== '' && (
                  <label className="flex items-center gap-2">
                    <input
                      className="input input-sm input-bordered w-52"
                      aria-label="Label value"
                      disabled={Boolean(deletingName)}
                      type="search"
                      list="sandbox-label-values"
                      placeholder={`${filterValues.length} value${filterValues.length === 1 ? '' : 's'} — type to search`}
                      value={filterValue}
                      onChange={(event) => {
                        setFilterValue(event.target.value)
                      }}
                    />
                    <datalist id="sandbox-label-values">
                      {filterValues.map((value) => (
                        <option key={value} value={value} />
                      ))}
                    </datalist>
                  </label>
                )}

                <label className="flex items-center gap-2">
                  <span className="text-sm">Sort</span>
                  <select className="select select-sm select-bordered" aria-label="Sort" value={sortKey} disabled={Boolean(deletingName)} onChange={handleSortChange}>
                    <option value="created-desc">Created (newest first)</option>
                    <option value="created-asc">Created (oldest first)</option>
                    <option value="name-asc">Name (A-Z)</option>
                    <option value="name-desc">Name (Z-A)</option>
                  </select>
                </label>

                <BusyButton className="btn-sm btn-outline" type="button" busy={isListLoading} disabled={Boolean(deletingName)} onClick={() => void handleRefresh()}>Refresh</BusyButton>
                <button
                  className="btn btn-sm btn-primary"
                  type="button"
                  disabled={Boolean(deletingName)}
                  onClick={() => {
                    setActionError('')
                    setSuccessMessage('')
                    setCreated(undefined)
                    setIsCreateModalOpen(true)
                  }}
                >
                  Create Sandbox
                </button>
              </div>
            </div>
            <div className="flex min-h-11 flex-wrap items-center gap-2" role="group" aria-label="Selected sandboxes" aria-busy={Boolean(bulkProgress)}>
              <span className="min-w-24 text-sm tabular-nums">{selected.length} selected</span>
              <BusyButton className="btn-sm btn-soft btn-primary" type="button" busy={Boolean(bulkProgress) && pendingOperation === 'resume'} disabled={Boolean(deletingName) || resumable.length === 0} title="Resume suspended sandboxes" onClick={() => void handleOperation(resumable, 'resume', true)}>Resume</BusyButton>
              <BusyButton className="btn-sm btn-soft" type="button" busy={Boolean(bulkProgress) && pendingOperation === 'suspend'} disabled={Boolean(deletingName) || suspendable.length === 0} title="Suspend running sandboxes" onClick={() => void handleOperation(suspendable, 'suspend', true)}>Suspend</BusyButton>
              <BusyButton className="btn-sm btn-soft btn-error" type="button" busy={Boolean(bulkProgress) && pendingOperation === 'delete'} disabled={Boolean(deletingName) || selected.length === 0} onClick={() => setConfirmDelete({ targets: selected, bulk: true })}>Delete…</BusyButton>
              <button className="btn btn-sm btn-ghost" type="button" disabled={Boolean(deletingName) || selected.length === 0} onClick={() => setSelectedIds([])}>Clear</button>
              <span className="min-w-32 text-xs tabular-nums text-base-content/70" role="status">{bulkProgress ? `${bulkProgress.processed} / ${bulkProgress.total} processed` : ''}</span>
            </div>
            <p className="-mt-2 text-xs text-base-content/60">Keep this page open until the actions finish.</p>

            <div className="h-[calc(100vh-22rem)] min-h-64 overflow-auto rounded-box border border-base-300">
              <table className="table table-pin-rows table-zebra">
                <thead>
                  <tr>
                    <th><label className="flex min-h-11 min-w-11 items-center justify-center"><input type="checkbox" className="checkbox checkbox-sm" aria-label="Select all visible sandboxes" checked={selectable.length > 0 && selected.length === selectable.length} ref={element => { if (element) element.indeterminate = selected.length > 0 && selected.length < selectable.length }} disabled={Boolean(deletingName) || selectable.length === 0} onChange={event => setSelectedIds(event.target.checked ? selectable.map(sandbox => sandbox.id!) : [])} /></label></th>
                    <th  style={{ width: '300px' }}>Name</th>
                    <th  style={{ width: '300px' }}>Agent</th>
                    <th>Sandbox state</th>
                    <th>Worker</th>
                    <th>Error</th>
                    <th>Created</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSandboxes.length === 0 ? (
                    <tr>
                      <td className="text-center text-base-content/70" colSpan={8}>
                        {isListLoading ? 'Loading sandboxes...' : filterKey !== '' && sandboxes.length > 0 ? 'No sandboxes match the selected label.' : 'No sandboxes found.'}
                      </td>
                    </tr>
                  ) : (
                    sortedSandboxes.map((sandbox, index) => {
                      const sandboxName = sandbox.name ?? ''
                      return (
                        <tr key={sandbox.id || sandboxName || `sandbox-${index}`} className={sandbox.id && selectedIds.includes(sandbox.id) ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-base-300'}>
                          <td><label className="flex min-h-11 min-w-11 items-center justify-center"><input type="checkbox" className="checkbox checkbox-sm" aria-label={`Select ${sandboxName}`} checked={Boolean(sandbox.id && selectedIds.includes(sandbox.id))} disabled={Boolean(deletingName) || !sandbox.name || !sandbox.id} onChange={event => {
                            const checked = event.target.checked, id = sandbox.id!
                            setSelectedIds(previous => checked ? previous.includes(id) ? previous : [...previous, id] : previous.filter(value => value !== id))
                          }} /></label></td>
                          <td className="font-medium">
                            <a className="link link-hover link-success" href={`#/console?uid=${encodeURIComponent(sandbox.id || '')}`}>
                              {sandbox.name || '-'}
                            </a>
                            <div className="text-xs text-base-content/40 font-normal">
                              {sandbox.id || '-'}
                            </div>
                            {sandbox.metadata && Object.keys(sandbox.metadata).length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {Object.entries(sandbox.metadata).map(([key, value]) => {
                                  const isActive = filterKey === key && filterValue === value
                                  return (
                                    <button
                                      key={key}
                                      style={{cursor:"pointer"}}
                                      className={`badge badge-xs  font-normal ${isActive ? 'badge-primary' : 'badge-neutral'}`}
                                      type="button"
                                      disabled={Boolean(deletingName)}
                                      title={isActive ? 'Clear filter' : `Show only ${key}=${value}`}
                                      onClick={() => {
                                        setFilterKey(isActive ? '' : key)
                                        setFilterValue(isActive ? '' : value)
                                      }}
                                    >
                                      {key}={value}
                                    </button>
                                  )
                                })}
                              </div>
                            )}
                          </td>
                          <td>{sandbox.template || '-'}
                          </td>
                          <td>
                            {sandbox.status ? (
                              <span className={`badge badge-sm ${sandbox.status === 'running' ? 'badge-success' : 'badge-warning'}`}>{sandbox.status}</span>
                            ) : (
                              '-'
                            )}
                            {sandbox.session && <div className="text-xs">Agent: {sandbox.session}</div>}
                          </td>
                          <td className="text-xs">{sandbox.worker || '—'}</td>
                          <td className="max-w-xs whitespace-pre-wrap break-words text-error">
                            {sandbox.error || '—'}
                            {!sandbox.hasSnapshot && <div className="text-xs text-warning">No saved snapshot</div>}
                          </td>
                          <td>{formatCreatedAt(sandbox.created_at)}</td>
                          <td className="text-right">
                            <SandboxActions sandbox={sandbox} disabled={Boolean(deletingName)} pendingOperation={sandbox.id && pendingIds.includes(sandbox.id) ? pendingOperation : ''} onOpen={() => void handleOpen(sandbox)} onOperation={operation => void handleOperation([sandbox], operation)} onDelete={() => handleDeleteClick(sandbox)} />
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      {isCreateModalOpen && <CreateSandboxDialog onClose={() => { setIsCreateModalOpen(false); void refreshSandboxes({ keepMessages: true }) }} onCreated={(actor, kind) => {
        setCreated({ actor, kind })
        setIsCreateModalOpen(false)
        setSuccessMessage(`Sandbox "${actor.metadata.name}" created successfully.`)
        void refreshSandboxes({ keepMessages: true })
      }} />}

      <dialog ref={deleteDialog} className="modal" aria-labelledby="delete-sandbox-title" onCancel={event => { event.preventDefault(); if (!deletingNameRef.current) setConfirmDelete(null) }}>
        <div className="modal-box">
          <h3 id="delete-sandbox-title" className="text-lg font-bold">{confirmDelete && confirmDelete.targets.length > 1 ? `Delete ${confirmDelete.targets.length} Sandboxes` : 'Delete Sandbox'}</h3>
          <p className="py-4">
            {confirmDelete && confirmDelete.targets.length > 1 ? `Permanently delete all workspace data and snapshots for these ${confirmDelete.targets.length} sandboxes?` : <>Delete all workspace data and snapshots for sandbox <span className="font-semibold">"{confirmDelete?.targets[0].name}"</span>?</>}
          </p>
          {confirmDelete && confirmDelete.targets.length > 1 && <ul className="max-h-48 overflow-auto text-sm">{confirmDelete.targets.map(sandbox => <li className="py-1 font-medium" key={sandbox.id}>{sandbox.name}</li>)}</ul>}
          {confirmDelete?.bulk && <p className="min-h-5 text-sm text-base-content/70" role="status">{bulkProgress ? `${bulkProgress.processed} / ${bulkProgress.total} processed` : ''}</p>}
          <div className="modal-action">
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => {
                if (deletingName) {
                  return
                }
                setConfirmDelete(null)
              }}
              disabled={Boolean(deletingName)}
            >
              Cancel
            </button>
            <BusyButton
              className="btn-error"
              busy={Boolean(deletingName)}
              type="button"
              disabled={Boolean(deletingName)}
              onClick={() => {
                if (confirmDelete) void handleOperation(confirmDelete.targets, 'delete', confirmDelete.bulk)
              }}
            >
              Delete
            </BusyButton>
          </div>
        </div>
        <button
          className="modal-backdrop"
          type="button"
          aria-label="Close"
          onClick={() => {
            if (deletingName) {
              return
            }
            setConfirmDelete(null)
          }}
        />
      </dialog>
    </>
  )
}
