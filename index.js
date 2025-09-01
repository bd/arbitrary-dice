import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.165/build/three.module.js";

/** -------- Config -------- */
const MAX_SEEDS = 128;           // iOS uniform limit safety; keep ≤128
const DURATION_MS = 900;         // roll animation time
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const POLY_OFFSET = 0.9;         // d in n·x ≤ d  (smaller → chunkier polyhedron)
const EDGE_WIDTH = 0.01;         // visual line thickness (in scene units)

/** -------- DOM -------- */
const canvas  = document.getElementById("c");
const nsides  = document.getElementById("nsides");
const reseed  = document.getElementById("reseed");
const rollBtn = document.getElementById("roll");
const result  = document.getElementById("result");

/** -------- Three.js basics -------- */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 20);
camera.position.set(0, 0, 3);
camera.lookAt(0, 0, 0);

/** Directional light for simple lambert */
const lightDir = new THREE.Vector3(0.7, 0.9, 0.5).normalize();

/** -------- Fullscreen quad with analytic ray–polyhedron shader -------- */
const quad = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      seeds:    { value: new Array(MAX_SEEDS).fill(0).map(()=>new THREE.Vector3(1,0,0)) },
      count:    { value: 0 },
      offset:   { value: POLY_OFFSET },
      edgeW:    { value: EDGE_WIDTH },
      camPos:   { value: camera.position.clone() },
      camRight: { value: new THREE.Vector3() },
      camUp:    { value: new THREE.Vector3() },
      camDir:   { value: new THREE.Vector3() },
      fovTan:   { value: Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) },
      aspect:   { value: 1.0 },
      rot:      { value: new THREE.Matrix3() },   // model rotation (polyhedron orientation)
      lightDir: { value: lightDir.clone() }
    },
    vertexShader: /* glsl */`
      varying vec2 vXY; // clip-space [-1,1]
      void main() {
        vXY = position.xy;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      #define MAX_SEEDS ${MAX_SEEDS}
      uniform vec3 seeds[MAX_SEEDS];
      uniform int  count;
      uniform float offset; // plane offset d
      uniform float edgeW;

      uniform vec3 camPos, camRight, camUp, camDir;
      uniform float fovTan, aspect;
      uniform mat3 rot;
      uniform vec3 lightDir;

      varying vec2 vXY;

      // Hash → consistent pastel per index
      vec3 idxColor(int i){
        float x = fract(sin(float(i)*12.9898)*43758.5453);
        float y = fract(sin(float(i)*78.233 )*12345.6789);
        float z = fract(sin(float(i)* 3.1415)*98765.4321);
        return 0.6 + 0.4*vec3(x,y,z);
      }

      struct Hit { bool ok; float t; int faceIdx; vec3 normal; vec3 pos; };

      // Analytic ray vs convex polyhedron (intersection of half-spaces n·x <= d)
      Hit intersectPoly(vec3 ro, vec3 rd){
        float tNear = 0.0;
        float tFar  = 1e9;
        int enterIdx = -1;

        for (int i=0; i<MAX_SEEDS; ++i){
          if (i >= count) break;
          vec3 n = rot * seeds[i];
          float denom = dot(n, rd);
          float num   = offset - dot(n, ro);

          if (abs(denom) < 1e-6) {
            if (num < 0.0) return Hit(false, 0.0, -1, vec3(0.0), vec3(0.0)); // outside, parallel
            continue; // inside this halfspace already
          }

          float t = num / denom;
          if (denom < 0.0) {
            // entering through plane i
            if (t > tNear) { tNear = t; enterIdx = i; }
          } else {
            // exiting through plane i
            if (t < tFar) tFar = t;
          }
          if (tNear > tFar) return Hit(false, 0.0, -1, vec3(0.0), vec3(0.0));
        }

        if (enterIdx < 0 || tFar < 0.0) return Hit(false, 0.0, -1, vec3(0.0), vec3(0.0));
        float tHit = max(tNear, 0.0);
        vec3  p    = ro + rd * tHit;
        vec3  nHit = normalize(rot * seeds[enterIdx]);
        return Hit(true, tHit, enterIdx, nHit, p);
      }

      void main(){
        // Build ray from camera basis
        vec3 rdCam = normalize(vec3(vXY.x * aspect * fovTan, vXY.y * fovTan, -1.0));
        vec3 rd = normalize(rdCam.x * camRight + rdCam.y * camUp + rdCam.z * camDir);
        vec3 ro = camPos;

        Hit h = intersectPoly(ro, rd);
        if (!h.ok) { discard; } // background

        // Edge darkening: how close to another plane is the hit point?
        float minOther = 1e9;
        for (int i=0; i<MAX_SEEDS; ++i){
          if (i >= count) break;
          if (i == h.faceIdx) continue;
          float d = offset - dot(rot * seeds[i], h.pos); // >= 0 inside
          if (d < minOther) minOther = d;
        }
        float edgeMix = smoothstep(0.0, edgeW, minOther); // 0 at edge → dark

        // Flat lambert shading with a bit of rim
        float lambert = max(0.1, dot(normalize(lightDir), h.normal) * 0.9 + 0.1);
        float rim = pow(1.0 - max(0.0, dot(-rd, h.normal)), 2.0) * 0.25;

        vec3 base = idxColor(h.faceIdx);
        vec3 color = mix(vec3(0.07), base * lambert + rim, edgeMix);

        gl_FragColor = vec4(color, 1.0);
      }`
  })
);
scene.add(quad);

/** -------- Camera basis uniforms -------- */
function updateCameraUniforms() {
  const u = quad.material.uniforms;
  u.camPos.value.copy(camera.position);
  const q = camera.quaternion;
  u.camRight.value.set(1,0,0).applyQuaternion(q);
  u.camUp.value.set(0,1,0).applyQuaternion(q);
  u.camDir.value.set(0,0,-1).applyQuaternion(q);
  u.aspect.value = renderer.domElement.width / renderer.domElement.height;
  u.fovTan.value = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
}

/** -------- Seeds (Fibonacci lattice) -------- */
function fibonacciSeeds(n){
  const out = [];
  for (let i=0; i<n; i++){
    const t = (i + 0.5) / n;
    const z = 1.0 - 2.0 * t;
    const r = Math.sqrt(Math.max(0.0, 1.0 - z*z));
    const phi = i * GOLDEN_ANGLE;
    out.push(new THREE.Vector3(Math.cos(phi)*r, z, Math.sin(phi)*r).normalize());
  }
  return out;
}

function setSeeds(n){
  n = Math.max(3, Math.min(MAX_SEEDS, n|0));
  const pts = fibonacciSeeds(n);
  const u = quad.material.uniforms;
  for (let i=0; i<MAX_SEEDS; i++) u.seeds.value[i].set(1,0,0);
  for (let i=0; i<n; i++) u.seeds.value[i].copy(pts[i]);
  u.count.value = n;
  quad.userData.seedDirs = pts;
}

/** -------- Roll animation (quaternion slerp each frame) -------- */
let rotQ = new THREE.Quaternion();               // current orientation
let anim  = null;                                 // {startQ,endQ,startTime,dur}
const zWorld = new THREE.Vector3(0,0,1);         // camera forward is -Z; we want face normal → +Z to face camera

function applyRotationUniform(){
  const m3 = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(rotQ));
  quad.material.uniforms.rot.value.copy(m3);
}

function rollTo(idx){
  const dirs = quad.userData.seedDirs;
  if (!dirs || !dirs.length) return;

  idx = ((idx|0)%dirs.length + dirs.length) % dirs.length;

  // Current world normal of that face (after rotQ)
  const nWorld = dirs[idx].clone().applyQuaternion(rotQ).normalize();

  // We want nWorld → +Z (so the face is perpendicular to view direction)
  const delta = new THREE.Quaternion().setFromUnitVectors(nWorld, zWorld);

  const startQ = rotQ.clone();
  const endQ   = delta.multiply(startQ);

  anim = { startQ, endQ, startTime: performance.now(), dur: DURATION_MS };
  result.textContent = `Result: ${idx+1} / d${dirs.length}`;
}

function randomRoll(){
  const n = quad.material.uniforms.count.value|0;
  const idx = (Math.random()*n)|0;
  rollTo(idx);
}

/** -------- UI -------- */
reseed.onclick = () => { setSeeds(parseInt(nsides.value,10)||13); result.textContent = "–"; };
rollBtn.onclick = randomRoll;
document.addEventListener("keydown", e => { if (e.key === " ") randomRoll(); });

/** -------- Resize -------- */
function resize(){
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  updateCameraUniforms();
}
window.addEventListener("resize", resize);

/** -------- Render loop -------- */
function render(){
  // Animate orientation
  if (anim){
    const t = Math.min(1, (performance.now() - anim.startTime)/anim.dur);
    // ease-out cubic
    const tt = 1 - Math.pow(1 - t, 3);
    rotQ.copy(anim.startQ).slerp(anim.endQ, tt);
    applyRotationUniform();
    if (t >= 1) anim = null;
  }
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(render);

/** -------- Boot -------- */
setSeeds(parseInt(nsides.value,10) || 13);
applyRotationUniform();
resize();

/** -------- PWA (optional) -------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js").catch(()=>{});
