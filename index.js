// index.js
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.165/build/three.module.js";

/* ---------------- Config ---------------- */
const MAX_SEEDS = 256;          // increase if you later switch to textures/SSBOs
const DURATION_MS = 1000;       // roll duration
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/* ---------------- DOM refs ---------------- */
const canvas = document.getElementById("c");
const nsides = document.getElementById("nsides");
const reseedBtn = document.getElementById("reseed");
const rollBtn = document.getElementById("roll");
const result = document.getElementById("result");

/* ---------------- Renderer/Scene/Camera ---------------- */
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 10);
camera.position.set(0, 0, 2);

/* ---------------- Lights ---------------- */
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(5, 3, 2);
scene.add(dir, new THREE.AmbientLight(0xffffff, 0.4));

/* ---------------- Voronoi-Shaded Sphere ---------------- */
const sphere = new THREE.Mesh(
  new THREE.SphereGeometry(0.85, 256, 192),
  new THREE.ShaderMaterial({
    uniforms: {
      seeds: { value: new Array(MAX_SEEDS).fill(0).map(() => new THREE.Vector3(1, 0, 0)) },
      count: { value: 0 },
      edge:  { value: 0.02 }, // edge width (smaller = thicker lines)
    },
    vertexShader: `
      varying vec3 vN;
      void main() {
        vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      #define MAX_SEEDS ${MAX_SEEDS}
      uniform vec3  seeds[MAX_SEEDS];
      uniform int   count;
      uniform float edge;
      varying vec3  vN;

      vec3 idxColor(int i) {
        float x = fract(sin(float(i)*12.9898)*43758.5453);
        float y = fract(sin(float(i)*78.233 )*12345.6789);
        float z = fract(sin(float(i)* 3.1415)*98765.4321);
        vec3 c = vec3(x,y,z);
        return 0.6 + 0.4*c;
      }

      void main() {
        vec3 n = normalize(vN);
        float bestDot = -1.0;
        int   bestIdx = 0;
        float secondDot = -1.0;

        for (int i=0; i<MAX_SEEDS; ++i) {
          if (i >= count) break;
          float d = dot(n, normalize(seeds[i]));
          if (d > bestDot) {
            secondDot = bestDot;
            bestDot = d; bestIdx = i;
          } else if (d > secondDot) {
            secondDot = d;
          }
        }

        // edgeMix -> 0 near borders (dark), 1 inside cell (color)
        float edgeMix = smoothstep(0.0, edge, (bestDot - secondDot));
        vec3 color = mix(vec3(0.05), idxColor(bestIdx), edgeMix);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
    // NOTE: don't add flatShading here; it's not a ShaderMaterial prop
  })
);
scene.add(sphere);

/* ---------------- Seeds (Fibonacci lattice) ---------------- */
function fibonacciSeeds(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const z = 1.0 - 2.0 * t;
    const r = Math.sqrt(Math.max(0.0, 1.0 - z * z));
    const phi = i * GOLDEN_ANGLE;
    out.push(new THREE.Vector3(Math.cos(phi) * r, z, Math.sin(phi) * r).normalize());
  }
  return out;
}

function setSeeds(n) {
  n = Math.max(3, Math.min(MAX_SEEDS, n | 0));
  const pts = fibonacciSeeds(n);
  const u = sphere.material.uniforms;
  for (let i = 0; i < MAX_SEEDS; i++) u.seeds.value[i].set(1, 0, 0);
  for (let i = 0; i < n; i++) u.seeds.value[i].copy(pts[i]);
  u.count.value = n;
  sphere.userData.seedDirs = pts;
}

/* ---------------- Roll animation ---------------- */
let anim = null;

function rollTo(idx) {
  const dirs = sphere.userData.seedDirs;
  if (!dirs || !dirs.length) return;

  idx = ((idx | 0) % dirs.length + dirs.length) % dirs.length;
  const targetDir = dirs[idx].clone();

  // Transform targetDir by current orientation → world space
  const worldDir = targetDir.applyQuaternion(sphere.quaternion).normalize();
  const z = new THREE.Vector3(0, 0, 1);

  // Quaternion that maps worldDir → +Z
  const delta = new THREE.Quaternion().setFromUnitVectors(worldDir, z);

  const start = sphere.quaternion.clone();
  const end = delta.multiply(start);

  const startTime = performance.now();
  const dur = DURATION_MS;
  cancelAnimationFrame(anim?.rafId);
  anim = { rafId: 0 };

  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  const tick = () => {
    const now = performance.now();
    let t = Math.min(1, (now - startTime) / dur);
    t = easeOutCubic(t);

    // Instance slerp
    sphere.quaternion.copy(start.clone().slerp(end, t));

    if (t < 1) {
      anim.rafId = requestAnimationFrame(tick);
    }
  };
  tick();

  setTimeout(() => {
    result.textContent = `Result: ${idx + 1} / d${dirs.length}`;
  }, dur * 0.9);
}

function randomRoll() {
  const n = sphere.material.uniforms.count.value | 0;
  const idx = (Math.random() * n) | 0;
  rollTo(idx);
}

/* ---------------- UI wiring ---------------- */
reseedBtn.onclick = () => {
  setSeeds(parseInt(nsides.value, 10) || 37);
  result.textContent = "–";
};
rollBtn.onclick = randomRoll;
document.addEventListener("keydown", (e) => { if (e.key === " ") randomRoll(); });

/* ---------------- Fullscreen + Wake Lock (best-effort) ---------------- */
let lastTap = 0;
document.addEventListener("touchend", () => {
  const now = performance.now();
  if (now - lastTap < 300) document.documentElement.requestFullscreen?.();
  lastTap = now;
});

let wl;
navigator.wakeLock?.request("screen").then((lock) => (wl = lock)).catch(() => {});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && navigator.wakeLock && !wl) {
    navigator.wakeLock.request("screen").then((lock) => (wl = lock)).catch(() => {});
  }
});

/* ---------------- Resize ---------------- */
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);

/* ---------------- Boot ---------------- */
setSeeds(parseInt(nsides.value, 10) || 37);
resize();
renderer.setAnimationLoop(() => renderer.render(scene, camera));

/* ---------------- Service worker ---------------- */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js").catch(() => {});
}
