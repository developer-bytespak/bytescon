import "./index.css"
import React from "react"
import ReactDOM from "react-dom/client"
import { registerServiceWorker } from "./lib/registerServiceWorker"
import { BrowserRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import * as Sentry from "@sentry/react"
import { AuthProvider } from "./hooks/useAuth"
import { ToastProvider } from "./components/Toast"
import { initAnalytics } from "./lib/analytics"
import App from "./App"

// Sentry — enabled when VITE_SENTRY_DSN is set, no-op otherwise.
const sentryDsn = (import.meta as any).env?.VITE_SENTRY_DSN
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: (import.meta as any).env?.MODE || 'development',
    tracesSampleRate: 0.1,
    integrations: [Sentry.browserTracingIntegration()],
  })
}

// PostHog — enabled when VITE_POSTHOG_KEY is set, no-op otherwise.
initAnalytics()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
})

registerServiceWorker()

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>
)
