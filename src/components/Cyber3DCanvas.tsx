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

const COLORS: Record<CanvasState, number> = {
  running: 0x22d3ee,
  booting: 0xfbbf24,
  stopping: 0xfbbf24,
  suspended: 0x64748b,
  off: 0x445566,
};

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
 * Accessibility / performance contract:
 *  - aria-hidden: it carries no information a screen reader needs.
 *  - prefers-reduced-motion: renders exactly one still frame, no rAF loop.
 *  - pauses entirely while the tab is hidden or the element is off-screen.
 *  - if WebGL context creation fails, falls back to a static CSS treatment
 *    rather than an empty box.
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
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      setFailed(true);
      return;
    }

    const width = container.clientWidth || 320;
    const height = container.clientHeight || 320;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(0, 3, 6);
    camera.lookAt(0, 0, 0);

    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.setAttribute('aria-hidden', 'true');
    container.appendChild(renderer.domElement);

    const activeColor = COLORS[vmState] ?? COLORS.off;

    const gridHelper = new THREE.GridHelper(10, 20, activeColor, 0x101623);
    gridHelper.position.y = -1;
    (gridHelper.material as THREE.Material).transparent = true;
    (gridHelper.material as THREE.Material).opacity = 0.45;
    scene.add(gridHelper);

    const geometry = new THREE.BoxGeometry(1.6, 1.6, 1.6);
    const wireframeGeo = new THREE.WireframeGeometry(geometry);
    const lineMaterial = new THREE.LineBasicMaterial({ color: activeColor, transparent: true, opacity: 0.9 });
    const cubeWireframe = new THREE.LineSegments(wireframeGeo, lineMaterial);
    scene.add(cubeWireframe);

    const coreGeo = new THREE.IcosahedronGeometry(0.7, 2);
    const coreMat = new THREE.MeshBasicMaterial({
      color: activeColor,
      wireframe: true,
      transparent: true,
      opacity: vmState === 'off' ? 0.2 : 0.7,
    });
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);
    scene.add(coreMesh);

    const particleCount = 60;
    const particlesGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      const angle = (i / particleCount) * Math.PI * 2;
      const radius = 2.2;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 0.4;
      positions[i * 3 + 2] = Math.sin(angle) * radius;
    }
    particlesGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const particleMat = new THREE.PointsMaterial({ color: activeColor, size: 0.08, transparent: true, opacity: 0.75 });
    const particleSystem = new THREE.Points(particlesGeo, particleMat);
    scene.add(particleSystem);

    const clock = new THREE.Clock();
    let frameId = 0;
    let running = false;

    const renderOnce = () => {
      // Give the still frame a pleasant off-axis pose rather than a flat square.
      cubeWireframe.rotation.set(0.42, 0.62, 0);
      coreMesh.rotation.set(0, 0.3, 0);
      renderer.render(scene, camera);
    };

    const animate = () => {
      frameId = requestAnimationFrame(animate);
      const delta = clock.getDelta();
      const speed = vmState === 'running' ? 0.6 + (Math.max(0, Math.min(100, intensity)) / 100) * 1.4 : 0.2;
      cubeWireframe.rotation.x += delta * speed * 0.4;
      cubeWireframe.rotation.y += delta * speed;
      coreMesh.rotation.y -= delta * speed * 0.8;
      particleSystem.rotation.y += delta * speed * 0.3;
      renderer.render(scene, camera);
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
      geometry.dispose();
      wireframeGeo.dispose();
      lineMaterial.dispose();
      coreGeo.dispose();
      coreMat.dispose();
      particlesGeo.dispose();
      particleMat.dispose();
      gridHelper.dispose();
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
