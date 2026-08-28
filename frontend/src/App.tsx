import { lazy, Suspense } from "react"
import { Routes, Route } from "react-router-dom"
import { Spinner } from "./components/ui"
import { Layout } from "./components/layout"
import { ProtectedRoute } from "./components/ProtectedRoute"
import { ClientProtectedRoute } from "./components/ClientProtectedRoute"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { AiAssistant } from "./components/AiAssistant"
import { PaywallModal } from "./components/PaywallModal"

// Lazy-loaded pages — each chunk loads on demand, reducing initial bundle
const DashboardPage        = lazy(() => import("./pages/Dashboard"))
const OpportunitiesPage    = lazy(() => import("./pages/Opportunities").then(m => ({ default: m.OpportunitiesPage })))
const OpportunityDetail    = lazy(() => import("./pages/OpportunityDetail"))
const ProposalWorkspace    = lazy(() => import("./pages/ProposalWorkspace"))
const PricingWorkspace     = lazy(() => import("./pages/PricingWorkspace"))
const SubmissionWorkspace  = lazy(() => import("./pages/SubmissionWorkspace"))
const PastPerformanceLibrary = lazy(() => import("./pages/PastPerformanceLibrary"))
const LoginPage            = lazy(() => import("./pages/Login").then(m => ({ default: m.LoginPage })))
const RegisterPage         = lazy(() => import("./pages/Register").then(m => ({ default: m.RegisterPage })))
const ClientsPage          = lazy(() => import("./pages/Clients").then(m => ({ default: m.ClientsPage })))
const ClientDetail         = lazy(() => import("./pages/ClientDetail"))
const SubmissionsPage      = lazy(() => import("./pages/Submissions").then(m => ({ default: m.SubmissionsPage })))
const RegistrationPage     = lazy(() => import("./pages/Registration").then(m => ({ default: m.RegistrationPage })))
const ContractsPage        = lazy(() => import("./pages/Contracts").then(m => ({ default: m.ContractsPage })))
const ContractDetail       = lazy(() => import("./pages/ContractDetail"))
const TimekeepingPage      = lazy(() => import("./pages/Timekeeping").then(m => ({ default: m.TimekeepingPage })))
const ReceivablesPage      = lazy(() => import("./pages/Receivables").then(m => ({ default: m.ReceivablesPage })))
const PenaltiesPage        = lazy(() => import("./pages/Penalties").then(m => ({ default: m.PenaltiesPage })))
const SettingsPage         = lazy(() => import("./pages/Settings").then(m => ({ default: m.SettingsPage })))
const IntegrationsPage     = lazy(() => import("./pages/Integrations"))
const DocRequirementsPage  = lazy(() => import("./pages/DocRequirements").then(m => ({ default: m.DocRequirementsPage })))
const TemplatesPage        = lazy(() => import("./pages/Templates").then(m => ({ default: m.TemplatesPage })))
const TemplateLibrary      = lazy(() => import("./pages/TemplateLibrary"))
const AnalyticsPage        = lazy(() => import("./pages/Analytics"))
const DecisionsPage        = lazy(() => import("./pages/Decisions"))
const PipelinePage         = lazy(() => import("./pages/Pipeline").then(m => ({ default: m.PipelinePage })))
// §6 — four-pillar enhancement pages.
const DiscoveryPage        = lazy(() => import("./pages/Discovery"))
const PortfolioPage        = lazy(() => import("./pages/Portfolio"))
const DocumentLibraryPage  = lazy(() => import("./pages/DocumentLibrary"))
const CrmPage             = lazy(() => import("./pages/Crm"))
const PartnerSubmissions  = lazy(() => import("./pages/PartnerSubmissions"))
const IndirectRatesPage   = lazy(() => import("./pages/IndirectRates"))
const AuditReadinessPage  = lazy(() => import("./pages/AuditReadiness"))
const CapabilityLibrary   = lazy(() => import("./pages/CapabilityLibrary"))
const SignaturesPage      = lazy(() => import("./pages/Signatures"))
const KnowledgePage       = lazy(() => import("./pages/Knowledge"))
const PartnerPortalPage   = lazy(() => import("./pages/partner/PartnerPortal"))
const PartnerLoginPage    = lazy(() => import("./pages/partner/PartnerPortal").then((m) => ({ default: m.PartnerLoginPage })))
const PartnerResetPage    = lazy(() => import("./pages/partner/PartnerPortal").then((m) => ({ default: m.PartnerResetPasswordPage })))
const PartnerAcceptPage   = lazy(() => import("./pages/partner/PartnerPortal").then((m) => ({ default: m.PartnerAcceptInvitePage })))
const AgentsPage           = lazy(() => import("./pages/Agents"))
const AgentRunDetailPage   = lazy(() => import("./pages/AgentRunDetail"))
const QualificationPage    = lazy(() => import("./pages/Qualification").then(m => ({ default: m.QualificationPage })))
const NotificationsPage    = lazy(() => import("./pages/Notifications").then(m => ({ default: m.NotificationsPage })))
const ComplianceLogsPage   = lazy(() => import("./pages/ComplianceLogs"))
const AdminBacktestPage    = lazy(() => import("./pages/AdminBacktest"))
const TemplateModerationPage = lazy(() => import("./pages/TemplateModeration"))
const PlatformCogsPage = lazy(() => import("./pages/PlatformCogs"))
const MfaChallengePage = lazy(() => import("./pages/MfaChallenge"))
const PlatformMetricsPage = lazy(() => import("./pages/PlatformMetrics"))
const ClientPortalLogin    = lazy(() => import("./pages/ClientPortalLogin"))
const ClientPortalDashboard = lazy(() => import("./pages/ClientPortalDashboard"))
const RewardsPage          = lazy(() => import("./pages/Rewards").then(m => ({ default: m.RewardsPage })))
const BillingPage            = lazy(() => import("./pages/Billing"))
const StateMunicipalPage     = lazy(() => import("./pages/StateMunicipalPage").then(m => ({ default: m.StateMunicipalPage })))
const SubcontractingPage     = lazy(() => import("./pages/SubcontractingPage").then(m => ({ default: m.SubcontractingPage })))
const PrimeContactsPage      = lazy(() => import("./pages/PrimeContactsPage").then(m => ({ default: m.PrimeContactsPage })))
const AgencyViewPage         = lazy(() => import("./pages/AgencyView"))
const TeamingPage            = lazy(() => import("./pages/Teaming"))
const PlatformOnboardingPage = lazy(() => import("./pages/PlatformOnboarding"))
const RecipientProfilePage   = lazy(() => import("./pages/RecipientProfile"))
const RoiCalculatorPage      = lazy(() => import("./pages/RoiCalculator"))
const SetAsideIntelligencePage = lazy(() => import("./pages/SetAsideIntelligence"))
const ContractUploadPage     = lazy(() => import("./pages/ContractUpload"))
const ForgotPasswordPage      = lazy(() => import("./pages/ForgotPassword").then(m => ({ default: m.ForgotPasswordPage })))
const ResetPasswordPage       = lazy(() => import("./pages/ResetPassword").then(m => ({ default: m.ResetPasswordPage })))
const VerifyEmailPage         = lazy(() => import("./pages/VerifyEmail").then(m => ({ default: m.VerifyEmailPage })))
const AcceptAgreementsPage    = lazy(() => import("./pages/AcceptAgreements").then(m => ({ default: m.AcceptAgreementsPage })))
const LandingPage            = lazy(() => import("./pages/Landing").then(m => ({ default: m.LandingPage })))
const TrustSecurityPage      = lazy(() => import("./pages/TrustSecurity").then(m => ({ default: m.TrustSecurityPage })))
const FeedbackPage           = lazy(() => import("./pages/Feedback"))
const NotFoundPage           = lazy(() => import("./pages/NotFound"))

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[40vh]">
      <Spinner />
    </div>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          {/* Public pages */}
          <Route path="/welcome" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/accept-agreements" element={<AcceptAgreementsPage />} />
          <Route path="/mfa-challenge" element={<MfaChallengePage />} />
          <Route path="/trust" element={<TrustSecurityPage />} />

          {/* Client portal (standalone, no consultant layout) */}
          {/* Guarded by the CLIENT token, not the consultant ProtectedRoute. */}
          <Route path="/client-login" element={<ClientPortalLogin />} />
          <Route element={<ClientProtectedRoute />}>
            <Route path="/client-portal" element={<ClientPortalDashboard />} />
          </Route>

          {/* §8.3 partner portal (standalone, no consultant layout).
              Guarded by the PARTNER token — never the consultant ProtectedRoute. */}
          <Route path="/partner/login" element={<PartnerLoginPage />} />
          <Route path="/partner/accept-invite" element={<PartnerAcceptPage />} />
          <Route path="/partner/reset-password" element={<PartnerResetPage />} />
          <Route path="/partner" element={<PartnerPortalPage />} />

          {/* Consultant platform */}
          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/opportunities" element={<OpportunitiesPage />} />
              <Route path="/opportunities/:id" element={<OpportunityDetail />} />
              <Route path="/opportunities/:id/proposal" element={<ProposalWorkspace />} />
              <Route path="/opportunities/:id/pricing" element={<PricingWorkspace />} />
              <Route path="/opportunities/:id/submission" element={<SubmissionWorkspace />} />
              <Route path="/opportunities/:id/past-performance" element={<PastPerformanceLibrary />} />
              <Route path="/past-performance-library" element={<PastPerformanceLibrary />} />
              <Route path="/clients" element={<ClientsPage />} />
              <Route path="/clients/:id" element={<ClientDetail />} />
              <Route path="/template-library" element={<TemplateLibrary />} />
              <Route path="/decisions" element={<DecisionsPage />} />
              <Route path="/pipeline" element={<PipelinePage />} />
              <Route path="/discovery" element={<DiscoveryPage />} />
              <Route path="/portfolio" element={<PortfolioPage />} />
              <Route path="/document-library" element={<DocumentLibraryPage />} />
              <Route path="/crm" element={<CrmPage />} />
              <Route path="/partner-submissions" element={<PartnerSubmissions />} />
              <Route path="/indirect-rates" element={<IndirectRatesPage />} />
              <Route path="/audit-readiness" element={<AuditReadinessPage />} />
              <Route path="/capability-library" element={<CapabilityLibrary />} />
              <Route path="/signatures" element={<SignaturesPage />} />
              <Route path="/knowledge" element={<KnowledgePage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/agents/runs/:id" element={<AgentRunDetailPage />} />
              <Route path="/pipeline/:pursuitId" element={<QualificationPage />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/templates" element={<TemplatesPage />} />
              <Route path="/doc-requirements" element={<DocRequirementsPage />} />
              <Route path="/submissions" element={<SubmissionsPage />} />
              <Route path="/registration" element={<RegistrationPage />} />
              <Route path="/contracts" element={<ContractsPage />} />
              <Route path="/contracts/:id" element={<ContractDetail />} />
              <Route path="/timekeeping" element={<TimekeepingPage />} />
              <Route path="/receivables" element={<ReceivablesPage />} />
              <Route path="/penalties" element={<PenaltiesPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/state-municipal" element={<StateMunicipalPage />} />
              <Route path="/subcontracting/contacts" element={<PrimeContactsPage />} />
              <Route path="/subcontracting" element={<SubcontractingPage />} />
              <Route path="/agency" element={<AgencyViewPage />} />
              <Route path="/teaming" element={<TeamingPage />} />
              <Route path="/platform-onboarding" element={<PlatformOnboardingPage />} />
              <Route path="/recipient/:uei" element={<RecipientProfilePage />} />
              <Route path="/rewards" element={<RewardsPage />} />
              <Route path="/billing" element={<BillingPage />} />
              <Route path="/roi-calculator" element={<RoiCalculatorPage />} />
              <Route path="/set-aside" element={<SetAsideIntelligencePage />} />
              <Route path="/contract-upload" element={<ContractUploadPage />} />
              <Route path="/feedback" element={<FeedbackPage />} />
              {/* Settings is viewable by all roles (read-only members included); write actions stay admin-gated server-side */}
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/integrations" element={<IntegrationsPage />} />

              <Route element={<ProtectedRoute roles={["ADMIN"]} />}>
                <Route path="/compliance" element={<ComplianceLogsPage />} />
                <Route path="/admin/backtest" element={<AdminBacktestPage />} />
                <Route path="/template-moderation" element={<TemplateModerationPage />} />
                <Route path="/platform/margin" element={<PlatformCogsPage />} />
                <Route path="/platform/metrics" element={<PlatformMetricsPage />} />
              </Route>
            </Route>
          </Route>

          {/* 404 catch-all */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        <AiAssistant />
        <PaywallModal />
      </Suspense>
    </ErrorBoundary>
  )
}
