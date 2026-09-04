// =============================================================
// Public marketing landing (/welcome). Header, five sections, footer:
// Hero → How it works → Agents → Platform → Pricing → CTA/Footer.
// Section components live in components/landing/; styles are scoped
// under the .lp root class in components/landing/landing.css.
// =============================================================
import '../components/landing/landing.css'
import { LandingHeader } from '../components/landing/LandingHeader'
import { Hero } from '../components/landing/Hero'
import { Loop } from '../components/landing/Loop'
import { Agents } from '../components/landing/Agents'
import { Platform } from '../components/landing/Platform'
import { Pricing } from '../components/landing/Pricing'
import { Footer } from '../components/landing/Footer'

export function LandingPage() {
  return (
    <div className="lp">
      <LandingHeader />
      <main>
        <Hero />
        <Loop />
        <Agents />
        <Platform />
        <Pricing />
      </main>
      <Footer />
    </div>
  )
}
