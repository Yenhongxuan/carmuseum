/**
 * testkit.js — 最小 ctx 組裝器（主代理擁有）
 *
 * 給 test/roomN.html 單獨測試各展廳用；正式的 main.js 會用同一套組裝邏輯。
 * 假設：three.js 由 importmap 提供；cars.json 在 ../data/cars.json（相對於 test/）。
 * 依賴：contract.js、scoring.js、world/*（動態 import，缺哪個就以 stub 頂替並警告）。
 */
import * as THREE from 'three';
import { STATE, EVENTS, EV, ROOMS, NO_DATA, ESTIMATE_NOTE, emit, on } from './contract.js';
import * as scoring from './scoring.js';

/** 依 B0 規格建立渲染管線。main.js 與 testkit 共用同一份，避免兩邊設定不一致。 */
export function createRenderer(mount) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  mount.appendChild(renderer.domElement);
  Object.assign(renderer.domElement.style, { position: 'fixed', inset: '0', display: 'block' });
  return renderer;
}

export function createCamera() {
  // 眼高 160cm、FOV 52 度（規格要求 50–55，60 以上有魚眼感）
  const cam = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.05, 800);
  cam.position.set(0, 1.60, 6);
  return cam;
}

async function tryImport(path, label) {
  try { return await import(path); }
  catch (e) { console.warn(`[testkit] ${label} 尚未就緒或載入失敗，改用 stub：`, e.message); return null; }
}

/** 缺席模組的 stub，讓單廳測試在別的代理還沒完成時也能跑起來。 */
function stubMaterials(THREE) {
  const cache = new Map();
  const lib = {
    get(name) {
      if (!cache.has(name)) {
        cache.set(name, new THREE.MeshStandardMaterial({ color: 0xBFC3C7, roughness: 0.8, metalness: 0 }));
      }
      return cache.get(name);
    },
    has: () => true,
    texture: () => ({ map: null, roughnessMap: null, normalMap: null }),
    setGrayscale() {}, isGrayscale: () => false, setDust() {},
    dispose() { for (const m of cache.values()) m.dispose(); cache.clear(); },
    __stub: true,
  };
  return lib;
}
function stubLighting(THREE, scene) {
  return {
    makeRig(roomKey) {
      const group = new THREE.Group();
      const hemi = new THREE.HemisphereLight(0xDCE8F5, 0x8A8578, 0.6);
      const sun = new THREE.DirectionalLight(0xFFF4E8, 2.2);
      sun.position.set(6, 12, 4); sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
      group.add(hemi, sun);
      return { group, exposure: 1.0, envKind: 'gallery', colorTempK: 5500,
               update() {}, dispose() {}, __stub: true };
    },
    setEnvironment() {}, dispose() {}, __stub: true,
  };
}
function stubArch(THREE) {
  const box = (w, h, d, y) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color: 0xE8E6E2, roughness: 0.9 }));
    m.position.y = y; m.receiveShadow = true; return m;
  };
  const mk = () => { const g = new THREE.Group(); g.add(box(30, 0.1, 30, -0.05)); return g; };
  const curve = new THREE.CatmullRomCurve3(
    Array.from({ length: 16 }, (_, i) => {
      const a = i / 16 * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * 80, 0, Math.sin(a) * 60);
    }), true, 'catmullrom', 0.5);
  return {
    buildGallery: mk, buildAlley: mk, buildLot: mk, buildTunnel: mk, buildCourt: mk,
    buildCircuit: () => ({
      group: mk(), curve, width: 14, lengthM: curve.getLength(),
      sampleAt(u) {
        const pos = curve.getPointAt(((u % 1) + 1) % 1);
        const tangent = curve.getTangentAt(((u % 1) + 1) % 1);
        return { pos, tangent, up: new THREE.Vector3(0, 1, 0), bank: 0 };
      },
    }),
    DIMENSIONS: {}, __stub: true,
  };
}
function stubCarModels(THREE, cars) {
  const mk = (car) => {
    const g = new THREE.Group();
    const L = car.length / 1000, W = car.width / 1000, H = car.height / 1000;
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H * 0.62, L),
      new THREE.MeshStandardMaterial({ color: 0xEFF1F4, roughness: 0.3, metalness: 0.05 }));
    body.position.y = H * 0.45; body.castShadow = true;
    g.add(body); g.userData.carId = car.id;
    return g;
  };
  return {
    getCarMesh: (id) => mk(cars.find(c => c.id === id) || cars[0]),
    createFleet(ids) {
      const group = new THREE.Group();
      const meshes = ids.map(id => { const m = mk(cars.find(c => c.id === id)); group.add(m); return m; });
      return {
        group,
        setTransform(i, pos, quat) { if (meshes[i]) { meshes[i].position.copy(pos); if (quat) meshes[i].quaternion.copy(quat); } },
        setHighlight(i, on) { if (meshes[i]) meshes[i].scale.setScalar(on ? 1.06 : 1); },
        setVisible(i, v) { if (meshes[i]) meshes[i].visible = v; },
        indexOf: (id) => ids.indexOf(id),
        commit() {},
      };
    },
    getTier: () => ({ tier: 3, label: '依原廠公布尺寸程序生成之示意模型，非原廠 CAD 資料', note: '' }),
    getFootprint(id) {
      const c = cars.find(x => x.id === id);
      return { length: c.length / 1000, width: c.width / 1000, height: c.height / 1000, wheelbase: c.wheelbase / 1000 };
    },
    getEyePoint(id) {
      const c = cars.find(x => x.id === id);
      return new THREE.Vector3(-0.35, c.height / 1000 * 0.62, 0.2);
    },
    createSpin360: () => ({ destroy() {} }),
    update() {}, dispose() {}, __stub: true,
  };
}

/**
 * 組出最小 ctx。
 * @param {{mount:HTMLElement, ui:HTMLElement, base?:string}} opts
 */
export async function makeTestCtx(opts = {}) {
  const mount = opts.mount || document.body;
  const ui = opts.ui || document.body;
  const base = opts.base || '..';

  const res = await fetch(`${base}/data/cars.json`);
  if (!res.ok) throw new Error(`cars.json 載入失敗 ${res.status}`);
  const cars = (await res.json()).cars;
  scoring.computeScores(cars);
  const carsById = Object.fromEntries(cars.map(c => [c.id, c]));
  STATE.alive = cars.map(c => c.id);

  const renderer = createRenderer(mount);
  const camera = createCamera();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xEDEEF0);   // 淺色，絕不深色背景

  const ctx = { THREE, renderer, scene, camera, cars, carsById, ui,
                STATE, EVENTS, EV, ROOMS, NO_DATA, ESTIMATE_NOTE, emit, on, scoring };

  const [matsM, lightM, archM, carM] = await Promise.all([
    tryImport(`${base}/src/world/materials.js`, 'materials(B2)'),
    tryImport(`${base}/src/world/lighting.js`, 'lighting(B3)'),
    tryImport(`${base}/src/world/architecture.js`, 'architecture(B1)'),
    tryImport(`${base}/src/world/carModels.js`, 'carModels(B4)'),
  ]);

  ctx.materials = matsM?.createMaterialLibrary ? matsM.createMaterialLibrary(ctx) : stubMaterials(THREE);
  ctx.lighting  = lightM?.createLightingSystem ? lightM.createLightingSystem(ctx) : stubLighting(THREE, scene);
  ctx.arch      = archM?.buildGallery ? archM : stubArch(THREE);
  ctx.carModels = carM?.createCarModels ? carM.createCarModels(ctx) : stubCarModels(THREE, cars);

  // 沒有真實 lighting 模組時，至少給一個環境貼圖，否則白色物件會完全沒層次
  if (ctx.lighting.__stub) {
    try {
      const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environmentIntensity = 0.85;
    } catch (e) { console.warn('[testkit] RoomEnvironment 不可用：', e.message); }
  }

  ctx.stubs = ['materials','lighting','arch','carModels'].filter(k => ctx[k].__stub);
  if (ctx.stubs.length) console.warn('[testkit] 使用 stub 的模組：', ctx.stubs.join(', '));

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  let raf = 0, last = performance.now(), t0 = last;
  ctx.startLoop = (cb) => {
    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.1); last = now;
      try { cb(dt, (now - t0) / 1000); } catch (e) { console.error(e); cancelAnimationFrame(raf); return; }
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  };
  ctx.stopLoop = () => cancelAnimationFrame(raf);
  return ctx;
}
