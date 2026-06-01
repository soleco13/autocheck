import React from 'react'
import ReactDOM from 'react-dom/client'

// Global error handlers — catch unhandled promise rejections and JS errors
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason)
  // Don't log expected network timeouts or cancelled requests
  if (!msg.includes('timeout') && !msg.includes('canceled')) {
    console.error('[UnhandledRejection]', msg)
  }
})
window.onerror = (msg, src, line) => {
  console.error('[GlobalError]', msg, src ? `${src}:${line}` : '')
  return false
}
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'
import 'katex/dist/katex.min.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // Data stays fresh for 5 minutes — no refetch on every navigation
      staleTime: 5 * 60_000,
      // Keep cached data in memory for 30 minutes after component unmounts
      gcTime: 30 * 60_000,
      // Don't refetch just because the user switched browser tabs
      refetchOnWindowFocus: false,
      // Don't refetch on component remount if data is still fresh
      refetchOnMount: true,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
