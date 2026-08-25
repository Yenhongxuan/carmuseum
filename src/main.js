/**
 * main.js — 第 3 階段整合（主代理單線程產出）
 *
 * 職責（子代理一律不碰）：
 *   1. B0 渲染管線：色彩管理、ACES tone mapping、IBL、陰影、抗鋸齒、後製
 *   2. 組出 ctx 並注入八個模組（依賴注入，展廳不 import world/）
 *   3. 六廳的進出、時間統計、相機與移動
 *   4. 驗收工具：灰階檢驗、FPS 量測、介面相容性檢查（掛在 window.__museum）
 *
 * 使用者裁決（第 2 階段結束時確認）已落實之處，全部記錄於 VERIFY.md。
 */
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { STATE, EVENTS, EV, ROOMS, SCENE_API, NO_DATA, ESTIMATE_NOTE, emit, on, EASE_FN } from './contract.js';
import * as scoring from './scoring.js';

const $ = (s) => document.querySelector(s);
const ui = $('#ui'), hudEl = $('#hud'), perfEl = $('#perf'), errEl = $('#err'), toastEl = $('#toast');

const errors = [];
function logErr(where, e) {
  const msg = `${where}：${e && e.message ? e.message : e}`;
  errors.push(msg);
  errEl.textContent = errors.slice(-4).join('\n');
  console.error(where, e);
}
window.addEventListener('error', (e) => logErr('未捕捉錯誤', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => logErr('未處理的 Promise', e.reason));

let toastTimer = 0;
function toast(text, ms = 4200) {
  toastEl.textContent = text; toastEl.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('on'), ms);
}

/* ════════════════════════════════════════════════════════════
   ① 渲染管線（B0 規格）
   ════════════════════════════════════════════════════════════ */
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // 直出路徑用；走後製時由 postMaterial 接手
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.05, 900);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xE9EBEE);   // 淺色，全程不用深色背景

/* --- 後製：暈影 + 色差 + 底片顆粒。★ 絕不使用 bloom ---
   ★ three 在「渲染到 render target」時不套用 tone mapping（已對照 r185 原始碼確認），
     所以 ACES 與 sRGB 編碼由本 shader 負責，順序：色差 → 暈影(線性) → ACES → sRGB → 顆粒。 */
const hdrRT = new THREE.WebGLRenderTarget(1, 1, {
  type: THREE.HalfFloatType, samples: 4,          // ★ MSAA 4x：後製會關掉畫布本身的 antialias
  colorSpace: THREE.NoColorSpace, depthBuffer: true, stencilBuffer: false,
});
const postMaterial = new THREE.ShaderMaterial({
  uniforms: {
    tDiffuse: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
    uExposure: { value: 1.0 }, uVignette: { value: 0.10 },
    uCA: { value: 0.0015 }, uGrain: { value: 0.022 }, uTime: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse; uniform vec2 uRes;
    uniform float uExposure, uVignette, uCA, uGrain, uTime;
    vec3 acesFit(vec3 v){ vec3 a = v*(v+0.0245786)-0.000090537;
      vec3 b = v*(0.983729*v+0.4329510)+0.238081; return a/b; }
    vec3 ACESFilmic(vec3 color){
      const mat3 IN = mat3(0.59719,0.07600,0.02840, 0.35458,0.90834,0.13383, 0.04823,0.01566,0.83777);
      const mat3 OUT= mat3(1.60475,-0.10208,-0.00327, -0.53108,1.10813,-0.07276, -0.07367,-0.00605,1.07602);
      color *= uExposure / 0.6; color = IN*color; color = acesFit(color); color = OUT*color;
      return clamp(color, 0.0, 1.0); }
    vec3 linearToSRGB(vec3 c){
      return mix(c*12.92, 1.055*pow(max(c,vec3(0.0)), vec3(0.41666))-0.055, step(vec3(0.0031308), c)); }
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
    void main(){
      vec2 uv = vUv; vec2 d = uv - 0.5; float r2 = dot(d, d);
      // ① 色差：只在畫面邊緣，強度極輕
      vec2 off = d * uCA * r2 * 4.0;
      vec3 col = vec3(texture2D(tDiffuse, uv + off).r,
                      texture2D(tDiffuse, uv).g,
                      texture2D(tDiffuse, uv - off).b);
      // ② 暈影：線性空間，邊緣壓暗 ~10%
      col *= 1.0 - uVignette * smoothstep(0.10, 0.75, r2);
      // ③ ACES + sRGB
      col = linearToSRGB(ACESFilmic(col));
      // ④ 底片顆粒：顯示空間，暗部略強（真實底片的樣子）
      float g = hash(gl_FragCoord.xy + fract(uTime) * 512.0) - 0.5;
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col += g * uGrain * (1.25 - 0.75 * lum);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
  depthTest: false, depthWrite: false,
  toneMapped: false,   // ★ 關鍵：本 shader 自己做 ACES，不可讓 three 再注入一次
});
const postScene = new THREE.Scene();
const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial));
let postEnabled = true;

function resize() {
  const w = innerWidth, h = innerHeight, dpr = Math.min(devicePixelRatio, 2);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  hdrRT.setSize(Math.floor(w * dpr), Math.floor(h * dpr));
  postMaterial.uniforms.uRes.value.set(w * dpr, h * dpr);
}
addEventListener('resize', resize); resize();

/* ════════════════════════════════════════════════════════════
   ② 資料與模組組裝
   ════════════════════════════════════════════════════════════ */
const bootBar = $('#bar i'), bootMsg = $('#bootmsg'), bootEl = $('#boot'), bootStart = $('#bootstart');
let bootStep = 0; const BOOT_TOTAL = 7;
function step(msg) {
  bootStep++; bootMsg.textContent = msg;
  bootBar.style.transform = `scaleX(${bootStep / BOOT_TOTAL})`;
  return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

const ROOM_META = [
  { key: ROOMS.GALLERY,    n: '一', t: '淘汰',   d: '39 台 → 28 個真正不同的選項', mod: './rooms/room1_elimination.js' },
  { key: ROOMS.PARKING,    n: '二', t: '車位',   d: '它進不進得去你家的那個格子',   mod: './rooms/room2_parking.js' },
  { key: ROOMS.VOID,       n: '三', t: '空無',   d: '五年 1,825 天，你只用 260 天', mod: './rooms/room3_void.js' },
  { key: ROOMS.FIVE_YEARS, n: '四', t: '五年',   d: '九個轉折，你的決定還成立嗎',   mod: './rooms/room4_fiveyears.js' },
  { key: ROOMS.CIRCUIT,    n: '五', t: '賽道',   d: '十個旋鈕，車陣立刻重排',       mod: './rooms/room5_circuit.js' },
  { key: ROOMS.COURT,      n: '六', t: '法庭',   d: '檢方逐一指控，你要怎麼辯',     mod: './rooms/room6_court.js' },
];

let cars, carsById, materials, lighting, arch, carModels, endingUI;
const ctx = {};

async function boot() {
  await step('讀取 39 台車的資料…');
  const res = await fetch('./data/cars.json');
  if (!res.ok) throw new Error(`cars.json ${res.status}`);
  cars = (await res.json()).cars;
  scoring.computeScores(cars);
  carsById = Object.fromEntries(cars.map(c => [c.id, c]));
  STATE.alive = cars.map(c => c.id);

  Object.assign(ctx, {
    THREE, renderer, scene, camera, cars, carsById, ui,
    STATE, EVENTS, EV, ROOMS, NO_DATA, ESTIMATE_NOTE, emit, on, scoring,
  });

  await step('生成 PBR 材質（程序貼圖）…');
  const matsM = await import('./world/materials.js');
  materials = matsM.createMaterialLibrary(ctx); ctx.materials = materials;

  await step('建立六場景光照與 IBL…');
  const lightM = await import('./world/lighting.js');
  lighting = lightM.createLightingSystem(ctx); ctx.lighting = lighting;

  await step('載入建築模組…');
  arch = await import('./world/architecture.js'); ctx.arch = arch;

  await step('生成 39 台車的示意模型…');
  const carM = await import('./world/carModels.js');
  carModels = carM.createCarModels(ctx); ctx.carModels = carModels;
  if (carModels.whenAssetsProbed) { try { await carModels.whenAssetsProbed(); } catch (_) {} }

  await step('串接六個展廳…');
  for (const m of ROOM_META) {
    m.module = await import(m.mod);
    SCENE_API.addRoom(m.key, { build: () => m.module.createRoom(ctx) });
  }

  // SCENE_API 的真實實作（契約規定由 main.js 覆寫）
  SCENE_API.getCarMesh = (id) => { try { return carModels.getCarMesh(id); } catch (e) { logErr('getCarMesh', e); return null; } };
  SCENE_API.getMaterial = (n) => { try { return materials.get(n); } catch (_) { return null; } };

  await step('準備完成');
  bootStart.classList.add('on');
  bootMsg.textContent = '';
}

/* ════════════════════════════════════════════════════════════
   ③ 展廳管理（進出、時間統計）
   ════════════════════════════════════════════════════════════ */
const roomCache = new Map();
let current = null, currentKey = null, elapsedInRoom = 0;
let aliveSnapshot = null;   // ★ 裁決③：法庭的淘汰只在法庭內生效

function ensureRoom(key) {
  if (roomCache.has(key)) return roomCache.get(key);
  const meta = ROOM_META.find(m => m.key === key);
  const t0 = performance.now();
  const handle = meta.module.createRoom(ctx);
  handle.__buildMs = performance.now() - t0;
  handle.group.visible = false;
  scene.add(handle.group);
  roomCache.set(key, handle);
  return handle;
}

async function gotoRoom(key) {
  if (key === currentKey) { closeNav(); return; }
  if (current) {
    try { current.exit(); } catch (e) { logErr(`${currentKey}.exit`, e); }
    current.group.visible = false;
    const v = STATE.visited[currentKey] || (STATE.visited[currentKey] = { enters: 0, ms: 0 });
    v.ms += elapsedInRoom * 1000;
    emit(EV.ROOM_EXIT, { room: currentKey });
    if (currentKey === ROOMS.COURT && aliveSnapshot) { STATE.alive = aliveSnapshot; aliveSnapshot = null; }
  }
  let handle;
  try { handle = ensureRoom(key); }
  catch (e) { logErr(`${key} 建立失敗`, e); toast(`展廳 ${key} 建立失敗，已留在原地。`); return; }

  if (key === ROOMS.COURT) aliveSnapshot = STATE.alive.slice();

  current = handle; currentKey = key; elapsedInRoom = 0;
  handle.group.visible = true;

  const rig = handle.rig || handle.lightRig;
  const meta = ROOM_META.find(m => m.key === key);
  // 光照 rig 指定的曝光與環境（rig 由展廳自己建，這裡讀 lighting 的對照表）
  try {
    const kind = (await import('./world/lighting.js')).ROOM_ENV_KIND[key];
    if (kind) lighting.setEnvironment(kind);
    if (lighting.envIntensityFor) scene.environmentIntensity = lighting.envIntensityFor(kind);
  } catch (e) { logErr('環境貼圖切換', e); }
  const exp = EXPOSURE[key] ?? 1.0;
  renderer.toneMappingExposure = exp;
  postMaterial.uniforms.uExposure.value = exp;

  const sp = handle.spawn || { pos: [0, 1.6, 6], yaw: 0 };
  controls.object.position.set(sp.pos[0], sp.pos[1], sp.pos[2]);
  yaw = sp.yaw || 0; pitch = 0; applyLook();
  standing = true;

  try { handle.enter(); } catch (e) { logErr(`${key}.enter`, e); }
  const v = STATE.visited[key] || (STATE.visited[key] = { enters: 0, ms: 0 });
  v.enters++;
  emit(EV.ROOM_ENTER, { room: key });
  renderNav();
  toast(`廳${meta.n} · ${meta.t} —— ${meta.d}`, 5200);
  closeNav();
}
const EXPOSURE = {
  [ROOMS.GALLERY]: 1.10, [ROOMS.PARKING]: 1.00, [ROOMS.VOID]: 0.90,
  [ROOMS.FIVE_YEARS]: 1.15, [ROOMS.CIRCUIT]: 0.85, [ROOMS.COURT]: 1.05,
};

/* ════════════════════════════════════════════════════════════
   ④ 第一人稱移動
   ════════════════════════════════════════════════════════════ */
const controls = new PointerLockControls(camera, renderer.domElement);
const EYE_STAND = 1.60, EYE_SIT = 1.10;   // 規格：眼高 160cm，坐下 110cm
let standing = true, eyeY = EYE_STAND;
let yaw = 0, pitch = 0;
const keys = new Set();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
function applyLook() { _euler.set(pitch, yaw, 0); camera.quaternion.setFromEuler(_euler); }

renderer.domElement.addEventListener('click', () => { if (!navOpen && bootEl.classList.contains('gone')) controls.lock(); });
document.addEventListener('mousemove', (e) => {
  if (!controls.isLocked) return;
  yaw -= e.movementX * 0.0021; pitch -= e.movementY * 0.0021;
  pitch = Math.max(-1.35, Math.min(1.35, pitch));
  applyLook();
});
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Tab') { e.preventDefault(); toggleNav(); }
  else if (e.code === 'KeyF') { standing = !standing; toast(standing ? '起身（眼高 160cm）' : '坐下（眼高 110cm）', 1800); }
  else if (e.code === 'KeyG') doGrayscale(!materials.isGrayscale());
  else if (e.code === 'KeyP') { postEnabled = !postEnabled; toast(`後製（暈影＋色差＋顆粒）${postEnabled ? '開啟' : '關閉'}`, 1800); }
  else if (e.code === 'KeyB') benchmark(5000).then(r => toast(`FPS 量測：平均 ${r.fps.toFixed(1)}｜1% low ${r.low1.toFixed(1)}｜${r.frames} 幀／${(r.ms / 1000).toFixed(1)} 秒`, 8000));
  else if (e.code === 'KeyE') showEnding();
  else if (/^Digit[1-6]$/.test(e.code)) gotoRoom(ROOM_META[+e.code.slice(5) - 1].key);
});
addEventListener('keyup', (e) => keys.delete(e.code));

const vel = new THREE.Vector3(), dir = new THREE.Vector3();
function move(dt) {
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? 4.6 : 2.1;  // 走路 ~2.1 m/s
  dir.set((keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0), 0,
          (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0));
  if (dir.lengthSq() > 0) dir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  vel.lerp(dir.multiplyScalar(speed), 1 - Math.pow(0.0016, dt));   // 自訂阻尼，非 linear
  const p = controls.object.position;
  p.x += vel.x * dt; p.z += vel.z * dt;
  const target = standing ? EYE_STAND : EYE_SIT;
  eyeY += (target - eyeY) * (1 - Math.pow(0.002, dt));
  p.y = eyeY + (current?.groundY || 0);
}

/* ════════════════════════════════════════════════════════════
   ⑤ 導覽 UI
   ════════════════════════════════════════════════════════════ */
const navEl = $('#nav'), doorsEl = $('#doors');
let navOpen = false;
function renderNav() {
  doorsEl.innerHTML = '';
  for (const m of ROOM_META) {
    const v = STATE.visited[m.key];
    const b = document.createElement('button');
    b.className = 'door' + (m.key === currentKey ? ' here' : '');
    b.innerHTML = `<span class="n">廳${m.n}</span>
      <span class="t">${m.t}<small>${m.d}</small></span>
      <span class="v">${v ? `去過 ${v.enters} 次 · ${(v.ms / 1000).toFixed(0)} 秒` : '尚未進入'}</span>`;
    b.onclick = () => gotoRoom(m.key);
    doorsEl.appendChild(b);
  }
  const e = document.createElement('button');
  e.className = 'door'; e.innerHTML = `<span class="n">結局</span>
    <span class="t">你的一夜怎麼過的<small>你沒去的地方，是你的選擇</small></span><span class="v">E</span>`;
  e.onclick = () => showEnding();
  doorsEl.appendChild(e);
}
function toggleNav() { navOpen ? closeNav() : openNav(); }
function openNav() { navOpen = true; renderNav(); navEl.classList.add('on'); controls.unlock(); }
function closeNav() { navOpen = false; navEl.classList.remove('on'); }

async function showEnding() {
  try {
    if (!endingUI) {
      const m = await import('./rooms/ending.js');
      endingUI = m.createEnding(ctx);
    }
    if (currentKey) {
      const v = STATE.visited[currentKey]; if (v) { v.ms += elapsedInRoom * 1000; elapsedInRoom = 0; }
    }
    controls.unlock(); closeNav(); endingUI.show();
  } catch (e) { logErr('結局', e); toast('結局載入失敗。'); }
}

/* ════════════════════════════════════════════════════════════
   ⑥ 驗收工具（灰階檢驗 / FPS 量測 / 介面檢查）
   ════════════════════════════════════════════════════════════ */
function doGrayscale(on) {
  try {
    materials.setGrayscale(on);
    toast(on ? '灰階檢驗：Albedo 全改中性灰 #808080，只留 Roughness 與 Normal。分辨得出材質差異才算通過。'
             : '灰階檢驗關閉，材質已還原。', 6000);
  } catch (e) { logErr('灰階檢驗', e); }
}

function benchmark(ms = 5000) {
  return new Promise((resolve) => {
    const times = []; const t0 = performance.now();
    benchHook = (frameMs) => {
      times.push(frameMs);
      if (performance.now() - t0 >= ms) {
        benchHook = null;
        const sorted = times.slice().sort((a, b) => b - a);
        const worst = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.01)));
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        resolve({ fps: 1000 / avg, low1: 1000 / (worst.reduce((a, b) => a + b, 0) / worst.length),
                  frames: times.length, ms: performance.now() - t0 });
      }
    };
  });
}
let benchHook = null;

/** 給自動化驗收用的 API */
window.__museum = {
  gotoRoom, benchmark, showEnding,
  setGrayscale: doGrayscale,
  setPost: (on) => { postEnabled = on; },
  errors: () => errors.slice(),
  rooms: () => ROOM_META.map(m => m.key),
  stats: () => ({
    drawCalls: sceneInfo.calls, triangles: sceneInfo.triangles,
    programs: renderer.info.programs?.length ?? -1, geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures, room: currentKey,
    materialStats: materials.stats ? materials.stats() : null,
  }),
  __scene: scene, __camera: camera,
  dims: () => arch.DIMENSIONS,
  /** 驗收截圖：必須在同一個 task 內 render 後立刻讀，否則 drawingBuffer 已被清除 */
  capture: () => { renderFrame(); return renderer.domElement.toDataURL('image/png'); },
  tiers: () => cars.map(c => ({ id: c.id, model: c.model, trim: c.trim, ...carModels.getTier(c.id) })),
  ready: false,
};

/* ════════════════════════════════════════════════════════════
   ⑦ 主迴圈
   ════════════════════════════════════════════════════════════ */
let sceneInfo = { calls: 0, triangles: 0, lines: 0, points: 0 };
function grabInfo() {
  const i = renderer.info.render;
  sceneInfo = { calls: i.calls, triangles: i.triangles, lines: i.lines, points: i.points };
}
function renderFrame() {
  if (postEnabled) {
    renderer.setRenderTarget(hdrRT);
    renderer.render(scene, camera);
    grabInfo();                       // ★ 必須在後製那一趟之前取，否則只會讀到後製的 1 個 draw call
    renderer.setRenderTarget(null);
    postMaterial.uniforms.tDiffuse.value = hdrRT.texture;
    renderer.render(postScene, postCamera);
  } else {
    renderer.render(scene, camera);
    grabInfo();
  }
}

let last = performance.now(), t0 = last, fpsAcc = 0, fpsFrames = 0, fpsShown = 0;
function tick(now) {
  requestAnimationFrame(tick);
  const raw = now - last; last = now;
  const dt = Math.min(raw / 1000, 0.1);
  const elapsed = (now - t0) / 1000;

  if (controls.isLocked) move(dt);
  elapsedInRoom += dt;

  if (current) {
    try { current.update(dt, elapsedInRoom, camera); } catch (e) { logErr(`${currentKey}.update`, e); }
  }
  if (materials.update) { try { materials.update(elapsed); } catch (_) {} }

  postMaterial.uniforms.uTime.value = elapsed;
  renderFrame();

  if (benchHook) benchHook(raw);
  fpsAcc += raw; fpsFrames++;
  if (fpsAcc >= 500) {
    fpsShown = 1000 / (fpsAcc / fpsFrames); fpsAcc = 0; fpsFrames = 0;
    perfEl.textContent = `${fpsShown.toFixed(0)} fps　·　${sceneInfo.calls} draw calls　·　${(sceneInfo.triangles / 1000).toFixed(0)}k tri`
      + (materials.isGrayscale() ? '\n【灰階檢驗中】' : '') + (postEnabled ? '' : '\n【後製關閉】');
  }
  const meta = ROOM_META.find(m => m.key === currentKey);
  if (meta) hudEl.innerHTML = `<b>廳${meta.n} · ${meta.t}</b>　Tab 導覽　·　${controls.isLocked ? 'WASD 移動' : '點畫面鎖定滑鼠'}`;
}

/* ════════════════════════════════════════════════════════════
   ⑧ 啟動
   ════════════════════════════════════════════════════════════ */
boot().then(() => {
  window.__museum.ready = true;
  requestAnimationFrame(tick);
  bootStart.onclick = async () => {
    bootEl.classList.add('gone');
    setTimeout(() => { bootEl.style.display = 'none'; }, 950);
    await gotoRoom(ROOMS.GALLERY);
  };
}).catch((e) => {
  logErr('啟動失敗', e);
  bootMsg.textContent = `啟動失敗：${e.message}`;
});
