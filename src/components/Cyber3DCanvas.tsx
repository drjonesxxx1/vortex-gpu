import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

interface CyberCanvasProps {
  vmState: 'off' | 'booting' | 'running' | 'stopping' | 'suspended';
  gpuLoad: number;
}

export const Cyber3DCanvas: React.FC<CyberCanvasProps> = ({ vmState, gpuLoad }) => {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 300;
    const height = container.clientHeight || 300;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(0, 3, 6);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Cyber grid
    const gridHelper = new THREE.GridHelper(10, 20, 0x00ffcc, 0x112233);
    gridHelper.position.y = -1;
    scene.add(gridHelper);

    // Cyber GPU Core Cube
    const geometry = new THREE.BoxGeometry(1.6, 1.6, 1.6);
    const wireframeGeo = new THREE.WireframeGeometry(geometry);
    
    // Custom material
    let activeColor = 0x00ffcc; // default cyan
    if (vmState === 'running') activeColor = 0x00ff66; // green
    else if (vmState === 'booting') activeColor = 0xffaa00; // amber
    else if (vmState === 'off') activeColor = 0x445566; // dim dark

    const lineMaterial = new THREE.LineBasicMaterial({
      color: activeColor,
      linewidth: 2,
    });
    const cubeWireframe = new THREE.LineSegments(wireframeGeo, lineMaterial);
    scene.add(cubeWireframe);

    // Inner glowing core
    const coreGeo = new THREE.IcosahedronGeometry(0.7, 2);
    const coreMat = new THREE.MeshBasicMaterial({
      color: activeColor,
      wireframe: true,
      transparent: true,
      opacity: vmState === 'off' ? 0.2 : 0.8,
    });
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);
    scene.add(coreMesh);

    // Particle ring
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
    const particleMat = new THREE.PointsMaterial({
      color: activeColor,
      size: 0.08,
      transparent: true,
      opacity: 0.8,
    });
    const particleSystem = new THREE.Points(particlesGeo, particleMat);
    scene.add(particleSystem);

    let animationFrameId: number;
    let clock = new THREE.Clock();

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      const delta = clock.getDelta();
      const speed = vmState === 'running' ? 0.8 + (gpuLoad / 100) * 2 : 0.2;

      cubeWireframe.rotation.x += delta * speed * 0.5;
      cubeWireframe.rotation.y += delta * speed;

      coreMesh.rotation.y -= delta * speed * 0.8;
      particleSystem.rotation.y += delta * speed * 0.3;

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      geometry.dispose();
      wireframeGeo.dispose();
      lineMaterial.dispose();
      coreGeo.dispose();
      coreMat.dispose();
      particlesGeo.dispose();
      particleMat.dispose();
      renderer.dispose();
    };
  }, [vmState, gpuLoad]);

  return (
    <div className="relative w-full h-full min-h-[220px] flex items-center justify-center bg-zinc-950/80 rounded-xl border border-cyan-500/20 overflow-hidden shadow-inner">
      <div ref={mountRef} className="w-full h-full absolute inset-0 pointer-events-none" />
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2 bg-black/60 backdrop-blur-md px-2.5 py-1 rounded border border-cyan-500/30 text-[10px] font-mono text-cyan-400">
        <span className={`w-2 h-2 rounded-full ${
          vmState === 'running' ? 'bg-emerald-400 animate-ping' :
          vmState === 'booting' ? 'bg-amber-400 animate-pulse' : 'bg-zinc-600'
        }`} />
        <span className="uppercase tracking-widest font-bold">{vmState}</span>
      </div>
      <div className="absolute bottom-3 right-3 z-10 text-[10px] font-mono text-cyan-300/80 bg-black/60 px-2 py-1 rounded border border-cyan-500/20">
        GPU LOAD: <span className="text-emerald-400 font-bold">{gpuLoad}%</span>
      </div>
    </div>
  );
};
