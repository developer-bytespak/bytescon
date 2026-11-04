// An always-visible bar on every page of a staging build, signed in or not, so
// nobody mistakes the internal test environment for the real product.
export function StagingBanner({ appEnv = import.meta.env.VITE_APP_ENV }: { appEnv?: string }) {
  if (appEnv !== 'staging') return null
  return (
    <div
      role="status"
      data-testid="staging-banner"
      className="sticky top-0 w-full px-4 py-1 text-center text-xs font-semibold"
      style={{ background: '#ea580c', color: '#ffffff', zIndex: 9999 }}
    >
      STAGING — internal test environment. Test data only; payments and emails are not real.
    </div>
  )
}
