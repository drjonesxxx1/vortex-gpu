import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

type CanvasState = 'off' | 'booting' | 'running' | 'stopping' | 'suspended';

interface CyberCanvasProps {
  vmState: CanvasState;
  /** Drives rotation speed only. Purely decorative — never rendered as a number. */
  intensity?: number;
  /** Optional caption rendered over the scene (real data only, please). */
  caption?: React.ReactNode;
  className?: string;
}

// State-driven palette: edge colour, white-hot core colour, base spin speed, particle opacity.
const COLORS: Record<CanvasState, { edge: number; core: number; speed: number; opacity: number }> = {
  running:   { edge: 0x22d3ee, core: 0xffffff, speed: 1.0,  opacity: 0.8 },
  booting:   { edge: 0xfbbf24, core: 0xfff7e0, speed: 0.55, opacity: 0.7 },
  stopping:  { edge: 0xfbbf24, core: 0xffe0c0, speed: 0.3,  opacity: 0.55 },
  suspended: { edge: 0x64748b, core: 0xcbd5e1, speed: 0.18, opacity: 0.45 },
  off:       { edge: 0x445566, core: 0x8899aa, speed: 0.08, opacity: 0.35 },
};

const PARTICLE_COUNT = 9000;

interface VortexParticle {
  radius: number;
  angle: number;
  y: number;
  angularBase: number;
  size: number;
  phase: number;
  mix: number;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Decorative WebGL centrepiece for the hero.
 *
 * Accessibility / performance contract (preserved from the previous build):
 *  - aria-hidden: it carries no information a screen reader needs.
 *  - prefers-reduced-motion: renders exactly one still frame, no rAF loop.
 *  - pauses entirely while the tab is hidden or the element is off-screen.
 *  - if WebGL context creation fails, falls back to a static CSS treatment.
 */
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
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    camera.position.set(0, 2.2, 7.5);
    camera.lookAt(0, 0, 0);

    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    container.appendChild(renderer.domElement);

    // Post-processing bloom for the glow.
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.8, 0.5, 0.55);
    bloom.threshold = 0.3;
    bloom.strength = 0.6;
    bloom.radius = 0.5;
    composer.addPass(bloom);

    const state = COLORS[vmState] ?? COLORS.off;

    // ---- Build the physics-driven particle vortex ----
    const particles: VortexParticle[] = [];
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const sizes = new Float32Array(PARTICLE_COUNT);
    const mixes = new Float32Array(PARTICLE_COUNT);
    const phases = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Bias radius toward the core so the vortex reads dense and energetic.
      const radius = 0.35 + Math.pow(Math.random(), 0.55) * 6.4;
      const angle = Math.random() * Math.PI * 2;
      const y = (Math.random() - 0.5) * 3.2;
      const angularBase = 0.5 + Math.random() * 0.6;
      const size = 0.04 + Math.random() * 0.09;
      const phase = Math.random();
      const mix = Math.max(0, Math.min(1, 1 - (radius - 0.35) / 6.4));

      particles.push({ radius, angle, y, angularBase, size, phase, mix });
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(angle) * radius;
      sizes[i] = size;
      mixes[i] = mix;
      phases[i] = phase;
    }

    const particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    particleGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    particleGeo.setAttribute('aMix', new THREE.BufferAttribute(mixes, 1));
    particleGeo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

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
        attribute float aPhase;
        varying float vMix;
        varying float vPhase;
        void main() {
          vMix = aMix;
          vPhase = aPhase;
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
        varying float vPhase;
        void main() {
          vec2 uv = gl_PointCoord - vec2(0.5);
          float d = length(uv) * 2.0;
          if (d > 1.0) discard;
          float glow = pow(1.0 - d, 2.0);
          float twinkle = 0.85 + 0.15 * sin(vPhase * 6.28318);
          vec3 color = mix(uEdgeColor, uCoreColor, vMix);
          float intensity = 0.8 + vMix * 1.0;
          gl_FragColor = vec4(color * intensity, glow * uOpacity * twinkle);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const particleSystem = new THREE.Points(particleGeo, particleMat);
    scene.add(particleSystem);

    // ---- Central glowing core ----
    const coreGeo = new THREE.IcosahedronGeometry(0.42, 1);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);
    scene.add(coreMesh);

    const hotGeo = new THREE.IcosahedronGeometry(0.16, 0);
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
      // Pleasant off-axis still pose for reduced-motion / paused states.
      particleSystem.rotation.set(0, 0.6, 0);
      coreMesh.rotation.set(0.3, 0.4, 0);
      coreMesh.scale.setScalar(1.1);
      composer.render();
    };

    const animate = () => {
      frameId = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05);
      elapsed += dt;

      const clamp = Math.max(0, Math.min(100, intensity));
      const speed = state.speed * (1 + (clamp / 100) * 1.6);

      const pos = particleGeo.getAttribute('position') as THREE.BufferAttribute;
      const mixAttr = particleGeo.getAttribute('aMix') as THREE.BufferAttribute;

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const p = particles[i];
        // Angular velocity rises near the core — real vortex shear.
        p.angle += (p.angularBase / Math.pow(p.radius, 0.62)) * dt * speed;
        // Accretion: spiral inward, then recycle to the outer rim.
        p.radius -= 0.35 * dt * speed * (0.4 + p.mix);
        if (p.radius < 0.32) {
          p.radius = 5.6 + Math.random() * 0.9;
          p.angle = Math.random() * Math.PI * 2;
        }
        // Vertical undulation tied to orbit — gives the vortex 3D billow.
        p.y += Math.sin(elapsed * 1.4 + p.phase * 6.28318 + p.angle) * 0.006 * speed;
        p.y *= 0.998;

        const x = Math.cos(p.angle) * p.radius;
        const z = Math.sin(p.angle) * p.radius;
        pos.setXYZ(i, x, p.y, z);

        const newMix = Math.max(0, Math.min(1, 1 - (p.radius - 0.32) / 6.3));
        p.mix = newMix;
        mixAttr.setX(i, newMix);
      }
      pos.needsUpdate = true;
      mixAttr.needsUpdate = true;

      particleSystem.rotation.y += dt * 0.08;

      // Core pulse scales with intensity.
      const pulse = 1 + Math.sin(elapsed * 3.2) * 0.18 + (clamp / 100) * 0.3;
      coreMesh.scale.setScalar(pulse);
      hotMesh.scale.setScalar(1 + (clamp / 100) * 0.8 + Math.sin(elapsed * 6.0) * 0.12);
      coreMesh.rotation.x += dt * 0.6;
      coreMesh.rotation.y += dt * 0.9;
      coreMat.opacity = 0.35 + (state.opacity * 0.3);

      // Cinematic camera drift.
      camera.position.x = Math.sin(elapsed * 0.15) * 0.5;
      camera.position.y = 2.2 + Math.sin(elapsed * 0.2) * 0.3;
      camera.lookAt(0, 0, 0);

      composer.render();
    };

    const start = () => {
      if (running || still) return;
      running = true;
      clock.getDelta(); // discard the gap accumulated while paused
      animate();
    };
    const stop = () => {
      running = false;
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
    };

    renderOnce();
    let onScreen = true;

    // Only burn GPU cycles while the hero is actually visible.
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
      composer.setSize(w, h);
      if (!running) renderOnce();
    };
    window.addEventListener('resize', handleResize);

    // React live to the user toggling reduced motion at the OS level.
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
      coreGeo.dispose();
      coreMat.dispose();
      hotGeo.dispose();
      hotMat.dispose();
      bloom.dispose();
      composer.dispose();
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
