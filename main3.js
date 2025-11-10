import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

/** ========= CONFIG ========= */
const WORLD_SIZE = 260;      // tamaño del mundo
const TERRAIN_RES = 256;     // subdivisiones del terreno (potencia de 2)
const TERRAIN_MAX_H = 2.6;   // altura máxima del terreno
const TREE_COUNT = 520;      // número de árboles
const PUMPKIN_COUNT = 56;    // número de calabazas
const SPAWN_CLEAR_R = 6;     // radio despejado alrededor de spawn
const FOG_DENSITY = 0.028;   // niebla nocturna
const VR_WALK_SPEED = 3.6;   // velocidad al caminar con stick
const VR_STRAFE_SPEED = 3.0;
const ARC_STEPS = 40;        // puntos del arco de teletransporte
const ARC_SPEED = 7.5;       // velocidad inicial del arco
const ARC_GRAVITY = 9.8;     // gravedad del arco
const HDRI_URL = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/moonless_golf_1k.hdr'; // IBL nocturna (Poly Haven)

/** ========= ESCENA BÁSICA ========= */
const canvas = document.getElementById('scene');
const ambientEl = document.getElementById('ambient');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x06080f);
scene.fog = new THREE.FogExp2(0x06080f, FOG_DENSITY);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 400);

// Grupo “player”: mueve a la persona completa (en VR moveremos este grupo)
const player = new THREE.Group();
player.position.set(0, 1.6, 3);
player.add(camera);
scene.add(player);

/** ========= IBL / HDRI ========= */
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
new RGBELoader().load(HDRI_URL, (hdr) => {
  const envMap = pmrem.fromEquirectangular(hdr).texture;
  scene.environment = envMap;
  hdr.dispose();
  pmrem.dispose();
});

/** ========= ILUMINACIÓN ========= */
const hemi = new THREE.HemisphereLight(0x8fb2ff, 0x0a0c10, 0.35);
scene.add(hemi);

const moonLight = new THREE.DirectionalLight(0xcfe2ff, 0.9);
moonLight.position.set(-30, 35, 10);
moonLight.castShadow = true;
moonLight.shadow.mapSize.set(2048, 2048);
moonLight.shadow.camera.near = 0.5;
moonLight.shadow.camera.far = 180;
scene.add(moonLight);

// “luna” visual
const moon = new THREE.Mesh(
  new THREE.CircleGeometry(2.6, 64),
  new THREE.MeshBasicMaterial({ color: 0xd8e6ff })
);
moon.position.set(-90, 70, -60);
scene.add(moon);

// Relleno suave
scene.add(new THREE.AmbientLight(0x223344, 0.12));

/** ========= CÚPULA DE ESTRELLAS ========= */
(function addStars() {
  const starsGeo = new THREE.BufferGeometry();
  const COUNT = 2500;
  const positions = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    // distribuye en esfera grande
    const r = 600 + Math.random() * 300;
    const a = Math.random() * Math.PI * 2;
    const b = Math.acos(2 * Math.random() - 1);
    positions[i * 3 + 0] = r * Math.sin(b) * Math.cos(a);
    positions[i * 3 + 1] = r * Math.cos(b);
    positions[i * 3 + 2] = r * Math.sin(b) * Math.sin(a);
  }
  starsGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const starsMat = new THREE.PointsMaterial({ size: 0.9, sizeAttenuation: true, color: 0xffffff });
  const stars = new THREE.Points(starsGeo, starsMat);
  scene.add(stars);
})();

/** ========= TERRENO PROCEDURAL (PERLIN) ========= */
function makePerlin(seed = 1337) {
  // Perlin simple (clásico) — suficiente para relieve suave
  const p = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  let n, q;
  for (let i = 255; i > 0; i--) {
    n = Math.floor((seed = (seed * 16807) % 2147483647) / 2147483647 * (i + 1));
    q = p[i]; p[i] = p[n]; p[n] = q;
  }
  for (let i = 0; i < 256; i++) p[256 + i] = p[i];

  const grad = (hash, x, y) => {
    switch (hash & 3) {
      case 0: return  x + y;
      case 1: return -x + y;
      case 2: return  x - y;
      default:return -x - y;
    }
  };
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + t * (b - a);

  return function noise(x, y) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const A = p[X] + Y, B = p[X + 1] + Y;
    return lerp(
      lerp(grad(p[A], x, y), grad(p[B], x - 1, y), u),
      lerp(grad(p[A + 1], x, y - 1), grad(p[B + 1], x - 1, y - 1), u),
      v
    );
  };
}
const noise2D = makePerlin(2025);

// Plano subdividido y desplazado por ruido
const terrainGeo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, TERRAIN_RES, TERRAIN_RES);
terrainGeo.rotateX(-Math.PI / 2);
const pos = terrainGeo.attributes.position;
for (let i = 0; i < pos.count; i++) {
  const x = pos.getX(i);
  const z = pos.getZ(i);
  const h =
    noise2D(x * 0.02, z * 0.02) * 0.6 +
    noise2D(x * 0.05, z * 0.05) * 0.25 +
    noise2D(x * 0.1, z * 0.1) * 0.1;
  pos.setY(i, h * TERRAIN_MAX_H);
}
pos.needsUpdate = true;
terrainGeo.computeVertexNormals();

const terrainMat = new THREE.MeshStandardMaterial({
  color: 0x0c140e,
  roughness: 0.95,
  metalness: 0.0
});
const terrain = new THREE.Mesh(terrainGeo, terrainMat);
terrain.receiveShadow = true;
scene.add(terrain);

/** ========= ÁRBOLES PROCEDURALES (variación) ========= */
function addTree(x, z, scale = 1) {
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12 * scale, 0.22 * scale, 2.6 * scale, 8),
    new THREE.MeshStandardMaterial({ color: 0x3a2b1a, roughness: 1 })
  );
  trunk.castShadow = true;
  trunk.receiveShadow = true;

  const crowns = new THREE.Group();
  const levels = 3 + Math.floor(Math.random() * 2);
  for (let i = 0; i < levels; i++) {
    const crown = new THREE.Mesh(
      new THREE.ConeGeometry((1.6 - i * 0.25) * scale, (2.2 - i * 0.25) * scale, 10),
      new THREE.MeshStandardMaterial({ color: 0x0f2d1c, roughness: 0.9, metalness: 0.0 })
    );
    crown.castShadow = true;
    crown.position.y = (2.0 + i * 0.7) * scale;
    crowns.add(crown);
  }

  const tree = new THREE.Group();
  tree.add(trunk, crowns);

  // altura del suelo en x,z (raycast simple hacia abajo)
  const y = getTerrainHeight(x, z);
  tree.position.set(x, y, z);
  scene.add(tree);
}

function getTerrainHeight(x, z) {
  // Raycast desde arriba hacia el terreno para obtener Y real
  _raycaster.set(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
  const hit = _raycaster.intersectObject(terrain, false)[0];
  return hit ? hit.point.y : 0;
}

const _raycaster = new THREE.Raycaster();
for (let i = 0; i < TREE_COUNT; i++) {
  let x = (Math.random() - 0.5) * WORLD_SIZE;
  let z = (Math.random() - 0.5) * WORLD_SIZE;
  if (Math.hypot(x - player.position.x, z - player.position.z) < SPAWN_CLEAR_R) {
    const angle = Math.random() * Math.PI * 2;
    const r = SPAWN_CLEAR_R + 4 + Math.random() * 20;
    x = player.position.x + Math.cos(angle) * r;
    z = player.position.z + Math.sin(angle) * r;
  }
  const s = 0.8 + Math.random() * 1.8;
  addTree(x, z, s);
}

/** ========= CALABAZAS JACK‑O’‑LANTERN ========= */
const pumpkins = [];

function makeJackFaceTexture(size = 512) {
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = size;
  const ctx = cvs.getContext('2d');

  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = '#ffd18a';
  const eyeW = size * 0.14, eyeH = size * 0.12, eyeY = size * 0.38, eyeXOff = size * 0.16;
  const tri = (cx, cy, w, h, rot = 0) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.moveTo(0, -h/2);
    ctx.lineTo(-w/2, h/2);
    ctx.lineTo(w/2, h/2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  tri(size/2 - eyeXOff, eyeY, eyeW, eyeH, 0.1);
  tri(size/2 + eyeXOff, eyeY, eyeW, eyeH, -0.1);
  tri(size/2, size*0.50, eyeW*0.6, eyeH*0.7, 0);

  ctx.beginPath();
  const mouthW = size * 0.45, mouthH = size * 0.18, mouthY = size * 0.68;
  const left = size/2 - mouthW/2, right = size/2 + mouthW/2;
  ctx.moveTo(left, mouthY);
  const teeth = 7;
  for (let i = 1; i <= teeth; i++) {
    const t = i / teeth;
    const x = left + t * mouthW;
    const y = mouthY + (i % 2 === 0 ? -mouthH : mouthH) * 0.5;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(right, mouthY);
  ctx.closePath();
  ctx.fill();

  const tex = new THREE.CanvasTexture(cvs);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function addPumpkin(x, z) {
  const y = getTerrainHeight(x, z);
  const emissiveMap = makeJackFaceTexture(512);

  const pumpkinMat = new THREE.MeshStandardMaterial({
    color: 0xff6a00,
    roughness: 0.55,
    metalness: 0.0,
    emissive: new THREE.Color(0xffa75a),
    emissiveIntensity: 0.45,  // un poco más brillante
    emissiveMap
  });

  const bodyGeo = new THREE.SphereGeometry(0.42, 32, 24);
  bodyGeo.scale(1.25, 1.0, 1.1);

  const body = new THREE.Mesh(bodyGeo, pumpkinMat);
  body.castShadow = true;
  body.receiveShadow = true;

  const ribs = new THREE.Group();
  for (let i = 0; i < 10; i++) {
    const tor = new THREE.Mesh(
      new THREE.TorusGeometry(0.39, 0.018, 8, 32),
      new THREE.MeshStandardMaterial({ color: 0xff7f1a, roughness: 0.8 })
    );
    tor.rotation.x = Math.PI / 2;
    tor.rotation.z = (i / 10) * Math.PI;
    ribs.add(tor);
  }

  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.07, 0.18, 8),
    new THREE.MeshStandardMaterial({ color: 0x3b7a2a, roughness: 0.9 })
  );
  stem.position.y = 0.45;

  const group = new THREE.Group();
  group.position.set(x, y + 0.42, z);
  group.add(body, ribs, stem);

  const candle = new THREE.PointLight(0xffc47a, 1.45, 7.5, 2.0);
  candle.position.set(0, -0.10, 0);
  group.add(candle);

  const flicker = { phase: Math.random() * 1000 };
  group.userData.animate = (t) => {
    const intensity = 1.1 + Math.sin(t * 5.4 + flicker.phase) * 0.38 + (Math.random() - 0.5) * 0.18;
    candle.intensity = THREE.MathUtils.clamp(intensity, 0.8, 1.9);
    pumpkinMat.emissiveIntensity = 0.45 + (candle.intensity - 1.0) * 0.28;
  };

  scene.add(group);
  pumpkins.push(group);
}

for (let i = 0; i < PUMPKIN_COUNT; i++) {
  let x = (Math.random() - 0.5) * WORLD_SIZE;
  let z = (Math.random() - 0.5) * WORLD_SIZE;
  if (Math.hypot(x - player.position.x, z - player.position.z) < SPAWN_CLEAR_R + 2) {
    const angle = Math.random() * Math.PI * 2;
    const r = SPAWN_CLEAR_R + 4 + Math.random() * 20;
    x = player.position.x + Math.cos(angle) * r;
    z = player.position.z + Math.sin(angle) * r;
  }
  addPumpkin(x, z);
}

/** ========= MANDO VR: LOCOMOCIÓN + TELEPORT ========= */
const vrBtn = VRButton.createButton(renderer);
vrBtn.classList.add('vr-button');
document.body.appendChild(vrBtn);

// Controladores
const controllerLeft = renderer.xr.getController(0);
const controllerRight = renderer.xr.getController(1);
scene.add(controllerLeft, controllerRight);

const controllerModelFactory = new XRControllerModelFactory();
const controllerGrip0 = renderer.xr.getControllerGrip(0);
controllerGrip0.add(controllerModelFactory.createControllerModel(controllerGrip0));
scene.add(controllerGrip0);

const controllerGrip1 = renderer.xr.getControllerGrip(1);
controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
scene.add(controllerGrip1);

// Arco parabólico de teletransporte
const arcMat = new THREE.LineBasicMaterial({ color: 0x88ccff, transparent: true, opacity: 0.9 });
const arcGeo = new THREE.BufferGeometry().setFromPoints(new Array(ARC_STEPS).fill(0).map(_ => new THREE.Vector3()));
const arcLine = new THREE.Line(arcGeo, arcMat);
arcLine.visible = false;
scene.add(arcLine);

let teleportValid = false;
let teleportPoint = new THREE.Vector3();

controllerRight.addEventListener('selectstart', () => {
  arcLine.visible = true;
});
controllerRight.addEventListener('selectend', () => {
  arcLine.visible = false;
  if (teleportValid) {
    // Mantén altura “ojos” respecto al terreno
    const targetY = getTerrainHeight(teleportPoint.x, teleportPoint.z) + 1.6;
    player.position.set(teleportPoint.x, targetY, teleportPoint.z);
  }
});

// Mover con stick izquierdo durante la sesión
renderer.xr.addEventListener('sessionstart', async () => {
  try {
    ambientEl.volume = 0.45;
    await ambientEl.play(); // se permite por gesto de entrar a VR
  } catch (e) {
    console.warn('Audio no pudo iniciar aún:', e);
  }
});

// Utilidades arco/teleport
const _arcPoints = new Float32Array(ARC_STEPS * 3);
const _tmpVec = new THREE.Vector3();

function updateTeleportArc(dt) {
  if (!arcLine.visible) return;
  teleportValid = false;

  // Origen y dirección del controlador derecho (en mundo)
  _tmpVec.set(0, 0, 0);
  controllerRight.localToWorld(_tmpVec);
  const origin = _tmpVec.clone();

  const dir = new THREE.Vector3(0, 0, -1);
  dir.applyQuaternion(controllerRight.quaternion).normalize();

  const points = [];
  let hitPoint = null;

  // Simula trayecto balístico
  const v0 = dir.clone().multiplyScalar(ARC_SPEED);
  const g = new THREE.Vector3(0, -ARC_GRAVITY, 0);

  let p = origin.clone();
  let v = v0.clone();

  for (let i = 0; i < ARC_STEPS; i++) {
    points.push(p.clone());
    // integración simple
    v.addScaledVector(g, 1/60);
    p.addScaledVector(v, 1/60);

    // checar intersección segmento con el terreno
    const from = points[points.length - 2] || origin;
    const to = p;
    const hit = segmentIntersectTerrain(from, to);
    if (hit) {
      hitPoint = hit;
      teleportValid = true;
      break;
    }
  }

  // completar geometría del arco
  const used = points.length;
  for (let i = 0; i < ARC_STEPS; i++) {
    const idx = i * 3;
    const P = points[Math.min(i, used - 1)];
    _arcPoints[idx + 0] = P.x;
    _arcPoints[idx + 1] = P.y;
    _arcPoints[idx + 2] = P.z;
  }
  arcGeo.setAttribute('position', new THREE.BufferAttribute(_arcPoints, 3));
  arcGeo.attributes.position.needsUpdate = true;

  // punto de destino
  if (teleportValid && hitPoint) {
    teleportPoint.copy(hitPoint);
    // pequeño marcador (opcional): puedes añadir una malla si lo deseas
  }
}

function segmentIntersectTerrain(a, b) {
  // Raycast desde a hacia b
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len === 0) return null;
  dir.normalize();

  _raycaster.set(a, dir);
  _raycaster.far = len + 0.01;
  const hits = _raycaster.intersectObject(terrain, false);
  return hits[0]?.point || null;
}

// Locomoción por stick (izquierdo preferentemente)
function vrGamepadMove(dt) {
  const session = renderer.xr.getSession();
  if (!session) return;

  for (const src of session.inputSources) {
    if (!src.gamepad) continue;

    // heurstica: el izquierdo normalmente tiene axes[2,3], si no, usa [0,1]
    const axes = src.gamepad.axes;
    let x = axes[2], y = axes[3];
    if (x === undefined || y === undefined) { x = axes[0] ?? 0; y = axes[1] ?? 0; }

    const dead = 0.12;
    if (Math.abs(x) < dead) x = 0;
    if (Math.abs(y) < dead) y = 0;
    if (x === 0 && y === 0) continue;

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0,1,0)).normalize();

    const move = new THREE.Vector3();
    move.addScaledVector(forward, -y * VR_WALK_SPEED * dt);
    move.addScaledVector(right,   x * VR_STRAFE_SPEED * dt);

    // Ajustar a la altura del terreno al mover
    const next = player.position.clone().add(move);
    next.y = getTerrainHeight(next.x, next.z) + 1.6;
    player.position.copy(next);
  }
}

/** ========= LOOP ========= */
const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);

  if (renderer.xr.isPresenting) {
    vrGamepadMove(dt);
    updateTeleportArc(dt);
  }

  // animación de calabazas
  const t = performance.now() * 0.001;
  for (const p of pumpkins) p.userData.animate?.(t);

  renderer.render(scene, camera);
});

/** ========= RESIZE ========= */
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
