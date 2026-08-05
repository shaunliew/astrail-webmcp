'use client'

/* A swap-ready frame for a real app screenshot. Until the capture lands, it
   renders a labeled placeholder panel; drop the file into
   public/landing/screens/ and pass its src — nothing else changes.
   Framed like a browser window so real UI reads as real UI. */
export default function ShotSlot({
  src,
  label,
  alt,
  className,
}: {
  src?: string
  label: string
  alt: string
  className?: string
}) {
  return (
    <figure
      className={`overflow-hidden rounded-xl border border-[color:var(--paper-line)] bg-[color:var(--paper-0)] shadow-[0_1px_2px_rgba(28,23,16,0.08),0_16px_40px_rgba(28,23,16,0.14)] ${className ?? ''}`}
    >
      {/* browser chrome strip */}
      <div className="flex items-center gap-1.5 border-b border-[color:var(--paper-line)] bg-[color:var(--paper-2)] px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--paper-line-2)]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--paper-line-2)]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--paper-line-2)]" />
        <span className="ml-3 font-mono text-[11px] tracking-wide text-[color:var(--ink-400)]">
          astrail.app
        </span>
      </div>
      {src ? (
        /* 1440x900 capture = 16:10. Reserving the ratio keeps the card at
           full size before the lazy image arrives — no strip-collapse, no
           layout jump when it lands. */
        <img
          src={src}
          alt={alt}
          className="block aspect-[16/10] w-full object-cover"
          loading="lazy"
        />
      ) : (
        <div
          role="img"
          aria-label={alt}
          className="flex aspect-[16/10] items-center justify-center border-2 border-dashed border-[color:var(--paper-line-2)] m-3 rounded-lg"
        >
          <p className="px-6 text-center font-mono text-xs uppercase tracking-[0.14em] text-[color:var(--ink-400)]">
            {label}
          </p>
        </div>
      )}
    </figure>
  )
}
