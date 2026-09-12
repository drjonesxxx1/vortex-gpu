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
  running:   { edge: 0x22d3ee, core: 0xffffff, speed: 1.0,  opacity: 0.9 },
  booting:   { edge: 0xfbbf24, core: 0xfff7e0, speed: 0.55, opacity: 0.8 },
  stopping:  { edge: 0xfbbf24, core: 0xffe0c0, speed: 0.3,  opacity: 0.65 },
  suspended: { edge: 0x64748b, core: 0xcbd5e1, speed: 0.18, opacity: 0.55 },
  off:       { edge: 0x445566, core: 0x8899aa, speed: 0.08, opacity: 0.45 },
};

const PARTICLE_COUNT = 9000;
const ARM_COUNT = 3;
const TWIST = 1.35;
const MAX_RADIUS = 6.2;

interface Star {
  radius: number;
  angle: number;
  y: number;
  omega: number;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Soft radial-gradient sprite so particles render smooth, not aliased/sparkly. */
function makeSprite(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.35)');
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
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    camera.position.set(0, 8.2, 3.6);
    camera.lookAt(0, 0, 0);

    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    container.appendChild(renderer.domElement);

    const state = COLORS[vmState] ?? COLORS.off;
    const sprite = makeSprite();

    // ---- Spiral-galaxy particle field ----
    const stars: Star[] = [];
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const colors = new Float32Array(PARTICLE_COUNT * 3);
    const edgeColor = new THREE.Color(state.edge);
    const coreColor = new THREE.Color(state.core);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const arm = i % ARM_COUNT;
      const armOffset = (arm / ARM_COUNT) * Math.PI * 2;
      const radius = 0.5 + Math.pow(Math.random(), 0.7) * (MAX_RADIUS - 0.5);
      const angle = armOffset + radius * TWIST + (Math.random() - 0.5) * 0.7;
      const y = (Math.random() - 0.5) * 1.1;
      const omega = 1.1 / Math.pow(radius, 0.55);
      const mix = Math.max(0, Math.min(1, 1 - (radius - 0.5) / (MAX_RADIUS - 0.5)));

      stars.push({ radius, angle, y, omega });
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(angle) * radius;

      const c = edgeColor.clone().lerp(coreColor, mix);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    const particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    particleGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const particleMat = new THREE.PointsMaterial({
      size: 0.22,
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
    const hotGeo = new THREE.IcosahedronGeometry(0.24, 1);
    const hotMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
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
      const speed = state.speed * (1 + (clamp / 100) * 1.4);

      const pos = particleGeo.getAttribute('position') as THREE.BufferAttribute;

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const s = stars[i];
        s.angle += s.omega * dt * speed;
        pos.setXYZ(i, Math.cos(s.angle) * s.radius, s.y, Math.sin(s.angle) * s.radius);
      }
      pos.needsUpdate = true;

      hotMesh.scale.setScalar(1 + (clamp / 100) * 0.5 + Math.sin(elapsed * 4.0) * 0.12);
      hotMesh.rotation.x += dt * 0.5;
      hotMesh.rotation.y += dt * 0.8;

      camera.position.x = Math.sin(elapsed * 0.12) * 1.2;
      camera.lookAt(0, 0, 0);

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
