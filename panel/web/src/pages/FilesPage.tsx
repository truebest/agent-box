// Adapted for agent-box-host Agent Substrate from agent-sandbox/agent-sandbox (Apache-2.0).
import { ChangeEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import BusyButton from '../components/BusyButton'
import Notifications from '../components/Notifications'
import { deleteSandboxFile, downloadSandboxFile, listSandboxFiles, triggerBrowserDownload, uploadSandboxFile, createSandboxDirectory } from '../lib/api/files'
import { listSandboxes } from '../lib/api/sandbox'
import type { Sandbox, SandboxFileEntry } from '../lib/api/types'

function normalizePath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return '/workspace'
  }

  const value = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const segments = value.split('/').filter(Boolean)
  const normalized: string[] = []

  for (const segment of segments) {
    if (segment === '.') {
      continue
    }
    if (segment === '..') {
      normalized.pop()
      continue
    }
    normalized.push(segment)
  }

  return `/${normalized.join('/')}`.replace(/\/+/g, '/') || '/'
}

function parentPath(input: string): string {
  const current = normalizePath(input)
  if (current === '/workspace') {
    return '/workspace'
  }
  const parts = current.split('/').filter(Boolean)
  parts.pop()
  return parts.length > 0 ? `/${parts.join('/')}` : '/'
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) {
    return '-'
  }
  if (size < 1024) {
    return `${size} B`
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function toPathSegments(input: string): Array<{ label: string; path: string }> {
  const normalized = normalizePath(input)
  if (normalized === '/workspace') {
    return [{ label: 'workspace', path: '/workspace' }]
  }

  const segments = normalized.split('/').filter(Boolean).slice(1)
  const result: Array<{ label: string; path: string }> = [{ label: 'workspace', path: '/workspace' }]

  let current = '/workspace'
  for (const segment of segments) {
    current += `/${segment}`
    result.push({ label: segment, path: current })
  }

  return result
}

export default function FilesPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  const [sandboxes, setSandboxes] = useState<Sandbox[]>([])
  const [selectedSandboxName, setSelectedSandboxName] = useState('')
  const selectedSandboxUID = searchParams.get('uid') || ''
  const selectedSandboxUIDRef = useRef('')
  selectedSandboxUIDRef.current = selectedSandboxUID
  const [currentPath, setCurrentPath] = useState('/workspace')
  const [entries, setEntries] = useState<SandboxFileEntry[]>([])

  const [isSandboxesLoading, setIsSandboxesLoading] = useState(false)
  const [isFilesLoading, setIsFilesLoading] = useState(false)
  const [isUploading, setIsUploading] = useState(false)

  const [sandboxesError, setSandboxesError] = useState('')
  const [listError, setListError] = useState('')
  const [downloadError, setDownloadError] = useState('')
  const [downloadSuccess, setDownloadSuccess] = useState('')
  const [pendingDownloadEntry, setPendingDownloadEntry] = useState<SandboxFileEntry | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [deleteSuccess, setDeleteSuccess] = useState('')
  const [pendingDeleteEntry, setPendingDeleteEntry] = useState<SandboxFileEntry | null>(null)
  const [uploadError, setUploadError] = useState('')

  const selectedSandboxNameRef = useRef('')
  selectedSandboxNameRef.current = selectedSandboxName

  const currentPathRef = useRef('/workspace')
  currentPathRef.current = currentPath

  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const updateQuery = useCallback(
    (nextSandbox: string, nextPath: string, uid = selectedSandboxUID) => {
      const params = new URLSearchParams(searchParams)

      if (nextSandbox) {
        params.set('sandbox', nextSandbox)
        params.set('uid', uid)
      } else {
        params.delete('sandbox')
        params.delete('uid')
      }

      if (nextPath && nextPath !== '/') {
        params.set('path', nextPath)
      } else {
        params.delete('path')
      }

      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams, selectedSandboxUID],
  )

  const loadFiles = useCallback(async (sandboxName: string, filePath: string, options?: { silent?: boolean }) => {
    const name = sandboxName.trim()
    if (!name || !selectedSandboxUID) {
      return
    }

    const normalized = normalizePath(filePath)
    if (!options?.silent) {
      setIsFilesLoading(true)
    }

    try {
      const data = await listSandboxFiles(name, selectedSandboxUID, normalized)
      if (selectedSandboxNameRef.current !== name || selectedSandboxUIDRef.current !== selectedSandboxUID || normalizePath(currentPathRef.current) !== normalized) {
        return
      }
      setListError('')
      setEntries(Array.isArray(data.entries) ? data.entries : [])
      setCurrentPath(normalizePath(data.path || normalized))
    } catch (error) {
      if (selectedSandboxNameRef.current !== name || selectedSandboxUIDRef.current !== selectedSandboxUID || normalizePath(currentPathRef.current) !== normalized) {
        return
      }
      const message = error instanceof Error ? error.message : 'Failed to load files'
      setListError(message)
      setEntries([])
    } finally {
      if (!options?.silent) {
        setIsFilesLoading(false)
      }
    }
  }, [selectedSandboxUID])

  const refreshSandboxes = useCallback(async () => {
    setIsSandboxesLoading(true)

    try {
      const list = await listSandboxes()
      setSandboxes(list)
      setSandboxesError('')

      if (list.length === 0) {
        setSelectedSandboxName('')
        setEntries([])
        return
      }

      const fromQuery = searchParams.get('sandbox')?.trim() ?? ''
      const requested = fromQuery || selectedSandboxNameRef.current
      const nextSandbox = requested && (searchParams.get('uid') || list.some(sandbox => sandbox.name === requested)) ? requested : list[0]?.name || ''
      const uid = (nextSandbox === fromQuery && searchParams.get('uid')) || list.find(sandbox => sandbox.name === nextSandbox)?.id || ''
      const nextPath = normalizePath(searchParams.get('path') ?? currentPathRef.current)

      setSelectedSandboxName(nextSandbox)
      setCurrentPath(nextPath)
      updateQuery(nextSandbox, nextPath, uid)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load sandboxes'
      setSandboxesError(message)
      setSelectedSandboxName('')
      setEntries([])
    } finally {
      setIsSandboxesLoading(false)
    }
  }, [searchParams, updateQuery])

  useEffect(() => {
    void refreshSandboxes()
  }, [refreshSandboxes])

  useEffect(() => {
    if (!selectedSandboxName) {
      return
    }
    void loadFiles(selectedSandboxName, currentPath)
  }, [selectedSandboxName, currentPath, loadFiles])

  const handleSandboxChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextSandbox = sandboxes.find(sandbox => sandbox.id === event.target.value)?.name || ''
    const nextPath = normalizePath(currentPath)
    setSelectedSandboxName(nextSandbox)
    setEntries([])
    setPendingDownloadEntry(null)
    setPendingDeleteEntry(null)
    setDownloadError('')
    setDownloadSuccess('')
    setDeleteError('')
    setDeleteSuccess('')
    setUploadError('')
    updateQuery(nextSandbox, nextPath, sandboxes.find(sandbox => sandbox.name === nextSandbox)?.id || '')
  }

  const handlePathInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    setCurrentPath(event.target.value)
  }

  const handlePathSubmit = () => {
    const nextPath = normalizePath(currentPath)
    setCurrentPath(nextPath)
    updateQuery(selectedSandboxName, nextPath)
  }

  const handleGoParent = () => {
    const nextPath = parentPath(currentPath)
    setCurrentPath(nextPath)
    updateQuery(selectedSandboxName, nextPath)
  }

  const handleOpenEntry = (entry: SandboxFileEntry) => {
    if (!entry.isDir) {
      return
    }
    const nextPath = normalizePath(entry.path)
    setCurrentPath(nextPath)
    updateQuery(selectedSandboxName, nextPath)
  }

  const handlePathSegmentClick = (path: string) => {
    const nextPath = normalizePath(path)
    setCurrentPath(nextPath)
    updateQuery(selectedSandboxName, nextPath)
  }

  const pathSegments = toPathSegments(currentPath)

  const handleDownload = (entry: SandboxFileEntry) => {
    if (!selectedSandboxName || entry.isDir) {
      return
    }

    setPendingDownloadEntry(entry)
  }

  const handleConfirmDownload = async () => {
    if (!selectedSandboxName || !pendingDownloadEntry) {
      return
    }

    const entry = pendingDownloadEntry
    setPendingDownloadEntry(null)

    setDownloadError('')
    setDownloadSuccess(`Started downloading ${entry.name}`)
    try {
      const result = await downloadSandboxFile(selectedSandboxName, selectedSandboxUID, entry.path)
      const downloadedName = result.fileName || entry.name
      triggerBrowserDownload(downloadedName, result.blob)
    } catch (error) {
      setDownloadSuccess('')
      const message = error instanceof Error ? error.message : 'Failed to download file'
      setDownloadError(message)
    }
  }

  const handleCancelDownload = () => {
    setPendingDownloadEntry(null)
  }

  const handleDelete = (entry: SandboxFileEntry) => {
    if (!selectedSandboxName) {
      return
    }

    setPendingDeleteEntry(entry)
  }

  const handleConfirmDelete = async () => {
    if (!selectedSandboxName || !pendingDeleteEntry) {
      return
    }

    const entry = pendingDeleteEntry
    setPendingDeleteEntry(null)

    setDeleteError('')
    setDeleteSuccess('')
    try {
      await deleteSandboxFile(selectedSandboxName, selectedSandboxUID, entry.path)
      setDeleteSuccess(`Deleted ${entry.name}`)
      await loadFiles(selectedSandboxName, normalizePath(currentPath), { silent: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete file'
      setDeleteError(message)
    }
  }

  const handleCancelDelete = () => {
    setPendingDeleteEntry(null)
  }

  const isDownloadModalOpen = Boolean(pendingDownloadEntry)
  const isDeleteModalOpen = Boolean(pendingDeleteEntry)

  const handlePickUpload = () => {
    fileInputRef.current?.click()
  }

  const handleUploadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || !selectedSandboxName) {
      return
    }

    setUploadError('')
    setIsUploading(true)
    try {
      await uploadSandboxFile(selectedSandboxName, selectedSandboxUID, normalizePath(currentPath), file)
      await loadFiles(selectedSandboxName, normalizePath(currentPath), { silent: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to upload file'
      setUploadError(message)
    } finally {
      setIsUploading(false)
      event.target.value = ''
    }
  }

  const handleCreateDirectory = async () => {
    const name = window.prompt('Directory name')
    if (!name) return
    if (name === '.' || name === '..' || name.includes('/')) { setListError('Enter a single directory name'); return }
    try {
      await createSandboxDirectory(selectedSandboxName, selectedSandboxUID, `${normalizePath(currentPath)}/${name}`)
      await loadFiles(selectedSandboxName, normalizePath(currentPath))
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'Failed to create directory')
    }
  }

  return (
    <>
      <header className="card border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body gap-3">
          <div>
            <h2 className="text-2xl font-semibold">Sandbox Files</h2>
            <p className="text-sm text-base-content/70">Workspace files only. Upload limit: 64 MiB. Only empty directories can be deleted.</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              <span className="text-sm">Sandbox</span>
              <select
                className="select select-sm select-bordered"
                value={selectedSandboxUID}
                onChange={handleSandboxChange}
                disabled={isSandboxesLoading || sandboxes.length === 0}
                aria-label="Sandbox" style={{width:'min(400px, 100%)'}}
              >
                {selectedSandboxUID && !sandboxes.some(sandbox => sandbox.id === selectedSandboxUID) && <option value={selectedSandboxUID} disabled>Previous sandbox no longer exists. Select a sandbox.</option>}
                {sandboxes.length === 0 ? (
                  <option value="">No sandboxes</option>
                ) : (
                  sandboxes.map((sandbox, index) => {
                    const name = sandbox.name ?? ''
                    return (
                      <option key={name || sandbox.id || `files-sandbox-${index}`} value={sandbox.id}>
                        {name || '-'}
                      </option>
                    )
                  })
                )}
              </select>
            </label>
              <BusyButton className="btn-sm btn-outline" type="button" onClick={() => void refreshSandboxes()} busy={isSandboxesLoading}>Reload Sandboxes</BusyButton>
          </div>
        </div>
      </header>

      <Notifications items={[
        { message: sandboxesError, tone: 'error', onDismiss: () => setSandboxesError('') },
        { message: listError, tone: 'error', onDismiss: () => setListError('') },
        { message: downloadError, tone: 'error', onDismiss: () => setDownloadError('') },
        { message: downloadSuccess, tone: 'success', onDismiss: () => setDownloadSuccess('') },
        { message: deleteError, tone: 'error', onDismiss: () => setDeleteError('') },
        { message: deleteSuccess, tone: 'success', onDismiss: () => setDeleteSuccess('') },
        { message: uploadError, tone: 'error', onDismiss: () => setUploadError('') },
      ]} />

      <section>
        <div className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body gap-3">
                <div className="flex flex-wrap gap-2 " style={{marginLeft: 'auto'}}>
                    <label className="flex items-center gap-2">
                        <span className="text-sm">Path</span>
                        <input className="input input-sm input-bordered w-72" value={currentPath}
                               onChange={handlePathInputChange} aria-label="Path" placeholder="/workspace"/>
                    </label>

                    <button className="btn btn-sm btn-outline" type="button" onClick={handlePathSubmit}
                            disabled={!selectedSandboxName || isFilesLoading}>
                        Go
                    </button>

                    <button className="btn btn-sm btn-outline" type="button" onClick={handleGoParent}
                            disabled={!selectedSandboxName || isFilesLoading || normalizePath(currentPath) === '/workspace'}>
                        Up
                    </button>

                    <BusyButton className="btn-sm btn-outline" type="button" busy={isFilesLoading}
                                onClick={() => void loadFiles(selectedSandboxName, normalizePath(currentPath))}
                                disabled={!selectedSandboxName}>Refresh</BusyButton>


                    <button className="btn btn-sm btn-outline" type="button" disabled={!selectedSandboxName || isFilesLoading}
                      onClick={() => void handleCreateDirectory()}>New directory</button>
                    <input ref={fileInputRef} type="file" className="hidden" aria-label="Upload file" onChange={handleUploadFile}/>
                    <BusyButton className="btn-sm btn-primary" type="button" onClick={handlePickUpload}
                                disabled={!selectedSandboxName} busy={isUploading}>Upload File</BusyButton>
                </div>

                    <h3 className="card-title text-lg flex-wrap gap-2">
                        <span>Files -</span>
                        <span className="text-sm font-normal text-base-content/70 flex flex-wrap items-center gap-1">
                {pathSegments.map((segment, index) => (
                    <span key={`${segment.path}-${index}`} className="inline-flex items-center gap-1">
                    {index > 0 && <span className="opacity-60">/</span>}
                        <button className="btn btn-link btn-xs px-0 min-h-0 h-auto normal-case" type="button"
                                onClick={() => handlePathSegmentClick(segment.path)}>
                      {segment.label}
                    </button>
                  </span>
                ))}
              </span>
                    </h3>

                    <div className="h-[calc(100vh-25rem)] min-h-48 overflow-auto rounded-box border border-base-300">
                    {!selectedSandboxName ? (
                        <p className="p-4 text-sm text-base-content/60">Please select a sandbox.</p>
                    ) : entries.length === 0 ? (
                        <p className="p-4 text-sm text-base-content/60">No files found.</p>
                    ) : (
                            <table className="table table-sm table-pin-rows table-zebra">
                                <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Type</th>
                                    <th>Size</th>
                                    <th className="text-right">Actions</th>
                                </tr>
                                </thead>
                                <tbody>
                                {entries.map((entry) => (
                                    <tr key={`${entry.path}-${entry.isDir ? 'd' : 'f'}`}>
                                        <td>
                                            {entry.isDir ? (
                                                <button className="btn btn-link btn-xs px-0 normal-case" type="button"
                                                        onClick={() => handleOpenEntry(entry)}>
                                                    {entry.name}
                                                </button>
                                            ) : (
                                                <span>{entry.name}</span>
                                            )}
                                        </td>
                                        <td>{entry.isDir ? 'Directory' : 'File'}</td>
                                        <td>{entry.isDir ? '-' : formatFileSize(entry.size)}</td>
                                        <td className="text-right">
                                            <div className="inline-flex items-center gap-2">
                                                {!entry.isDir && (
                                                    <button className="btn btn-xs btn-outline" type="button"
                                                            onClick={() => void handleDownload(entry)}>
                                                        Download
                                                    </button>
                                                )}
                                                {(
                                                    <button className="btn btn-xs btn-error btn-outline" type="button"
                                                            onClick={() => handleDelete(entry)}>
                                                        Delete
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                                </tbody>
                            </table>
                    )}
                    </div>
            </div>
            </div>
      </section>

        <dialog className={`modal ${isDownloadModalOpen ? 'modal-open' : ''}`} open={isDownloadModalOpen}>
        <div className="modal-box">
          <h3 className="font-semibold text-lg">Confirm Download</h3>
          <p className="py-4">Download file: {pendingDownloadEntry?.name ?? ''}?</p>
          <div className="modal-action">
            <button className="btn btn-sm" type="button" onClick={handleCancelDownload}>
              Cancel
            </button>
            <button className="btn btn-sm btn-primary" type="button" onClick={() => void handleConfirmDownload()}>
              Download
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button type="button" onClick={handleCancelDownload}>close</button>
        </form>
      </dialog>

      <dialog className={`modal ${isDeleteModalOpen ? 'modal-open' : ''}`} open={isDeleteModalOpen}>
        <div className="modal-box">
          <h3 className="font-semibold text-lg">Confirm Delete</h3>
          <p className="py-4">Delete file or empty directory: {pendingDeleteEntry?.name ?? ''}?</p>
          <div className="modal-action">
            <button className="btn btn-sm" type="button" onClick={handleCancelDelete}>
              Cancel
            </button>
            <button className="btn btn-sm btn-error" type="button" onClick={() => void handleConfirmDelete()}>
              Delete
            </button>

          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button type="button" onClick={handleCancelDelete}>close</button>
        </form>
      </dialog>
    </>
  )
}
