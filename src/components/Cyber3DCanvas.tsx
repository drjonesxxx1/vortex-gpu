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
  running:   { edge: 0x22d3ee, core: 0xffffff, speed: 1.0,  opacity: 0.85 },
  booting:   { edge: 0xfbbf24, core: 0xfff7e0, speed: 0.55, opacity: 0.75 },
  stopping:  { edge: 0xfbbf24, core: 0xffe0c0, speed: 0.3,  opacity: 0.6 },
  suspended: { edge: 0x64748b, core: 0xcbd5e1, speed: 0.18, opacity: 0.5 },
  off:       { edge: 0x445566, core: 0x8899aa, speed: 0.08, opacity: 0.4 },
};

const PARTICLE_COUNT = 11000;
const ARM_COUNT = 3;
const TWIST = 1.35;      // radians per unit radius — how tightly the arms wind
const MAX_RADIUS = 6.2;

interface Star {
  radius: number;
  angle: number;
  y: number;
  omega: number;   // angular velocity (differential — inner spins faster)
  size: number;
  mix: number;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
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
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch {
      setFailed(true);
      return;
    }

    const width = container.clientWidth || 320;
    const height = container.clientHeight || 320;

    const scene = new THREE.Scene();
    // Near-top-down camera so the spiral arms read clearly as a vortex.
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    camera.position.set(0, 8.2, 3.6);
    camera.lookAt(0, 0, 0);

    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    container.appendChild(renderer.domElement);

    const state = COLORS[vmState] ?? COLORS.off;

    // ---- Spiral-galaxy particle field ----
    const stars: Star[] = [];
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const sizes = new Float32Array(PARTICLE_COUNT);
    const mixes = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const arm = i % ARM_COUNT;
      const armOffset = (arm / ARM_COUNT) * Math.PI * 2;
      // Logarithmic spiral: angle winds with radius. Mild centre bias, no ring.
      const radius = 0.5 + Math.pow(Math.random(), 0.7) * (MAX_RADIUS - 0.5);
      const angle = armOffset + radius * TWIST + (Math.random() - 0.5) * 0.7;
      const y = (Math.random() - 0.5) * 1.1;
      // Differential rotation — inner orbits faster (this is what winds a galaxy).
      const omega = 1.1 / Math.pow(radius, 0.55);
      const size = 0.035 + Math.random() * 0.08;
      const mix = Math.max(0, Math.min(1, 1 - (radius - 0.5) / (MAX_RADIUS - 0.5)));

      stars.push({ radius, angle, y, omega, size, mix });
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(angle) * radius;
      sizes[i] = size;
      mixes[i] = mix;
    }

    const particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    particleGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    particleGeo.setAttribute('aMix', new THREE.BufferAttribute(mixes, 1));

    const particleMat = new THREE.ShaderMaterial({
      uniforms: {
        uEdgeColor: { value: new THREE.Color(state.edge) },
        uCoreColor: { value: new THREE.Color(state.core) },
        uOpacity: { value: state.opacity },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aMix;
        varying float vMix;
        void main() {
          vMix = aMix;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uPixelRatio * (300.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uEdgeColor;
        uniform vec3 uCoreColor;
        uniform float uOpacity;
        varying float vMix;
        void main() {
          vec2 uv = gl_PointCoord - vec2(0.5);
          float d = length(uv) * 2.0;
          if (d > 1.0) discard;
          float glow = pow(1.0 - d, 2.0);
          vec3 color = mix(uEdgeColor, uCoreColor, vMix);
          float intensity = 0.75 + vMix * 0.9;
          gl_FragColor = vec4(color * intensity, glow * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const particleSystem = new THREE.Points(particleGeo, particleMat);
    scene.add(particleSystem);

    // Central bright core.
    const hotGeo = new THREE.IcosahedronGeometry(0.22, 1);
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
        // Differential rotation: each star orbits at its own angular speed.
        s.angle += s.omega * dt * speed;
        const x = Math.cos(s.angle) * s.radius;
        const z = Math.sin(s.angle) * s.radius;
        pos.setXYZ(i, x, s.y, z);
      }
      pos.needsUpdate = true;

      // Core pulse.
      hotMesh.scale.setScalar(1 + (clamp / 100) * 0.5 + Math.sin(elapsed * 4.0) * 0.12);
      hotMesh.rotation.x += dt * 0.5;
      hotMesh.rotation.y += dt * 0.8;

      // Slow cinematic sway.
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
