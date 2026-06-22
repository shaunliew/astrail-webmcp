"use client";

import { useState } from "react";

const demoUrl = "https://www.youtube.com/watch?v=EoAxPk6OCdo";
const embedUrl =
  "https://www.youtube.com/embed/EoAxPk6OCdo?autoplay=1&rel=0&modestbranding=1";
const posterUrl = "https://img.youtube.com/vi/EoAxPk6OCdo/hqdefault.jpg";

export default function DemoVideoEmbed() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);

  if (isPlaying) {
    return (
      <iframe
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        className="h-full w-full border-0"
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-popups allow-presentation allow-same-origin allow-scripts"
        src={embedUrl}
        title="Astrail hackathon demo"
      />
    );
  }

  return (
    <button
      aria-label="Play the Astrail hackathon demo"
      className="group relative h-full w-full overflow-hidden text-left"
      onClick={() => setIsPlaying(true)}
      type="button"
    >
      {!posterFailed ? (
        <img
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-72 transition duration-700 group-hover:scale-[1.015] group-hover:opacity-90"
          loading="lazy"
          onError={() => setPosterFailed(true)}
          src={posterUrl}
        />
      ) : null}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_42%_36%,rgba(242,236,224,0.18),transparent_25%),linear-gradient(90deg,rgba(5,5,6,0.78),rgba(5,5,6,0.22)_45%,rgba(5,5,6,0.78)),linear-gradient(180deg,rgba(5,5,6,0.14),rgba(5,5,6,0.88))]" />
      <div className="absolute left-5 top-5 hidden w-[44%] border border-[color:var(--line)] bg-[rgba(5,5,6,0.42)] p-3 backdrop-blur md:block">
        <p className="type-label text-[10px] uppercase tracking-[0.16em] text-[color:var(--brass)]">
          Route sequence / day 1
        </p>
        {["Saved reel", "Verified stop", "Mapped trail"].map((item, index) => (
          <div
            className="mt-3 flex items-center justify-between border-t border-[color:var(--line)] pt-2 text-xs text-[color:var(--muted)]"
            key={item}
          >
            <span>{item}</span>
            <span className="type-label text-[color:var(--starlight)]">
              0{index + 1}
            </span>
          </div>
        ))}
      </div>
      <div className="absolute left-5 top-5 md:left-1/2 md:top-1/2 md:w-[min(440px,72%)] md:-translate-x-1/2 md:-translate-y-1/2 md:text-center">
        <p className="type-label text-xs uppercase tracking-[0.16em] text-[color:var(--brass)]">
          Hackathon demo
        </p>
        <p className="mt-2 max-w-md text-xl leading-7 text-[color:var(--starlight)] md:mx-auto">
          The hackathon demo. Rough, but the core loop works.
        </p>
      </div>
      <span className="absolute bottom-5 right-5 grid h-16 w-16 place-items-center rounded-full border border-[color:var(--brass)] bg-[rgba(5,5,6,0.58)] text-[color:var(--starlight)] shadow-[0_0_48px_rgba(201,151,78,0.2)] backdrop-blur transition group-hover:bg-[rgba(201,151,78,0.18)] md:left-1/2 md:top-[68%] md:h-20 md:w-20 md:-translate-x-1/2 md:-translate-y-1/2">
        <span className="ml-1 h-0 w-0 border-y-[11px] border-l-[18px] border-y-transparent border-l-[color:var(--starlight)]" />
      </span>
      <span className="sr-only">Open demo on YouTube: {demoUrl}</span>
    </button>
  );
}
