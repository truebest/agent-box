// Adapted from agent-sandbox/agent-sandbox hash router (Apache-2.0). Go enforces API authentication.
import { Navigate, createHashRouter } from 'react-router-dom'
import AppShellLayout from '../layouts/AppShellLayout'
import SandboxesPage from '../pages/SandboxesPage'
import FilesPage from '../pages/FilesPage'
import TerminalPage from '../pages/TerminalPage'
import TasksPage from '../pages/TasksPage'
import ConsolePage from '../pages/ConsolePage'
import WorkersPage from '../pages/WorkersPage'
export const appRouter = createHashRouter([{
  path: '/', element: <AppShellLayout />, children: [
    { index: true, element: <Navigate to="sandboxes" replace /> },
    { path: 'sandboxes', element: <SandboxesPage /> },
    { path: 'workers', element: <WorkersPage /> },
    { path: 'files', element: <FilesPage /> },
    { path: 'terminal', element: <TerminalPage /> },
    { path: 'tasks', element: <TasksPage /> },
    { path: 'console', element: <ConsolePage /> },
    { path: '*', element: <Navigate to="/sandboxes" replace /> },
  ],
}])
