import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

type CanvasState = 'off' | 'booting' | 'running' | 'stopping' | 'suspended';

interface CyberCanvasProps {
  vmState: CanvasState;
  /** Drives rotation speed only. Purely decorative — never rendered as a number. */
  intensity?: number;
  /** Optional caption rendered over the scene (real data only, please). */
  caption?: React.ReactNode;
  className?: string;
}

const COLORS: Record<CanvasState, { edge: number; core: number; speed: number; opacity: number }> = {
  running:   { edge: 0x22d3ee, core: 0xffffff, speed: 1.0,  opacity: 0.95 },
  booting:   { edge: 0xfbbf24, core: 0xfff7e0, speed: 0.5,  opacity: 0.85 },
  stopping:  { edge: 0xfbbf24, core: 0xffe0c0, speed: 0.28, opacity: 0.7 },
  suspended: { edge: 0x64748b, core: 0xcbd5e1, speed: 0.15, opacity: 0.6 },
  off:       { edge: 0x445566, core: 0x8899aa, speed: 0.06, opacity: 0.5 },
};

const ARM_COUNT = 4;
const TWIST = 1.6;          // how tightly the arms wind (radians per unit radius)
const MAX_RADIUS = 6.0;
const POINTS_PER_ARM = 1600;
const PARTICLE_COUNT = ARM_COUNT * POINTS_PER_ARM;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function makeSprite(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.65, 'rgba(255,255,255,0.3)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

export const Cyber3DCanvas: React.FC<CyberCanvasProps> = ({
  vmState,
  intensity = 60,
  caption,
  className = '',
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const still = prefersReducedMotion();

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }

    const width = container.clientWidth || 320;
    const height = container.clientHeight || 320;

    const scene = new THREE.Scene();
    // Fixed elevated camera — no sway, so it reads calm and ordered.
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    camera.position.set(0, 8.5, 3.2);
    camera.lookAt(0, 0, 0);

    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    container.appendChild(renderer.domElement);

    const state = COLORS[vmState] ?? COLORS.off;
    const sprite = makeSprite();

    // ---- Deterministic spiral — no scatter, no random sizes, perfectly uniform ----
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const colors = new Float32Array(PARTICLE_COUNT * 3);
    const edgeColor = new THREE.Color(state.edge);
    const coreColor = new THREE.Color(state.core);

    let i = 0;
    for (let arm = 0; arm < ARM_COUNT; arm++) {
      const armOffset = (arm / ARM_COUNT) * Math.PI * 2;
      for (let j = 0; j < POINTS_PER_ARM; j++) {
        const t = j / (POINTS_PER_ARM - 1);               // 0..1, evenly spaced
        const radius = 0.4 + t * (MAX_RADIUS - 0.4);
        const angle = armOffset + radius * TWIST;          // logarithmic spiral, no scatter
        const y = 0;                                        // perfectly flat
        const mix = 1 - t;                                  // bright centre → colour edge

        positions[i * 3] = Math.cos(angle) * radius;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = Math.sin(angle) * radius;

        const c = edgeColor.clone().lerp(coreColor, mix);
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
        i++;
      }
    }

    const particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    particleGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const particleMat = new THREE.PointsMaterial({
      size: 0.2,
      map: sprite,
      vertexColors: true,
      transparent: true,
      opacity: state.opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    const particleSystem = new THREE.Points(particleGeo, particleMat);
    scene.add(particleSystem);

    // Central bright core.
    const hotGeo = new THREE.IcosahedronGeometry(0.28, 2);
    const hotMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const hotMesh = new THREE.Mesh(hotGeo, hotMat);
    scene.add(hotMesh);

    const clock = new THREE.Clock();
    let frameId = 0;
    let running = false;
    let elapsed = 0;

    const renderOnce = () => {
      renderer.render(scene, camera);
    };

    const animate = () => {
      frameId = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05);
      elapsed += dt;

      const clamp = Math.max(0, Math.min(100, intensity));
      // Slow, rigid, uniform rotation — the whole spiral turns as one ordered unit.
      const rotSpeed = (0.25 + (clamp / 100) * 0.5) * state.speed;
      particleSystem.rotation.y += rotSpeed * dt;

      // Gentle core pulse.
      hotMesh.scale.setScalar(1 + Math.sin(elapsed * 2.0) * 0.08);

      renderer.render(scene, camera);
    };

    const start = () => {
      if (running || still) return;
      running = true;
      clock.getDelta();
      animate();
    };
    const stop = () => {
      running = false;
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
    };

    renderOnce();
    let onScreen = true;

    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        ([entry]) => {
          onScreen = entry.isIntersecting;
          if (onScreen && !document.hidden) start();
          else stop();
        },
        { threshold: 0.05 },
      );
      observer.observe(container);
    } else if (!still) {
      start();
    }

    const onVisibility = () => {
      if (document.hidden) stop();
      else if (onScreen) start();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      if (!running) renderOnce();
    };
    window.addEventListener('resize', handleResize);

    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const onMotionChange = () => {
      if (mq?.matches) {
        stop();
        renderOnce();
      } else if (onScreen && !document.hidden) {
        start();
      }
    };
    mq?.addEventListener?.('change', onMotionChange);

    return () => {
      stop();
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', handleResize);
      mq?.removeEventListener?.('change', onMotionChange);
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      particleGeo.dispose();
      particleMat.dispose();
      sprite.dispose();
      hotGeo.dispose();
      hotMat.dispose();
      renderer.dispose();
    };
  }, [vmState, intensity]);

  return (
    <div
      className={`relative w-full h-full min-h-[220px] overflow-hidden rounded-2xl surface ${className}`}
      aria-hidden="true"
    >
      {failed ? (
        <div className="absolute inset-0 bg-aurora bg-grid" />
      ) : (
        <div ref={mountRef} className="absolute inset-0 pointer-events-none" />
      )}
      {caption ? <div className="absolute inset-x-0 bottom-0 p-3">{caption}</div> : null}
    </div>
  );
};
