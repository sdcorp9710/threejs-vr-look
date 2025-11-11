import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

/** ========= CONFIG ========= */
const WORLD_SIZE = 260;      // diámetro aprox del plano jugable
const TERRAIN_RES = 256;     // subdivisiones del terreno
const TERRAIN_MAX_H = 2.6;   // altura máxima del relieve
const TREE_COUNT = 520;
const PUMPKIN_COUNT = 56;
const PLAYER_RADIUS = 0.35;  // radio de colisión del jugador
const OBJ_TREE_R = 0.6;      // radio aprox de tronco/copa inferior
const OBJ_PUMP_R = 0.45;     // radio de calabaza
const FOG_DENSITY = 0.028;
const VR_WALK_SPEED = 3.6;
const VR_STRAFE_SPEED = 3.0;
const ARC_STEPS = 40;
const ARC_SPEED = 7.5;
const ARC_GRAVITY = 9.8;
const MAX_SLOPE_DEG = 45;
const WORLD_RADIUS = WORLD_SIZE * 0.5 - 1.0; // límite jugable
const HDRI_LOCAL = 'assets/hdr/moonless_golf_1k.hdr';
const HDRI_FALLBACK = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/moonless_golf_1k.hdr';

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
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();

async function setHDRI(url) {
  const tex = await new Promise((res, rej) => new RGBELoader().load(url, (t)=>res(t), undefined, rej));
  const env = pmrem.fromEquirectangular(tex).texture;
  scene.environment = env; tex.dispose(); pmrem.dispose();
}
setHDRI(HDRI_LOCAL).catch(()=>setHDRI(HDRI_FALLBACK).catch(e=>console.warn('Sin HDRI:', e)));

/** ========= ILUMINACIÓN ========= */
const hemi = new THREE.HemisphereLight(0x8fb2ff, 0x0a0c10, 0.35);
scene.add(hemi);

const moonLight = new THREE.DirectionalLight(0xcfe2ff, 1.0);
moonLight.position.set(-30, 35, 10);
moonLight.castShadow = true;
moonLight.shadow.mapSize.set(2048, 2048);
moonLight.shadow.camera.near = 0.5;
moonLight.shadow.camera.far = 180;
scene.add(moonLight);

// Luna visible
const moon = new THREE.Mesh(
  new THREE.CircleGeometry(3.2, 64),
  new THREE.MeshBasicMaterial({ color: 0xdfeaff })
);
moon.position.set(0, 120, -120);
moon.lookAt(0, 0, 0);
scene.add(moon);

/** ========= SKY DOME (estrellas + gradiente azul medianoche) ========= */
const skyGeo = new THREE.SphereGeometry(1000, 32, 16);
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    topColor:    { value: new THREE.Color(0x0a1b2e) }, // azul profundo
    bottomColor: { value: new THREE.Color(0x06101a) }, // casi negro-azul
    starDensity: { value: 0.85 },
    seed:        { value: Math.random() * 1000.0 }
  },
  vertexShader: /* glsl */`
    varying vec3 vPos;
    void main(){
      vPos = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
    }
  `,
  fragmentShader: /* glsl */`
    varying vec3 vPos;
    uniform vec3 topColor;
    uniform vec3 bottomColor;
    uniform float starDensity;
    uniform float seed;

    float hash(vec2 p){
      p = vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)));
      return fract(sin(p.x+p.y*seed)*43758.5453123);
    }
    void main(){
      vec3 n = normalize(vPos);
      float t = smoothstep(-0.2, 0.8, n.y); // gradiente vertical
      vec3 col = mix(bottomColor, topColor, t);

      // estrellas pseudo-aleatorias (baratas)
      vec2 uv = n.xz * 120.0;
      float h = hash(floor(uv));
      float star = step(0.995 - starDensity*0.005, h) ? 1.0 : 0.0;
      col += vec3(star) * 0.9;

      gl_FragColor = vec4(col, 1.0);
    }
  `
});
const sky = new THREE.Mesh(skyGeo, skyMat);
scene.add(sky);

/** ========= MURO CILÍNDRICO (límite visual) ========= */
const wallGeo = new THREE.CylinderGeometry(WORLD_RADIUS + 0.5, WORLD_RADIUS + 0.5, 60, 64, 1, true);
const wallMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
const wall = new THREE.Mesh(wallGeo, wallMat);
wall.position.y = 30;
scene.add(wall);

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

/** ========= TERRENO PBR (marrón oscuro) ========= */
const terrainGeo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, TERRAIN_RES, TERRAIN_RES);
terrainGeo.rotateX(-Math.PI / 2);
const pos = terrainGeo.attributes.position;
for (let i = 0; i < pos.count; i++) {
  const x = pos.getX(i), z = pos.getZ(i);
  const h = noise2D(x*0.02, z*0.02)*0.6 + noise2D(x*0.05, z*0.05)*0.25 + noise2D(x*0.1, z*0.1)*0.1;
  pos.setY(i, h * TERRAIN_MAX_H);
}
pos.needsUpdate = true;
terrainGeo.computeVertexNormals();
terrainGeo.setAttribute('uv2', new THREE.BufferAttribute(new Float32Array(terrainGeo.attributes.uv.array), 2));

const texLoader = new THREE.TextureLoader();
function loadTex(p){ const t = texLoader.load(p); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(8,8); t.anisotropy = renderer.capabilities.getMaxAnisotropy?.() || 8; return t; }

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

/** ========= UTIL RAYCAST ========= */
const _raycaster = new THREE.Raycaster();
function getTerrainHitRay(origin, dir, far=500){
  _raycaster.set(origin, dir); _raycaster.far = far;
  const hit = _raycaster.intersectObject(terrain, false)[0];
  return hit || null;
}
function getTerrainHeight(x, z) {
  const hit = getTerrainHitRay(new THREE.Vector3(x, 100, z), new THREE.Vector3(0,-1,0));
  return hit ? hit.point.y : 0;
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
  if (Math.hypot(x-player.position.x, z-player.position.z) < 6){ const a=Math.random()*Math.PI*2; const r=8+Math.random()*20; x=player.position.x+Math.cos(a)*r; z=player.position.z+Math.sin(a)*r; }
  addTree(x, z, 0.8 + Math.random()*1.8);
}

/** ========= CALABAZAS (colliders + evento) ========= */
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

function addPumpkin(x,z){
  const y = getTerrainHeight(x,z);
  const emissiveMap = makeJackFaceTexture(512);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xff6a00, roughness: 0.55, metalness: 0.0,
    emissive: 0xffa75a, emissiveIntensity: 0.45, emissiveMap
  });

  const bodyGeo = new THREE.SphereGeometry(0.42, 32, 24); bodyGeo.scale(1.25,1.0,1.1);
  const body = new THREE.Mesh(bodyGeo, mat); body.castShadow=true; body.receiveShadow=true;

  const ribs = new THREE.Group();
  for (let i=0;i<10;i++){
    const tor = new THREE.Mesh(new THREE.TorusGeometry(0.39, 0.018, 8, 32), new THREE.MeshStandardMaterial({ color: 0xff7f1a, roughness: 0.8 }));
    tor.rotation.x=Math.PI/2; tor.rotation.z=(i/10)*Math.PI; ribs.add(tor);
  }

  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.18, 8), new THREE.MeshStandardMaterial({ color: 0x3b7a2a, roughness: 0.9 }));
  stem.position.y = 0.45;

  const g = new THREE.Group(); g.position.set(x, y+0.42, z); g.add(body, ribs, stem);

  const candle = new THREE.PointLight(0xffc47a, 1.45, 7.5, 2.0); candle.position.set(0,-0.10,0); g.add(candle);
  const flicker = { phase: Math.random()*1000 };
  g.userData.animate = (t)=>{ const it=1.1 + Math.sin(t*5.4 + flicker.phase)*0.38 + (Math.random()-0.5)*0.18; candle.intensity = THREE.MathUtils.clamp(it, 0.8, 1.9); mat.emissiveIntensity = 0.45 + (candle.intensity-1.0)*0.28; };
  g.userData.mat = mat; g.userData.touched = false;

  scene.add(g); pumpkins.push(g);
  pumpkinColliders.push({ x, z, r: OBJ_PUMP_R, idx: pumpkins.length-1 });
}

for (let i=0;i<PUMPKIN_COUNT;i++){
  let x=(Math.random()-0.5)*WORLD_SIZE, z=(Math.random()-0.5)*WORLD_SIZE;
  if (Math.hypot(x-player.position.x, z-player.position.z) < 8){ const a=Math.random()*Math.PI*2; const r=10+Math.random()*20; x=player.position.x+Math.cos(a)*r; z=player.position.z+Math.sin(a)*r; }
  addPumpkin(x, z);
}
hudTotal.textContent = String(PUMPKIN_COUNT);

/** ========= XR: CONTROLADORES + TELEPORT ========= */
const vrBtn = VRButton.createButton(renderer);
vrBtn.classList.add('vr-button');
document.body.appendChild(vrBtn);

const controllerLeft = renderer.xr.getController(0);
const controllerRight = renderer.xr.getController(1);
scene.add(controllerLeft, controllerRight);

const controllerModelFactory = new XRControllerModelFactory();
const grip0 = renderer.xr.getControllerGrip(0); grip0.add(controllerModelFactory.createControllerModel(grip0)); scene.add(grip0);
const grip1 = renderer.xr.getControllerGrip(1); grip1.add(controllerModelFactory.createControllerModel(grip1)); scene.add(grip1);

// Arco parabólico + marcador
const arcMatOK  = new THREE.LineBasicMaterial({ color: 0x7ad1ff, transparent:true, opacity:0.95 });
const arcMatBAD = new THREE.LineBasicMaterial({ color: 0xff5a5a, transparent:true, opacity:0.95 });
let arcMat = arcMatOK;
const arcGeo = new THREE.BufferGeometry().setFromPoints(new Array(ARC_STEPS).fill(0).map(()=>new THREE.Vector3()));
const arcLine = new THREE.Line(arcGeo, arcMat); arcLine.visible=false; scene.add(arcLine);

const marker = new THREE.Mesh(new THREE.RingGeometry(0.25,0.30,32), new THREE.MeshBasicMaterial({ color:0x7ad1ff, transparent:true, opacity:0.9, side:THREE.DoubleSide }));
marker.rotation.x = -Math.PI/2; marker.visible=false; scene.add(marker);

let teleportValid=false, teleportPoint = new THREE.Vector3();

controllerRight.addEventListener('selectstart', ()=>{ arcLine.visible=true; marker.visible=true; });
controllerRight.addEventListener('selectend', ()=>{
  arcLine.visible=false; marker.visible=false;
  if (teleportValid) {
    const clamped = clampToWorld(teleportPoint);
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
    if (x===undefined||y===undefined){ x=src.gamepad.axes[0]??0; y=src.gamepad.axes[1]??0; }
    const dead=0.12; if (Math.abs(x)<dead) x=0; if (Math.abs(y)<dead) y=0; if (x===0 && y===0) continue;

    const forward = new THREE.Vector3(); camera.getWorldDirection(forward); forward.y=0; forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0,1,0)).normalize();

    let next = player.position.clone();
    next.addScaledVector(forward, -y * VR_WALK_SPEED * dt);
    next.addScaledVector(right,    x * VR_STRAFE_SPEED * dt);

    // Clamp a límites del mundo y altura del terreno
    next = clampToWorld(next);
    next.y = getTerrainHeight(next.x, next.z) + 1.6;

    // Resolver colisiones (árboles y calabazas)
    next = resolveCollisions(player.position, next);

    player.position.copy(next);
  }
}

/** ========= TELEPORT: validar arco + NavMesh ========= */
const _arcPoints = new Float32Array(ARC_STEPS*3);
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
    _arcPoints[i*3+0]=P.x; _arcPoints[i*3+1]=P.y; _arcPoints[i*3+2]=P.z;
  }
  arcGeo.setAttribute('position', new THREE.BufferAttribute(_arcPoints,3));
  arcGeo.attributes.position.needsUpdate = true;

  if (hit){
    const slopeDeg = THREE.MathUtils.radToDeg(Math.acos(hit.faceNormal.dot(new THREE.Vector3(0,1,0))));
    const inside = hit.point.distanceTo(new THREE.Vector3(0, hit.point.y, 0)) <= WORLD_RADIUS;
    teleportValid = (slopeDeg <= MAX_SLOPE_DEG) && inside;

    arcLine.material = teleportValid ? arcMatOK : arcMatBAD;
    marker.material.color.set(teleportValid ? 0x7ad1ff : 0xff5a5a);
    const clamped = clampToWorld(hit.point);
    marker.position.set(clamped.x, getTerrainHeight(clamped.x, clamped.z) + 0.02, clamped.z);
    teleportPoint.copy(clamped);
  }
}
function segmentIntersectTerrain(a,b){
  const dir = new THREE.Vector3().subVectors(b,a); const len = dir.length(); if (!len) return null; dir.normalize();
  _raycaster.set(a, dir); _raycaster.far = len + 0.01;
  const h = _raycaster.intersectObject(terrain, false)[0];
  if (!h) return null;
  const n = h.face?.normal.clone() || new THREE.Vector3(0,1,0);
  // transformar normal a mundo:
  n.transformDirection(terrain.matrixWorld);
  return { point: h.point.clone(), faceNormal: n.normalize() };
}

/** ========= COLISIONES Y LÍMITES ========= */
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
  // Calabazas
  for (const p of pumpkinColliders){
    const dx = next.x - p.x, dz = next.z - p.z;
    const dist = Math.hypot(dx, dz);
    const minD = PLAYER_RADIUS + p.r;
    if (dist < minD){
      // impedir atravesar
      const push = (minD - dist) + 1e-3;
      const nx = dx / (dist || 1), nz = dz / (dist || 1);
      next.x += nx * push; next.z += nz * push;

      // evento "tocada"
      const pumpkin = pumpkins[p.idx];
      if (pumpkin && !pumpkin.userData.touched){
        pumpkin.userData.touched = true;
        hitCount++; hudHit.textContent = String(hitCount);
        // sonido
        if (chimeBuffer){
          const sfx = new THREE.Audio(listener);
          sfx.setBuffer(chimeBuffer); sfx.setVolume(0.7); sfx.play();
        }
        // color naranja -> rojo
        pumpkin.userData.mat.color.set(0xff3a3a);
        pumpkin.userData.mat.emissive = new THREE.Color(0xff5a5a);
        pumpkin.userData.mat.emissiveIntensity = 0.6;
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

  // animación velas
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
