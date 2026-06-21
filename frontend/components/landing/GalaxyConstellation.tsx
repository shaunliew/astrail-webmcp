"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

type Star = {
  left: string;
  size: number;
  top: string;
  tone: "brass" | "cyan" | "starlight";
};

type ParticleLayer = {
  alphas: Float32Array;
  colors: Float32Array;
  positions: Float32Array;
  sizes: Float32Array;
};

const fallbackStars: Star[] = [
  { left: "12%", size: 2, top: "34%", tone: "starlight" },
  { left: "25%", size: 3, top: "57%", tone: "cyan" },
  { left: "39%", size: 2, top: "43%", tone: "starlight" },
  { left: "53%", size: 4, top: "61%", tone: "brass" },
  { left: "66%", size: 2, top: "29%", tone: "cyan" },
  { left: "78%", size: 3, top: "46%", tone: "starlight" },
  { left: "88%", size: 2, top: "67%", tone: "brass" },
];

const constellationPoints: Array<[number, number, number]> = [
  [-3.4, -0.58, 0],
  [-2.55, -1.08, 0],
  [-1.52, -0.72, 0],
  [-0.74, -1.34, 0],
  [0.35, -0.88, 0],
  [1.32, -0.06, 0],
  [2.08, -0.34, 0],
  [3.35, 0.44, 0],
];

const particleVertexShader = `
  attribute float aAlpha;
  attribute float aSize;

  uniform float uMotion;
  uniform float uPixelRatio;
  uniform float uTime;

  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    vec3 pos = position;
    float wave = sin(pos.x * 1.36 + pos.z * 2.4 + uTime * 0.34) * 0.055 * uMotion;
    pos.y += wave;
    pos.x += sin(pos.y * 1.72 + uTime * 0.16) * 0.028 * uMotion;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = aSize * uPixelRatio * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;

    vAlpha = aAlpha;
    vColor = color;
  }
`;

const particleFragmentShader = `
  uniform float uOpacity;

  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float dist = length(uv);
    float core = smoothstep(0.48, 0.0, dist);
    float halo = smoothstep(0.5, 0.13, dist) * 0.45;
    float alpha = (core + halo) * vAlpha * uOpacity;

    if (alpha < 0.01) {
      discard;
    }

    gl_FragColor = vec4(vColor * (0.82 + halo * 1.8), alpha);
  }
`;

function seededRandom(seed: number) {
  let value = seed;

  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

function createParticleLayer(
  count: number,
  seed: number,
  isMobile: boolean,
  mode: "dust" | "glow" | "foreground",
): ParticleLayer {
  const random = seededRandom(seed);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const alphas = new Float32Array(count);

  for (let index = 0; index < count; index += 1) {
    const t = Math.pow(random(), mode === "foreground" ? 0.72 : 0.6);
    const width = isMobile ? 4.15 : 8.8;
    const left = isMobile ? -1.7 : -3.55;
    const x = left + t * width;
    const band =
      Math.sin(x * 1.05 + 0.5) * (isMobile ? 0.78 : 0.9) +
      Math.cos(x * 0.48) * 0.42;
    const noise =
      (random() * 2 - 1) *
      (mode === "glow" ? (isMobile ? 1.05 : 1.2) : isMobile ? 0.92 : 1.05);
    const y =
      band +
      noise -
      Math.pow(Math.max(0, t - 0.4), 1.8) * (isMobile ? 0.75 : 0.35);
    const z = (random() * 2 - 1) * (mode === "foreground" ? 0.42 : 1.2);

    positions[index * 3] = x;
    positions[index * 3 + 1] = y;
    positions[index * 3 + 2] = z;

    const cyan = random() > (mode === "glow" ? 0.22 : 0.48);
    const electricBlue = random() > 0.8;
    const brass = random() > (mode === "foreground" ? 0.78 : 0.9);
    const white = random() > 0.92;

    if (white) {
      colors[index * 3] = 0.95;
      colors[index * 3 + 1] = 0.93;
      colors[index * 3 + 2] = 0.86;
    } else if (brass) {
      colors[index * 3] = 0.95;
      colors[index * 3 + 1] = 0.63;
      colors[index * 3 + 2] = 0.24;
    } else if (electricBlue) {
      colors[index * 3] = 0.2;
      colors[index * 3 + 1] = 0.35;
      colors[index * 3 + 2] = 1;
    } else if (cyan) {
      colors[index * 3] = 0.14;
      colors[index * 3 + 1] = 0.66 + random() * 0.18;
      colors[index * 3 + 2] = 0.94;
    } else {
      const warmth = 0.54 + random() * 0.32;
      colors[index * 3] = warmth;
      colors[index * 3 + 1] = warmth * 0.96;
      colors[index * 3 + 2] = warmth * 0.88;
    }

    if (mode === "glow") {
      sizes[index] = isMobile ? 0.17 + random() * 0.22 : 0.13 + random() * 0.2;
      alphas[index] = 0.1 + random() * 0.18;
    } else if (mode === "foreground") {
      sizes[index] = isMobile ? 0.07 + random() * 0.08 : 0.055 + random() * 0.08;
      alphas[index] = 0.28 + random() * 0.62;
    } else {
      sizes[index] = isMobile ? 0.032 + random() * 0.052 : 0.028 + random() * 0.05;
      alphas[index] = 0.14 + random() * 0.58;
    }
  }

  return { alphas, colors, positions, sizes };
}

function createParticleGeometry(layer: ParticleLayer) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(layer.positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(layer.colors, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(layer.sizes, 1));
  geometry.setAttribute("aAlpha", new THREE.BufferAttribute(layer.alphas, 1));
  return geometry;
}

function createParticleMaterial(pixelRatio: number, opacity: number) {
  return new THREE.ShaderMaterial({
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fragmentShader: particleFragmentShader,
    transparent: true,
    uniforms: {
      uMotion: { value: 1 },
      uOpacity: { value: opacity },
      uPixelRatio: { value: pixelRatio },
      uTime: { value: 0 },
    },
    vertexColors: true,
    vertexShader: particleVertexShader,
  });
}

function buildLinePositions(progress: number) {
  const segmentCount = constellationPoints.length - 1;
  const positions = new Float32Array(segmentCount * 6);

  for (let index = 0; index < segmentCount; index += 1) {
    const start = constellationPoints[index];
    const end = constellationPoints[index + 1];
    const localProgress = Math.max(
      0,
      Math.min(1, progress * segmentCount - index),
    );

    positions[index * 6] = start[0];
    positions[index * 6 + 1] = start[1];
    positions[index * 6 + 2] = start[2];
    positions[index * 6 + 3] = start[0] + (end[0] - start[0]) * localProgress;
    positions[index * 6 + 4] = start[1] + (end[1] - start[1]) * localProgress;
    positions[index * 6 + 5] = start[2] + (end[2] - start[2]) * localProgress;
  }

  return positions;
}

function StaticFallback() {
  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_76%_47%,rgba(25,95,170,0.44),transparent_35%),radial-gradient(ellipse_at_72%_70%,rgba(68,185,210,0.2),transparent_31%),radial-gradient(ellipse_at_84%_72%,rgba(201,151,78,0.18),transparent_36%)]" />
      <div className="absolute left-[45%] top-[34%] h-px w-[54%] rotate-[25deg] bg-[color:var(--line)]" />
      <div className="absolute left-[20%] top-[69%] h-px w-[72%] -rotate-[17deg] bg-[color:var(--brass)]/45" />
      {fallbackStars.map((star) => (
        <span
          className={
            star.tone === "cyan"
              ? "absolute bg-cyan-300"
              : star.tone === "brass"
                ? "absolute bg-[color:var(--brass)]"
                : "absolute bg-[color:var(--starlight)]"
          }
          key={`${star.left}-${star.top}`}
          style={{
            height: star.size,
            left: star.left,
            opacity: 0.58,
            top: star.top,
            width: star.size,
          }}
        />
      ))}
    </div>
  );
}

export default function GalaxyConstellation() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [usesFallback, setUsesFallback] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return undefined;
    }

    const reducedMotionQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    const isMobile = window.matchMedia("(max-width: 767px)").matches;
    const shouldReduceMotion = reducedMotionQuery.matches;
    const pixelRatio = Math.min(window.devicePixelRatio, isMobile ? 1.15 : 1.45);

    let animationFrame = 0;
    let disposed = false;
    let pointerX = 0;
    let pointerY = 0;
    let targetPointerX = 0;
    let targetPointerY = 0;

    try {
      const renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: false,
        powerPreference: "high-performance",
      });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(pixelRatio);
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
      camera.position.z = isMobile ? 10.2 : 8.25;

      const renderPass = new RenderPass(scene, camera);
      const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(1, 1),
        isMobile ? 1.05 : 1.22,
        isMobile ? 0.58 : 0.64,
        0.03,
      );
      const composer = new EffectComposer(renderer);
      composer.addPass(renderPass);
      composer.addPass(bloomPass);

      const dustCount = shouldReduceMotion
        ? isMobile
          ? 1400
          : 3200
        : isMobile
          ? 3000
          : 10500;
      const glowCount = shouldReduceMotion
        ? isMobile
          ? 260
          : 720
        : isMobile
          ? 560
          : 2600;
      const foregroundCount = shouldReduceMotion
        ? isMobile
          ? 180
          : 420
        : isMobile
          ? 360
          : 1300;

      const dustGeometry = createParticleGeometry(
        createParticleLayer(dustCount, 1949, isMobile, "dust"),
      );
      const glowGeometry = createParticleGeometry(
        createParticleLayer(glowCount, 8817, isMobile, "glow"),
      );
      const foregroundGeometry = createParticleGeometry(
        createParticleLayer(foregroundCount, 4111, isMobile, "foreground"),
      );

      const dustMaterial = createParticleMaterial(pixelRatio, isMobile ? 1.05 : 1.12);
      const glowMaterial = createParticleMaterial(pixelRatio, isMobile ? 0.95 : 1.05);
      const foregroundMaterial = createParticleMaterial(pixelRatio, 0.95);

      const dustPoints = new THREE.Points(dustGeometry, dustMaterial);
      const glowPoints = new THREE.Points(glowGeometry, glowMaterial);
      const foregroundPoints = new THREE.Points(
        foregroundGeometry,
        foregroundMaterial,
      );

      for (const points of [dustPoints, glowPoints, foregroundPoints]) {
        points.position.x = isMobile ? 0.58 : 0.86;
        points.position.y = isMobile ? -0.82 : -0.2;
        points.rotation.z = -0.045;
        scene.add(points);
      }

      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(buildLinePositions(shouldReduceMotion ? 1 : 0), 3),
      );
      const lineMaterial = new THREE.LineBasicMaterial({
        blending: THREE.AdditiveBlending,
        color: 0xc9974e,
        opacity: 0.62,
        transparent: true,
      });
      const constellationLine = new THREE.LineSegments(lineGeometry, lineMaterial);
      constellationLine.position.x = isMobile ? 0.06 : 0.9;
      constellationLine.position.y = isMobile ? -1.18 : -0.5;
      scene.add(constellationLine);

      const nodeLayer = {
        alphas: new Float32Array(constellationPoints.map(() => 0.92)),
        colors: new Float32Array(
          constellationPoints.flatMap(() => [0.95, 0.9, 0.76]),
        ),
        positions: new Float32Array(constellationPoints.flat()),
        sizes: new Float32Array(
          constellationPoints.map(() => (isMobile ? 0.13 : 0.1)),
        ),
      };
      const nodeGeometry = createParticleGeometry(nodeLayer);
      const nodeMaterial = createParticleMaterial(pixelRatio, 0.95);
      const nodes = new THREE.Points(nodeGeometry, nodeMaterial);
      nodes.position.copy(constellationLine.position);
      scene.add(nodes);

      const resize = () => {
        const width = mount.clientWidth;
        const height = mount.clientHeight;

        renderer.setSize(width, height);
        composer.setSize(width, height);
        camera.aspect = width / Math.max(height, 1);
        camera.updateProjectionMatrix();
      };

      const onPointerMove = (event: PointerEvent) => {
        targetPointerX = (event.clientX / window.innerWidth - 0.5) * 2;
        targetPointerY = (event.clientY / window.innerHeight - 0.5) * 2;
      };

      const render = (timestamp: number) => {
        if (disposed) {
          return;
        }

        const time = timestamp * 0.001;
        const drawProgress = shouldReduceMotion
          ? 1
          : Math.min(1, Math.max(0, (time - 0.14) / 2.5));

        const positionAttribute = lineGeometry.getAttribute(
          "position",
        ) as THREE.BufferAttribute;
        positionAttribute.array = buildLinePositions(drawProgress);
        positionAttribute.needsUpdate = true;

        for (const material of [
          dustMaterial,
          glowMaterial,
          foregroundMaterial,
          nodeMaterial,
        ]) {
          material.uniforms.uTime.value = time;
          material.uniforms.uMotion.value = shouldReduceMotion ? 0 : 1;
        }

        pointerX += (targetPointerX - pointerX) * 0.035;
        pointerY += (targetPointerY - pointerY) * 0.035;

        dustPoints.rotation.z = shouldReduceMotion ? -0.045 : -0.045 + time * 0.012;
        glowPoints.rotation.z = shouldReduceMotion ? -0.045 : -0.045 + time * 0.009;
        foregroundPoints.rotation.z =
          shouldReduceMotion ? -0.045 : -0.045 + time * 0.016;

        for (const points of [dustPoints, glowPoints, foregroundPoints]) {
          points.rotation.x = pointerY * 0.026;
          points.rotation.y = pointerX * 0.03;
        }

        constellationLine.rotation.x = pointerY * 0.012;
        constellationLine.rotation.y = pointerX * 0.016;
        nodes.rotation.copy(constellationLine.rotation);

        composer.render();

        if (!shouldReduceMotion) {
          animationFrame = window.requestAnimationFrame(render);
        }
      };

      resize();
      mount.appendChild(renderer.domElement);
      setIsReady(true);
      window.addEventListener("resize", resize);

      if (!shouldReduceMotion && !isMobile) {
        window.addEventListener("pointermove", onPointerMove);
      }

      if (shouldReduceMotion) {
        render(3000);
      } else {
        animationFrame = window.requestAnimationFrame(render);
      }

      return () => {
        disposed = true;
        window.cancelAnimationFrame(animationFrame);
        window.removeEventListener("resize", resize);
        window.removeEventListener("pointermove", onPointerMove);

        dustGeometry.dispose();
        glowGeometry.dispose();
        foregroundGeometry.dispose();
        lineGeometry.dispose();
        nodeGeometry.dispose();
        dustMaterial.dispose();
        glowMaterial.dispose();
        foregroundMaterial.dispose();
        lineMaterial.dispose();
        nodeMaterial.dispose();
        bloomPass.dispose();
        composer.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    } catch {
      setUsesFallback(true);
      setIsReady(true);
      return undefined;
    }
  }, []);

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
      <div
        className="absolute inset-0 opacity-100"
        ref={mountRef}
        data-hero-webgl={isReady ? "ready" : "pending"}
      />
      <div
        className={
          isReady && !usesFallback
            ? "opacity-0 transition-opacity duration-700"
            : "opacity-100 transition-opacity duration-700"
        }
      >
        <StaticFallback />
      </div>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_80%_45%,rgba(36,115,190,0.12),transparent_31%),radial-gradient(ellipse_at_77%_70%,rgba(52,210,214,0.08),transparent_28%),linear-gradient(90deg,rgba(5,5,6,0.98)_0%,rgba(5,5,6,0.9)_30%,rgba(5,5,6,0.46)_48%,rgba(5,5,6,0.1)_70%,rgba(5,5,6,0.22)_100%),linear-gradient(180deg,rgba(5,5,6,0.3),rgba(5,5,6,0.9)_94%)]" />
    </div>
  );
}
