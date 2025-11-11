// main.js
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

/** ========= CONFIG ========= */
const WORLD_SIZE = 260;           // tamaño del mundo (plano)
const TERRAIN_RES = 256;          // subdivisiones del terreno
const TERRAIN_MAX_H = 2.6;        // altura máxima (relieve)
const TREE_COUNT = 520;           // número de árboles
const PUMPKIN_COUNT = 56;         // número de calabazas
const PLAYER_RADIUS = 0.35;       // colisión "cuerpo" del jugador
const OBJ_TREE_R = 0.6;           // radio aproximado tronco/copa inferior
const OBJ_PUMP_R = 0.45;          // radio calabaza
const FOG_DENSITY = 0.028;
const VR_WALK_SPEED = 5.5;        // velocidad (ajustada)
const VR_STRAFE_SPEED = 4.8;
const ARC_STEPS = 40;             // puntos arco teleport
const ARC_SPEED = 7.5;            // velocidad inicial arco
const ARC_GRAVITY = 9.8;          // gravedad arco
const MAX_SLOPE_DEG = 45;         // pendiente máxima para aterrizar
const WORLD_RADIUS = WORLD_SIZE * 0.5 - 1.0; // límite jugable
const HDRI_LOCAL = 'assets/hdr/moonless_golf_1k.hdr';
const HDRI_FALLBACK = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/moonless_golf_1k.hdr';

// Distribución visible de calabazas/tumbas
const PUMPKIN_AREA = 80; // radio de distribución para asegurar visibilidad

/** ========= DOM / UI ========= */
const hudTotal = document.getElementById('totalPumpkins');
const hudHit   = document.getElementById('hitPumpkins');

/** ========= RENDERER / SCENE / CAMERA ========= */
const canvas = document.getElementById('scene');
const ambientEl = document.getElementById('ambient');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x06101a);
scene.fog = new THREE.FogExp2(0x06101a, FOG_DENSITY);

// Player (grupo) + cámara
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 400);
const player = new THREE.Group();
player.position.set(0, 1.6, 3);
player.add(camera);
scene.add(player);

/** ========= IBL / HDRI ========= */
const pmremGen = new THREE.PMREMGenerator(renderer);
pmremGen.compileEquirectangularShader();

async function setHDRI(url) {
  const tex = await new Promise((res, rej) => new RGBELoader().load(url, (t)=>res(t), undefined, rej));
  const env = pmremGen.fromEquirectangular(tex).texture;
  scene.environment = env;
  tex.dispose();
  pmremGen.dispose();
}
setHDRI(HDRI_LOCAL).catch(() => setHDRI(HDRI_FALLBACK).catch(e => console.warn('Sin HDRI (fallback también falló):', e)));

/** ========= ILUMINACIÓN ========= */
const hemiLight = new THREE.HemisphereLight(0x8fb2ff, 0x0a0c10, 0.35);
scene.add(hemiLight);

/** ========= CIELO ESTRELLADO + LUNA ========= */
const skyGeo = new THREE.SphereGeometry(1200, 48, 24);
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    topColor:      { value: new THREE.Color(0x0a1f35) },
    bottomColor:   { value: new THREE.Color(0x050910) },
    starIntensity: { value: 1.8 }
  },
  vertexShader: /* glsl */`
    varying vec3 vDir;
    void main(){
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    varying vec3 vDir;
    uniform vec3 topColor;
    uniform vec3 bottomColor;
    uniform float starIntensity;

    float hash(vec3 p){ return fract(sin(dot(p, vec3(17.1, 127.1, 311.7))) * 43758.5453); }

    void main(){
      float t = smoothstep(-0.2, 0.8, vDir.y);
      vec3 col = mix(bottomColor, topColor, t);

      float h = hash(floor(vDir * 200.0));
      if (h > 0.995) col += vec3(1.5) * starIntensity;

      gl_FragColor = vec4(col, 1.0);
    }
  `
});
const sky = new THREE.Mesh(skyGeo, skyMat);
scene.add(sky);

// Luna visible + luz de luna
const moonTex = new THREE.TextureLoader().load('https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/moon_1024.jpg');
const moonMat = new THREE.MeshBasicMaterial({ map: moonTex, color: 0xffffff });
const moonMesh = new THREE.Mesh(new THREE.SphereGeometry(6, 48, 48), moonMat);
moonMesh.position.set(0, 140, -80);
scene.add(moonMesh);

const moonLight = new THREE.DirectionalLight(0xcfe2ff, 1.2);
moonLight.position.copy(moonMesh.position.clone().normalize().multiplyScalar(60));
moonLight.castShadow = true;
moonLight.shadow.mapSize.set(2048, 2048);
moonLight.shadow.camera.near = 0.5;
moonLight.shadow.camera.far = 200;
scene.add(moonLight);

/** ========= MURO CILÍNDRICO (límite visual) ========= */
const wallGeo = new THREE.CylinderGeometry(WORLD_RADIUS + 0.5, WORLD_RADIUS + 0.5, 60, 64, 1, true);
const wallMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
const wallMesh = new THREE.Mesh(wallGeo, wallMat);
wallMesh.position.y = 30;
scene.add(wallMesh);

/** ========= PERLIN NOISE ========= */
function makePerlin(seed = 1337) {
  const p = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  let n, q;
  for (let i = 255; i > 0; i--) {
    n = Math.floor((seed = (seed * 16807) % 2147483647) / 2147483647 * (i + 1));
    q = p[i]; p[i] = p[n]; p[n] = q;
  }
  for (let i = 0; i < 256; i++) p[256 + i] = p[i];

  const grad = (h, x, y) => {
    switch (h & 3) { case 0: return  x + y; case 1: return -x + y; case 2: return  x - y; default: return -x - y; }
  };
  const fade = t => t*t*t*(t*(t*6.0-15.0)+10.0);
  const lerp = (a,b,t) => a + t*(b-a);

  return function noise(x, y) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const A = p[X] + Y, B = p[X+1] + Y;
    return lerp( lerp(grad(p[A], x, y), grad(p[B], x-1.0, y), u),
                 lerp(grad(p[A+1], x, y-1.0), grad(p[B+1], x-1.0, y-1.0), u), v );
  };
}
const noise2D = makePerlin(2025);

/** ========= TERRENO PBR ========= */
const terrainGeo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, TERRAIN_RES, TERRAIN_RES);
terrainGeo.rotateX(-Math.PI / 2);
const tPos = terrainGeo.attributes.position;
for (let i = 0; i < tPos.count; i++) {
  const x = tPos.getX(i), z = tPos.getZ(i);
  const h = noise2D(x*0.02, z*0.02)*0.6 + noise2D(x*0.05, z*0.05)*0.25 + noise2D(x*0.1, z*0.1)*0.1;
  tPos.setY(i, h * TERRAIN_MAX_H);
}
tPos.needsUpdate = true;
terrainGeo.computeVertexNormals();
terrainGeo.setAttribute('uv2', new THREE.BufferAttribute(new Float32Array(terrainGeo.attributes.uv.array), 2));

const texLoader = new THREE.TextureLoader();
function loadTex(path){
  const tex = texLoader.load(path);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8,8);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy?.() || 8;
  return tex;
}
const groundColor = loadTex('assets/textures/ground/ground_color.jpg');
const groundNormal = loadTex('assets/textures/ground/ground_normal.jpg');
const groundRough  = loadTex('assets/textures/ground/ground_roughness.jpg');
const groundAO     = loadTex('assets/textures/ground/ground_ao.jpg');

const terrainMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color(0x3a2a1c), // tinte café oscuro
  map: groundColor,
  normalMap: groundNormal,
  roughnessMap: groundRough,
  aoMap: groundAO,
  roughness: 1.0,
  metalness: 0.0
});
const terrain = new THREE.Mesh(terrainGeo, terrainMat);
terrain.receiveShadow = true;
scene.add(terrain);

/** ========= RAYCAST / UTIL ========= */
const raycaster = new THREE.Raycaster();

function getTerrainHitRay(origin, dir, far=500){
  raycaster.set(origin, dir);
  raycaster.far = far;
  const hit = raycaster.intersectObject(terrain, false)[0];
  return hit || null;
}
function getTerrainHeight(x, z) {
  const hit = getTerrainHitRay(new THREE.Vector3(x, 100, z), new THREE.Vector3(0,-1,0));
  return hit ? hit.point.y : 0;
}
function clampToWorld(v){
  const r = Math.hypot(v.x, v.z);
  if (r > WORLD_RADIUS - PLAYER_RADIUS){
    const ang = Math.atan2(v.z, v.x);
    const rr = WORLD_RADIUS - PLAYER_RADIUS;
    v.x = Math.cos(ang) * rr;
    v.z = Math.sin(ang) * rr;
  }
  return v;
}

/** ========= ÁRBOLES (colliders) ========= */
const treeColliders = [];

function addTree(x, z, scale=1){
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12*scale, 0.22*scale, 2.6*scale, 8),
    new THREE.MeshStandardMaterial({ color: 0x3a2b1a, roughness: 1 })
  );
  trunk.castShadow = true; trunk.receiveShadow = true;

  const crowns = new THREE.Group();
  const levels = 3 + Math.floor(Math.random()*2);
  for(let i=0;i<levels;i++){
    const crown = new THREE.Mesh(
      new THREE.ConeGeometry((1.6-i*0.25)*scale, (2.2-i*0.25)*scale, 10),
      new THREE.MeshStandardMaterial({ color: 0x0f2d1c, roughness: 0.9 })
    );
    crown.castShadow = true; crown.position.y = (2.0 + i*0.7)*scale;
    crowns.add(crown);
  }

  const y = getTerrainHeight(x,z);
  const tree = new THREE.Group();
  tree.position.set(x, y, z);
  tree.add(trunk, crowns);
  scene.add(tree);

  treeColliders.push({ x, z, r: OBJ_TREE_R * scale });
}
for (let i=0;i<TREE_COUNT;i++){
  let x=(Math.random()-0.5)*WORLD_SIZE, z=(Math.random()-0.5)*WORLD_SIZE;
  if (Math.hypot(x-player.position.x, z-player.position.z) < 6){
    const a=Math.random()*Math.PI*2, r=8+Math.random()*20;
    x=player.position.x+Math.cos(a)*r; z=player.position.z+Math.sin(a)*r;
  }
  addTree(x, z, 0.8 + Math.random()*1.8);
}

/** ========= CALABAZAS (visibles y dentro del área) ========= */
const pumpkins = [];
const pumpkinColliders = [];

function makeJackFaceTexture(size=512){
  const cvs=document.createElement('canvas'); cvs.width=cvs.height=size; const ctx=cvs.getContext('2d');
  ctx.fillStyle='black'; ctx.fillRect(0,0,size,size);
  ctx.fillStyle='#ffd18a';
  const eyeW=size*0.14, eyeH=size*0.12, eyeY=size*0.38, eyeXOff=size*0.16;
  const tri=(cx,cy,w,h,rot=0)=>{ ctx.save(); ctx.translate(cx,cy); ctx.rotate(rot); ctx.beginPath(); ctx.moveTo(0,-h/2); ctx.lineTo(-w/2,h/2); ctx.lineTo(w/2,h/2); ctx.closePath(); ctx.fill(); ctx.restore(); };
  tri(size/2-eyeXOff, eyeY, eyeW, eyeH, 0.1); tri(size/2+eyeXOff, eyeY, eyeW, eyeH, -0.1); tri(size/2, size*0.50, eyeW*0.6, eyeH*0.7, 0);
  ctx.beginPath();
  const mouthW=size*0.45, mouthH=size*0.18, mouthY=size*0.68, left=size/2 - mouthW/2, right=size/2 + mouthW/2;
  ctx.moveTo(left, mouthY);
  const teeth=7;
  for(let i=1;i<=teeth;i++){ const t=i/teeth; const x=left+t*mouthW; const y=mouthY+((i%2)? mouthH : -mouthH)*0.5; ctx.lineTo(x,y); }
  ctx.lineTo(right, mouthY); ctx.closePath(); ctx.fill();
  const tex=new THREE.CanvasTexture(cvs); tex.needsUpdate=true; return tex;
}

// Audio tintineo
const listener = new THREE.AudioListener();
camera.add(listener);
const audioLoader = new THREE.AudioLoader();
let chimeBuffer = null;
audioLoader.load('assets/audio/chime.mp3', (buf)=> chimeBuffer = buf);

function addPumpkin(x, z) {
  const y = getTerrainHeight(x, z) + 0.4; // levantar un poco
  const emissiveMap = makeJackFaceTexture(512);

  const mat = new THREE.MeshStandardMaterial({
    color: 0xff6a00,
    roughness: 0.55,
    metalness: 0.0,
    emissive: 0xffa75a,
    emissiveIntensity: 0.45,
    emissiveMap
  });

  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 32, 24).scale(1.25, 1.0, 1.1),
    mat
  );
  body.castShadow = true; body.receiveShadow = true;

  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.07, 0.18, 8),
    new THREE.MeshStandardMaterial({ color: 0x3b7a2a, roughness: 0.9 })
  );
  stem.position.y = 0.45;

  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.add(body, stem);

  const candle = new THREE.PointLight(0xffc47a, 1.6, 8, 2.0);
  candle.position.set(0, 0.05, 0);
  g.add(candle);

  const flicker = { phase: Math.random() * 1000 };
  g.userData.animate = (t) => {
    const it = 1.1 + Math.sin(t * 5.4 + flicker.phase) * 0.38 + (Math.random() - 0.5) * 0.18;
    candle.intensity = THREE.MathUtils.clamp(it, 0.9, 2.0);
    mat.emissiveIntensity = 0.45 + (candle.intensity - 1.0) * 0.28;
  };
  g.userData.mat = mat;
  g.userData.touched = false;

  scene.add(g);
  pumpkins.push(g);
  pumpkinColliders.push({ x, z, r: OBJ_PUMP_R, idx: pumpkins.length - 1 });
}

// Coloca PUMPKIN_COUNT calabazas distribuidas en radio visible
for (let i = 0; i < PUMPKIN_COUNT; i++) {
  const angle = (i / PUMPKIN_COUNT) * Math.PI * 2;
  const radius = 10 + Math.random() * PUMPKIN_AREA;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  addPumpkin(x, z);
}
if (hudTotal) hudTotal.textContent = String(PUMPKIN_COUNT);

/** ========= TUMBAS (mismo número que calabazas) ========= */
function addGrave(x, z) {
  const y = getTerrainHeight(x, z);

  const stoneMat = new THREE.MeshStandardMaterial({
    color: 0x777777,
    roughness: 1.0,
    metalness: 0.0
  });

  const base = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.2, 0.4), stoneMat);
  base.position.y = y + 0.1;

  // Lápida con parte superior curva
  const head = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, 0.9, 16, 1, false, 0, Math.PI),
    stoneMat
  );
  head.position.set(0, y + 0.65, 0);
  head.rotation.x = Math.PI / 2;

  const grave = new THREE.Group();
  grave.add(base, head);
  grave.position.set(x, 0, z);

  // “Envejecida”
  grave.rotation.y = (Math.random() - 0.5) * 0.8;
  grave.rotation.z = (Math.random() - 0.5) * 0.1;
  grave.scale.setScalar(0.9 + Math.random() * 0.3);

  scene.add(grave);
}
for (let i = 0; i < PUMPKIN_COUNT; i++) {
  const angle = (i / PUMPKIN_COUNT) * Math.PI * 2 + Math.random() * 0.5;
  const radius = 15 + Math.random() * 60;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  addGrave(x, z);
}

/** ========= XR: CONTROLADORES + TELEPORT ========= */
const vrBtn = VRButton.createButton(renderer);
vrBtn.classList.add('vr-button');
document.body.appendChild(vrBtn);

const controllerLeft = renderer.xr.getController(0);
const controllerRight = renderer.xr.getController(1);
scene.add(controllerLeft, controllerRight);

const controllerModelFactory = new XRControllerModelFactory();
const grip0 = renderer.xr.getControllerGrip(0);
grip0.add(controllerModelFactory.createControllerModel(grip0));
scene.add(grip0);

const grip1 = renderer.xr.getControllerGrip(1);
grip1.add(controllerModelFactory.createControllerModel(grip1));
scene.add(grip1);

// Arco parabólico + marcador
const arcMatOK  = new THREE.LineBasicMaterial({ color: 0x7ad1ff, transparent:true, opacity:0.95 });
const arcMatBAD = new THREE.LineBasicMaterial({ color: 0xff5a5a, transparent:true, opacity:0.95 });
let arcMaterial = arcMatOK;

const arcGeo = new THREE.BufferGeometry().setFromPoints(new Array(ARC_STEPS).fill(0).map(()=>new THREE.Vector3()));
const arcLine = new THREE.Line(arcGeo, arcMaterial);
arcLine.visible = false;
scene.add(arcLine);

const marker = new THREE.Mesh(
  new THREE.RingGeometry(0.25,0.30,32),
  new THREE.MeshBasicMaterial({ color:0x7ad1ff, transparent:true, opacity:0.9, side:THREE.DoubleSide })
);
marker.rotation.x = -Math.PI/2;
marker.visible = false;
scene.add(marker);

let teleportValid = false;
const teleportPoint = new THREE.Vector3();

controllerRight.addEventListener('selectstart', () => { arcLine.visible = true; marker.visible = true; });
controllerRight.addEventListener('selectend',   () => {
  arcLine.visible = false; marker.visible = false;
  if (teleportValid) {
    const clamped = clampToWorld(teleportPoint.clone());
    player.position.set(clamped.x, getTerrainHeight(clamped.x, clamped.z) + 1.6, clamped.z);
  }
});

// Audio ambiente al empezar VR
renderer.xr.addEventListener('sessionstart', async ()=>{
  try { ambientEl.volume = 0.45; await ambientEl.play(); } catch(e){ console.warn('Audio ambiente bloqueado:', e); }
});

/** ========= LOCOMOCIÓN (stick) ========= */
function vrGamepadMove(dt){
  const session = renderer.xr.getSession(); if (!session) return;
  for (const src of session.inputSources){
    if (!src.gamepad) continue;
    let [x,y] = [src.gamepad.axes[2], src.gamepad.axes[3]];
    if (x===undefined || y===undefined){ x = src.gamepad.axes[0] ?? 0; y = src.gamepad.axes[1] ?? 0; }

    const dead=0.12; if (Math.abs(x)<dead) x=0; if (Math.abs(y)<dead) y=0; if (x===0 && y===0) continue;

    const forward = new THREE.Vector3(); camera.getWorldDirection(forward); forward.y=0; forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0,1,0)).normalize();

    let next = player.position.clone();
    next.addScaledVector(forward, -y * VR_WALK_SPEED * dt);
    next.addScaledVector(right,    x * VR_STRAFE_SPEED * dt);

    // Clamp + altura terreno
    next = clampToWorld(next);
    next.y = getTerrainHeight(next.x, next.z) + 1.6;

    // Colisiones (árboles, calabazas)
    next = resolveCollisions(player.position, next);

    player.position.copy(next);
  }
}

/** ========= TELEPORT: validar arco + NavMesh (terreno) ========= */
const arcPointsBuf = new Float32Array(ARC_STEPS * 3);

function segmentIntersectTerrain(a,b){
  const dir = new THREE.Vector3().subVectors(b,a); const len = dir.length(); if (!len) return null; dir.normalize();
  raycaster.set(a, dir); raycaster.far = len + 0.01;
  const h = raycaster.intersectObject(terrain, false)[0];
  if (!h) return null;
  const n = h.face?.normal.clone() || new THREE.Vector3(0,1,0);
  n.transformDirection(terrain.matrixWorld);
  return { point: h.point.clone(), faceNormal: n.normalize() };
}

function updateTeleportArc(){
  if (!arcLine.visible) return;
  teleportValid = false;

  const origin = new THREE.Vector3().setFromMatrixPosition(controllerRight.matrixWorld);
  const dir = new THREE.Vector3(0,0,-1).applyQuaternion(controllerRight.quaternion).normalize();

  const pts = [];
  let hit = null;

  const v0 = dir.clone().multiplyScalar(ARC_SPEED);
  const g = new THREE.Vector3(0,-ARC_GRAVITY,0);
  let p = origin.clone(), v = v0.clone();

  for (let i=0;i<ARC_STEPS;i++){
    pts.push(p.clone());
    v.addScaledVector(g, 1/60);
    const np = p.clone().addScaledVector(v, 1/60);
    const segHit = segmentIntersectTerrain(p, np);
    if (segHit){ hit = segHit; break; }
    p.copy(np);
  }

  for (let i=0;i<ARC_STEPS;i++){
    const P = pts[Math.min(i, pts.length-1)];
    arcPointsBuf[i*3+0]=P.x; arcPointsBuf[i*3+1]=P.y; arcPointsBuf[i*3+2]=P.z;
  }
  arcGeo.setAttribute('position', new THREE.BufferAttribute(arcPointsBuf,3));
  arcGeo.attributes.position.needsUpdate = true;

  if (hit){
    const slopeDeg = THREE.MathUtils.radToDeg(Math.acos(hit.faceNormal.dot(new THREE.Vector3(0,1,0))));
    const inside = hit.point.distanceTo(new THREE.Vector3(0, hit.point.y, 0)) <= WORLD_RADIUS;
    teleportValid = (slopeDeg <= MAX_SLOPE_DEG) && inside;

    arcLine.material = teleportValid ? arcMatOK : arcMatBAD;
    marker.material.color.set(teleportValid ? 0x7ad1ff : 0xff5a5a);

    const clamped = clampToWorld(hit.point.clone());
    marker.position.set(clamped.x, getTerrainHeight(clamped.x, clamped.z) + 0.02, clamped.z);
    teleportPoint.copy(clamped);
  }
}

/** ========= COLISIONES Y LÍMITES ========= */
let hitCount = 0;

function resolveCollisions(curr, next){
  // Árboles
  for (const t of treeColliders){
    const dx = next.x - t.x, dz = next.z - t.z;
    const dist = Math.hypot(dx, dz);
    const minD = PLAYER_RADIUS + t.r;
    if (dist < minD){
      const push = (minD - dist) + 1e-3;
      const nx = dx / (dist || 1), nz = dz / (dist || 1);
      next.x += nx * push; next.z += nz * push;
    }
  }
  // Calabazas (también disparan el evento "tocada")
  for (const p of pumpkinColliders){
    const dx = next.x - p.x, dz = next.z - p.z;
    const dist = Math.hypot(dx, dz);
    const minD = PLAYER_RADIUS + p.r;
    if (dist < minD){
      const push = (minD - dist) + 1e-3;
      const nx = dx / (dist || 1), nz = dz / (dist || 1);
      next.x += nx * push; next.z += nz * push;

      const pumpkin = pumpkins[p.idx];
      if (pumpkin && !pumpkin.userData.touched){
        pumpkin.userData.touched = true;
        hitCount++; if (hudHit) hudHit.textContent = String(hitCount);

        // Sonido
        if (chimeBuffer){
          const sfx = new THREE.Audio(listener);
          sfx.setBuffer(chimeBuffer); sfx.setVolume(0.7); sfx.play();
        }
        // Naranja -> Rojo
        const m = pumpkin.userData.mat;
        m.color.set(0xff3a3a);
        m.emissive = new THREE.Color(0xff5a5a);
        m.emissiveIntensity = 0.6;
      }
    }
  }
  // Mantener dentro del mundo
  return clampToWorld(next);
}

/** ========= LOOP ========= */
const clock = new THREE.Clock();

renderer.setAnimationLoop(()=>{
  const dt = Math.min(clock.getDelta(), 0.05);

  if (renderer.xr.isPresenting){
    vrGamepadMove(dt);
    updateTeleportArc();
  }

  // animación de velas en calabazas
  const t = performance.now()*0.001;
  for (const g of pumpkins) g.userData.animate?.(t);

  renderer.render(scene, camera);
});

/** ========= RESIZE ========= */
addEventListener('resize', ()=>{
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
