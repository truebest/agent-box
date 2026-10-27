import { RouterProvider } from 'react-router-dom'

import { appRouter } from './router'
import AuthGate from './components/AuthGate'

export default function App() {
  return <AuthGate><RouterProvider router={appRouter} /></AuthGate>
}
