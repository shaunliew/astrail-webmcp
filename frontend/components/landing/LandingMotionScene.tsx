"use client";

import { useEffect, useRef } from "react";

import LightShards from "./LightShards";
import ScrollTrail from "./ScrollTrail";

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export default function LandingMotionScene() {
  const sceneRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) {
      return undefined;
    }

    const reducedMotionQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    let frame = 0;

    const update = () => {
      frame = 0;

      const parent = scene.parentElement;
      if (!parent) {
        return;
      }

      const rect = parent.getBoundingClientRect();
      const scrollable = Math.max(1, rect.height - window.innerHeight);
      const progress = reducedMotionQuery.matches
        ? 1
        : clamp(-rect.top / scrollable);
      const shardProgress =
        smoothstep(0.2, 0.52, progress) * (1 - smoothstep(0.64, 0.82, progress));
      const routeProgress = smoothstep(0.48, 0.92, progress);
      const bridgeProgress = smoothstep(0.08, 0.38, progress);

      scene.style.setProperty("--motion-progress", progress.toFixed(4));
      scene.style.setProperty("--bridge-opacity", (bridgeProgress * 0.9).toFixed(4));
      scene.style.setProperty("--shard-opacity", shardProgress.toFixed(4));
      scene.style.setProperty("--route-opacity", routeProgress.toFixed(4));
      scene.style.setProperty("--route-offset", (1 - routeProgress).toFixed(4));
      scene.style.setProperty(
        "--motion-y",
        `${(progress * -18).toFixed(2)}vh`,
      );
    };

    const requestUpdate = () => {
      if (frame) {
        return;
      }

      frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);
    reducedMotionQuery.addEventListener("change", requestUpdate);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
      reducedMotionQuery.removeEventListener("change", requestUpdate);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="landing-motion-scene"
      ref={sceneRef}
      style={{
        ["--bridge-opacity" as string]: 0,
        ["--motion-progress" as string]: 0,
        ["--motion-y" as string]: "0vh",
        ["--route-offset" as string]: 1,
        ["--route-opacity" as string]: 0,
        ["--shard-opacity" as string]: 0,
      }}
    >
      <div className="landing-motion-scene__sticky">
        <div className="motion-bridge" />
        <LightShards />
        <ScrollTrail />
      </div>
    </div>
  );
}
