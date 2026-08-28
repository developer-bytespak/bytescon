import { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  message: string
}

const CHUNK_RELOAD_FLAG = 'chunk-reload-attempted'

/** True when the error looks like a stale Vite chunk after a deploy. */
function isStaleChunkError(error: Error): boolean {
  const msg = error.message ?? ''
  return (
    msg.includes('Failed to fetch dynamically imported module') ||
    msg.includes('Importing a module script failed') ||
    error.name === 'ChunkLoadError'
  )
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Layer-1 recovery from stale chunks after a deploy: when the browser
    // has a cached index.html that references hashed asset files which no
    // longer exist on the server, the dynamic import for any lazy()
    // component fails. A single hard reload re-fetches index.html and the
    // current chunk-hash map. The sessionStorage flag prevents an infinite
    // reload loop if the NEW build is itself broken.
    if (typeof window !== 'undefined' && isStaleChunkError(error)) {
      if (!sessionStorage.getItem(CHUNK_RELOAD_FLAG)) {
        sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1')
        window.location.reload()
        return
      }
    }

    // Clear the flag on any non-chunk error so future stale-chunk events
    // still get one recovery attempt.
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(CHUNK_RELOAD_FLAG)
    }

    // React error boundaries can't use hooks; log to a non-interactive channel.
    // In production this surfaces in the browser's performance/error panel only.
    // Backend audit trail is maintained via ComplianceLog for all state mutations.
    if (typeof window !== 'undefined' && (window as any).__bytescon_logError) {
      (window as any).__bytescon_logError(error.message, info.componentStack)
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen gap-6"
          style={{ background: '#061019' }}>
          <div className="text-center max-w-md">
            <p className="text-4xl font-bold text-amber-400 mb-2">Something went wrong</p>
            <p className="text-slate-400 text-sm mb-6">
              We hit an unexpected problem. Try again, or return to your dashboard — your data is safe.
            </p>
            <button
              onClick={() => { this.setState({ hasError: false, message: '' }); window.location.href = '/' }}
              className="px-5 py-2.5 rounded-lg text-sm font-semibold text-black"
              style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}
            >
              Return to Dashboard
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
