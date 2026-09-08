// =============================================================
// Public marketing landing (/). Header, five sections, footer:
// Hero → How it works → Agents → Platform → Pricing → CTA/Footer.
// Section components live in components/landing/; styles are scoped
// under the .lp root class in components/landing/landing.css. Motion
// (framer-motion + Lenis) is provided once here.
// =============================================================
import '../components/landing/landing.css'
import { MotionProvider, SmoothScroll } from '../components/landing/motion'
import { LandingHeader } from '../components/landing/LandingHeader'
import { Hero } from '../components/landing/Hero'
import { Loop } from '../components/landing/Loop'
import { Agents } from '../components/landing/Agents'
import { Platform } from '../components/landing/Platform'
import { Pricing } from '../components/landing/Pricing'
import { Footer } from '../components/landing/Footer'

export function LandingPage() {
  return (
    <MotionProvider>
      <SmoothScroll>
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
      </SmoothScroll>
    </MotionProvider>
  )
}
