// Interactive 3D circuit view: the track is built from real geographic outline
// + elevation (baked into circuits.geojson from an open topography API), not
// from car telemetry. The user can orbit (tilt), zoom and pan it.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { LngLat } from "../circuits";

const EXAGG = 7; // elevation exaggeration so topography is visible
const FIT = 100; // target half-extent of the track in scene units

export interface Highlight {
  /** Lap fraction [0,1] where a yellow/double-yellow zone begins / ends. */
  start: number;
  end: number;
  double: boolean;
}

/** Project geo + elevation points into centered, isotropic scene coordinates
 *  (XZ ground plane, Y up), scaled to a consistent size. */
function toScene(circuit: LngLat[]): THREE.Vector3[] {
  const lats = circuit.map((c) => c[1]);
  const lngs = circuit.map((c) => c[0]);
  const elevs = circuit.map((c) => c[2] ?? 0);
  const lat0 = lats.reduce((a, b) => a + b, 0) / lats.length;
  const lng0 = lngs.reduce((a, b) => a + b, 0) / lngs.length;
  const eMin = Math.min(...elevs);
  const mLat = 111320;
  const mLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const raw = circuit.map((c) => ({
    x: (c[0] - lng0) * mLng,
    z: -(c[1] - lat0) * mLat,
    y: ((c[2] ?? 0) - eMin) * EXAGG,
  }));
  const ext = Math.max(...raw.map((p) => Math.max(Math.abs(p.x), Math.abs(p.z)))) || 1;
  const s = FIT / ext;
  return raw.map((p) => new THREE.Vector3(p.x * s, p.y * s, p.z * s));
}

export default function Track3D({ circuit, highlights }: { circuit: LngLat[]; highlights: Highlight[] }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const api = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    curve: THREE.CatmullRomCurve3;
    hi: THREE.Mesh[];
  } | null>(null);

  // Build the scene once per circuit.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !circuit || circuit.length < 4) return;

    const pts = toScene(circuit);
    const scene = new THREE.Scene();
    const w = mount.clientWidth || 400;
    const h = mount.clientHeight || 300;

    const camera = new THREE.PerspectiveCamera(50, w / h, 1, 5000);
    camera.position.set(FIT * 1.1, FIT * 1.2, FIT * 1.6);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(1, 2, 1);
    scene.add(dir);

    // Ground reference grid.
    const grid = new THREE.GridHelper(FIT * 3, 30, 0x2a3340, 0x1c242e);
    (grid.material as THREE.Material).opacity = 0.4;
    (grid.material as THREE.Material).transparent = true;
    scene.add(grid);

    // Track ribbon.
    const curve = new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.3);
    const tube = new THREE.TubeGeometry(curve, Math.max(200, pts.length * 3), FIT * 0.012, 10, true);
    const mat = new THREE.MeshStandardMaterial({ color: 0x5ec8e0, roughness: 0.55, metalness: 0.1 });
    scene.add(new THREE.Mesh(tube, mat));

    // Start/finish gate: a white bar across the track at the first point.
    const sp = pts[0];
    const tangent = new THREE.Vector3().subVectors(pts[1] ?? pts[0], sp).setY(0).normalize();
    const gateGeo = new THREE.BoxGeometry(FIT * 0.085, FIT * 0.014, FIT * 0.02);
    const gate = new THREE.Mesh(
      gateGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 0.3 }),
    );
    gate.position.copy(sp).add(new THREE.Vector3(0, FIT * 0.018, 0));
    gate.lookAt(gate.position.clone().add(tangent)); // local Z ∥ tangent → X spans across track
    scene.add(gate);

    // Faint posts from the track down to the ground to read elevation.
    const postPts: THREE.Vector3[] = [];
    const step = Math.max(1, Math.floor(pts.length / 60));
    for (let i = 0; i < pts.length; i += step) {
      postPts.push(pts[i].clone(), new THREE.Vector3(pts[i].x, 0, pts[i].z));
    }
    const postGeo = new THREE.BufferGeometry().setFromPoints(postPts);
    scene.add(new THREE.LineSegments(postGeo, new THREE.LineBasicMaterial({ color: 0x4a5565, transparent: true, opacity: 0.5 })));

    api.current = { renderer, scene, curve, hi: [] };

    let raf = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    const ro = new ResizeObserver(() => {
      const nw = mount.clientWidth || w;
      const nh = mount.clientHeight || h;
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    });
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      tube.dispose();
      gateGeo.dispose();
      postGeo.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      api.current = null;
    };
  }, [circuit]);

  // Update the yellow-flag highlights without rebuilding the scene.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    for (const m of a.hi) {
      a.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    a.hi = [];
    const n = 48;
    for (const h of highlights) {
      const span = Math.max(0, h.end - h.start);
      if (span <= 0) continue;
      const seg: THREE.Vector3[] = [];
      for (let i = 0; i <= n; i++) {
        let t = h.start + (span * i) / n;
        if (t > 1) t -= 1;
        seg.push(a.curve.getPointAt(t < 0 ? t + 1 : t));
      }
      const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(seg), n * 2, FIT * 0.022, 10, false);
      const color = h.double ? 0xffcf2e : 0xffe14d;
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.7, roughness: 0.4 }),
      );
      a.scene.add(mesh);
      a.hi.push(mesh);
    }
  }, [highlights]);

  return <div ref={mountRef} className="track3d" />;
}
