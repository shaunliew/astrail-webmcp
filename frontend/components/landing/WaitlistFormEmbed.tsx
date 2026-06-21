import { tallyEmbedUrl, tallyFallbackUrl } from "./landing-copy";

export default function WaitlistFormEmbed() {
  return (
    <div className="surface self-start p-4">
      <div className="mb-4 flex items-center justify-between gap-4">
        <p className="type-label text-xs uppercase tracking-[0.16em] text-[color:var(--brass)]">
          Email-only form
        </p>
        <a
          className="type-label shrink-0 text-xs uppercase tracking-[0.12em] text-[color:var(--starlight)] underline decoration-[color:var(--brass)]/60 underline-offset-4"
          href={tallyFallbackUrl}
          rel="noreferrer"
          target="_blank"
        >
          Open direct
        </a>
      </div>
      <div className="relative overflow-hidden border border-[color:var(--line)] bg-[rgba(5,5,6,0.5)]">
        <iframe
          className="h-[350px] w-full border-0 md:h-[320px]"
          loading="lazy"
          sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
          scrolling="no"
          src={tallyEmbedUrl}
          title="Astrail beta waitlist form"
        />
      </div>
      <p className="px-1 pt-3 text-sm leading-6 text-[color:var(--muted)]">
        If the embedded form is slow or blocked,{" "}
        <a
          className="text-[color:var(--brass)]"
          href={tallyFallbackUrl}
          rel="noreferrer"
          target="_blank"
        >
          open the waitlist form
        </a>
        .
      </p>
    </div>
  );
}
