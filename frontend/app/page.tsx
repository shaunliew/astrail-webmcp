import FAQSection from "@/components/landing/FAQSection";
import Footer from "@/components/landing/Footer";
import FounderSection from "@/components/landing/FounderSection";
import HeroSection from "@/components/landing/HeroSection";
import HowItWorksSection from "@/components/landing/HowItWorksSection";
import LandingMotionScene from "@/components/landing/LandingMotionScene";
import LandingNav from "@/components/landing/LandingNav";
import PainSection from "@/components/landing/PainSection";
import ProofSection from "@/components/landing/ProofSection";
import WaitlistSection from "@/components/landing/WaitlistSection";

export default function LandingPage() {
  return (
    <main className="min-h-[100dvh] overflow-hidden bg-[color:var(--void)] text-[color:var(--starlight)]">
      <LandingNav />
      <div className="relative overflow-hidden">
        <LandingMotionScene />
        <div className="relative z-10">
          <HeroSection />
          <PainSection />
          <HowItWorksSection />
        </div>
      </div>
      <ProofSection />
      <FounderSection />
      <WaitlistSection />
      <FAQSection />
      <Footer />
    </main>
  );
}
