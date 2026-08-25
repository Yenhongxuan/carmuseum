/**
 * room2_parking.js — B5 廳二 · 台灣舊社區窄巷 · 車位（第 2 階段子代理產出）
 *
 * 假設：
 *   1. ctx 依 MODULE_API.md §4 提供；單獨測試時由 src/testkit.js 組出最小 ctx。
 *   2. 1 three.js unit = 1 公尺；Y 軸向上；地面 y = 0；車輛本地 -Z 為車頭方向，
 *      原點在四輪接地面的車身正中心（MODULE_API.md §0）。
 *   3. ctx.arch.buildAlley(ctx) 的巷子沿 **Z 軸** 延伸、以原點為中心，
 *      巷寬預設 3.6 m（牆在 x = ±1.8）。若 ctx.arch.DIMENSIONS.alley 提供
 *      width / length（公尺）則以它為準。
 *   4. 「自家車位」是巷子 **+X 側的一個開口**（垂直式車位）：
 *      車位長沿 X、車位寬沿 Z、車位高沿 Y。車頭朝 +X 開進去。
 *   5. 規格書寫「塞不進 → 卡在巷口」；本模組把「巷口」實作為 **車位入口**
 *      （車位口正好開在巷壁上，視覺上就是巷子的開口），車頭進去一半後倒車離開。
 *   6. 車輛尺寸一律以 data/cars.json 的 mm 為準（規格表就是這份資料），
 *      不用 ctx.carModels.getFootprint()，避免兩份數字打架。
 *   7. ctx.arch / ctx.lighting / ctx.carModels 若尚未就緒，退回內建極簡替身。
 *
 * 依賴：ctx.arch / ctx.materials / ctx.lighting / ctx.carModels（依賴注入，不 import）
 *       只 import ../contract.js 與 ../scoring.js
 *
 * 未達成的規格：
 *   - 「車身擦到牆」以車尾左右擺動 ＋ 巷壁上出現一道淺色擦痕貼片表現，
 *     沒有真正的碰撞偵測（沒有物理引擎）。
 *   - 進場節奏是「每 1.5 秒放一台進巷子」（規格要求），但車位一次只容得下一台，
 *     所以後面的車會在巷子裡排隊（這反而比較像真的舊社區）。實測整場：
 *     全部塞得進約 79 秒、全部塞不進約 128 秒（失敗動畫本身就要 2.6 秒），
 *     比 39×1.5＝58.5 秒長。另備「全部快轉」按鈕直接看結果。
 *   - 車重無官方資料，機械車位限重一律不判定（畫面已明確標註）。
 */

import { ROOMS, STATE, EV, EASE, EASE_FN, NO_DATA, emit, on } from '../contract.js';
import { computeScores } from '../scoring.js';

export const ROOM_KEY = ROOMS.PARKING;

/* ══════════════════════════════════════════════════════════════════════════
 *  單位換算 —— 這是本廳最容易出錯的地方，全檔只走這一組函式。
 *
 *    data/cars.json 的 length / width / height / wheelbase  →  **mm**
 *    STATE.slot 的 len / wid / hei（使用者車位）             →  **cm**
 *    three.js 的所有座標與尺寸                                →  **公尺 (m)**
 *
 *    mm → cm : ÷ 10        mm → m : ÷ 1000
 *    cm → mm : × 10        cm → m : ÷ 100
 *
 *  比較「車塞不塞得進車位」時，一律先把兩邊都換成 **公分**再比，
 *  因為 cm 是使用者面對的單位（滑桿、餘裕數字都是 cm），可避免浮點誤差累積。
 * ══════════════════════════════════════════════════════════════════════════ */
const mm2cm = (mm) => mm / 10;
const mm2m  = (mm) => mm / 1000;
const cm2m  = (cm) => cm / 100;
const cm2mm = (cm) => cm * 10;

/* 滑桿範圍（公分）——規格指定 */
const SLOT_RANGE = {
  len: { min: 400, max: 560, step: 1, label: '車位長' },
  wid: { min: 200, max: 280, step: 1, label: '車位寬' },
  hei: { min: 150, max: 250, step: 1, label: '車位高' },
};

/* 參考資訊（規格指定必須顯示） */
const REF_LEGAL   = '台灣法定最小平面車位 250×550cm';
const REF_MECH    = '機械車位常見 200×500cm';
/* 規格指定：一字不可改 */
const WEIGHT_WARNING = '⚠ 車重全無官方資料，機械車位的限重無法判定。';

/* 動效時間（秒） */
const SPAWN_GAP   = 1.5;   // 每台進巷子的間隔
const T_PARK      = 0.50;  // 入庫
const T_HOLD      = 0.60;  // 停好後的靜止（關鍵時刻前的靜止）
const T_OUT       = 0.45;  // 出庫
const T_FAIL_IN   = 0.90;  // 車頭進去一半
const T_FAIL_STOP = 0.20;  // 停住
const T_FAIL_WAG  = 0.70;  // 輕微左右擺動
const T_FAIL_OUT  = 0.80;  // 倒退出去      → 合計 2.60 秒（規格要求 2–3 秒）

const ENTRY_Z = 15;        // 巷口
const EXIT_Z  = -16;       // 巷尾

/* ─────────── 自訂 cubic-bezier（禁用 linear 與預設 ease） ─────────── */
/** 回傳 t∈[0,1] → 進度的函式。牛頓法解 x(t)=x，再取 y。 */
function cubicBezier(x1, y1, x2, y2) {
  const A = (a, b) => 1 - 3 * b + 3 * a;
  const B = (a, b) => 3 * b - 6 * a;
  const C = (a) => 3 * a;
  const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const s = slope(t, x1, x2);
      if (Math.abs(s) < 1e-6) break;
      t -= (calc(t, x1, x2) - x) / s;
    }
    return calc(t, y1, y2);
  };
}
/** 失敗動畫專用的兩條自訂曲線 */
const EZ_NOSE_IN  = cubicBezier(0.16, 0.84, 0.44, 1.00);   // 進去一半：衝一下、被卡住
const EZ_BACK_OUT = cubicBezier(0.55, 0.00, 0.35, 1.00);   // 倒車離開：慢起、順出
const EZ_PARK     = EASE_FN.inOutQuint;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const carName = (c) => `${c.brand} ${c.model} ${c.trim}`;
const cargoText = (c) => (c.cargo == null ? (c.cargoNote || NO_DATA) : `${c.cargo} L`);

/* ═════════════════ 核心計算：塞不塞得進去、餘裕多少 ═════════════════ */
/**
 * @param car  cars.json 的一台車（mm）
 * @param slot STATE.slot（cm）
 * @returns    全部以 **公分** 表示的餘裕
 */
export function evaluateFit(car, slot) {
  const L = mm2cm(car.length);      // 車長 cm
  const W = mm2cm(car.width);       // 車寬 cm
  const H = mm2cm(car.height);      // 車高 cm
  const lenClear = slot.len - L;                 // 長度餘裕 cm
  const widClear = slot.wid - W;                 // 寬度總餘裕 cm
  const heiClear = slot.hei - H;                 // 高度餘裕 cm
  const doorClear = widClear / 2;                // ★ 開門餘裕 = (車位寬 − 車寬) / 2，每側 cm
  const fits = lenClear >= 0 && widClear >= 0 && heiClear >= 0;
  const fails = [];
  if (lenClear < 0) fails.push(`長度差 ${(-lenClear).toFixed(1)} cm`);
  if (widClear < 0) fails.push(`寬度差 ${(-widClear).toFixed(1)} cm`);
  if (heiClear < 0) fails.push(`高度差 ${(-heiClear).toFixed(1)} cm`);
  let doorVerdict = null;
  if (fits) {
    doorVerdict = doorClear < 15 ? '側身才能下車' : doorClear <= 30 ? '勉強' : '舒適';
  }
  return { car, L, W, H, lenClear, widClear, heiClear, doorClear, fits, fails, doorVerdict };
}

/** 全車隊一次算完 */
export function evaluateAll(cars, slot) {
  const rows = cars.map((c) => evaluateFit(c, slot));
  return {
    rows,
    inCount: rows.filter((r) => r.fits).length,
    outCount: rows.filter((r) => !r.fits).length,
    /** 放得下全部 39 台所需的最小車位（公分） */
    needed: {
      len: Math.max(...cars.map((c) => mm2cm(c.length))),
      wid: Math.max(...cars.map((c) => mm2cm(c.width))),
      hei: Math.max(...cars.map((c) => mm2cm(c.height))),
    },
  };
}

/* ─────────── B4 未就緒時的替身車隊 ─────────── */
function makeFallbackFleet(THREE, list) {
  const group = new THREE.Group();
  group.name = 'b5.fallbackFleet';
  const meshes = list.map((c) => {
    const g = new THREE.BoxGeometry(mm2m(c.width), mm2m(c.height), mm2m(c.length));
    g.translate(0, mm2m(c.height) / 2, 0);
    const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(c.brandColor || '#C8CBD0'), roughness: 0.58, metalness: 0.04 });
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  });
  return {
    group, __fallback: true,
    setTransform(i, pos, quat) { const m = meshes[i]; if (!m) return; m.position.copy(pos); if (quat) m.quaternion.copy(quat); },
    setHighlight(i, on) { const m = meshes[i]; if (!m) return; m.scale.setScalar(on ? 1.03 : 1); },
    setVisible(i, on) { if (meshes[i]) meshes[i].visible = !!on; },
    indexOf(id) { return list.findIndex((c) => c.id === id); },
    commit() {},
    dispose() { for (const m of meshes) { m.geometry.dispose(); m.material.dispose(); } },
  };
}

/* ═════════════════════════════ 主體 ═════════════════════════════ */
export function createRoom(ctx) {
  const THREE = ctx.THREE;
  const cars = ctx.cars || [];
  if (cars.length && !cars[0].s) { try { computeScores(cars); } catch (_) {} }

  const group = new THREE.Group();
  group.name = ROOM_KEY;
  const disposables = [];
  const offs = [];
  let entered = false;

  /* ── 建築 ── */
  let archGroup = null;
  try {
    if (ctx.arch && typeof ctx.arch.buildAlley === 'function') {
      archGroup = ctx.arch.buildAlley(ctx);
      if (archGroup) group.add(archGroup);
    }
  } catch (e) { console.warn('[room2] buildAlley 失敗，改用空巷：', e); }

  const ad = (ctx.arch && ctx.arch.DIMENSIONS && ctx.arch.DIMENSIONS.alley) || null;
  const ALLEY_W = clamp(Number(ad && (ad.width ?? ad.w)) || 3.6, 2.6, 6.0);
  const ALLEY_HALF = ALLEY_W / 2;

  if (!archGroup) {
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(ALLEY_W, 40),
      new THREE.MeshStandardMaterial({ color: 0xB9BBBE, roughness: 0.95, metalness: 0 })
    );
    road.rotation.x = -Math.PI / 2; road.position.y = 0.001; road.receiveShadow = true;
    group.add(road);
    disposables.push({ dispose: () => { road.geometry.dispose(); road.material.dispose(); } });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xD5D3CE, roughness: 0.9, metalness: 0 });
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.24, 5.2, 40), wallMat);
      w.position.set(sx * (ALLEY_HALF + 0.12), 2.6, 0);
      w.castShadow = true; w.receiveShadow = true;
      group.add(w);
      disposables.push({ dispose: () => w.geometry.dispose() });
    }
    disposables.push({ dispose: () => wallMat.dispose() });
  }

  /* ── 光照 ── */
  let rig = null;
  try {
    if (ctx.lighting && typeof ctx.lighting.makeRig === 'function') {
      rig = ctx.lighting.makeRig(ROOM_KEY);
      if (rig && rig.group) group.add(rig.group);
    }
  } catch (e) { console.warn('[room2] makeRig 失敗：', e); }
  if (!rig) {
    const hemi = new THREE.HemisphereLight(0xFFFFFF, 0xC9CBCF, 0.7);
    const sun = new THREE.DirectionalLight(0xFFFDF6, 2.4);
    sun.position.set(-7, 15, 6); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.normalBias = 0.03;
    sun.shadow.camera.left = -18; sun.shadow.camera.right = 18;
    sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22; sun.shadow.camera.far = 60;
    group.add(hemi, sun);
    rig = { group: null, exposure: 1.0, envKind: 'alley', update() {}, dispose() { hemi.dispose(); sun.dispose(); } };
  }

  /* ═══════════ 車位框（細線框 + 地面白線，不發光） ═══════════ */
  const slotRoot = new THREE.Group(); slotRoot.name = 'b5.slot'; group.add(slotRoot);

  // 3D 細線框：單位立方體的邊，之後靠 scale 即時變形（oninput 拖動就會動）
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const edgeGeo = new THREE.EdgesGeometry(boxGeo);
  boxGeo.dispose();
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x8E939B, transparent: true, opacity: 0.92 });
  const wireBox = new THREE.LineSegments(edgeGeo, edgeMat);
  slotRoot.add(wireBox);
  disposables.push({ dispose: () => { edgeGeo.dispose(); edgeMat.dispose(); } });

  // 地面白線：三條（左、右、底），厚度固定 0.12 m，只縮放長度方向
  const lineGeo = new THREE.PlaneGeometry(1, 1);
  let lineMat = null;
  try { lineMat = ctx.materials && ctx.materials.get ? ctx.materials.get('roadline') : null; } catch (_) { lineMat = null; }
  if (!lineMat) {
    lineMat = new THREE.MeshStandardMaterial({ color: 0xF0F0EE, roughness: 0.85, metalness: 0 });
    disposables.push({ dispose: () => lineMat.dispose() });
  }
  const gLines = [0, 1, 2].map(() => {
    const m = new THREE.Mesh(lineGeo, lineMat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.006;
    m.receiveShadow = false;
    slotRoot.add(m);
    return m;
  });
  disposables.push({ dispose: () => lineGeo.dispose() });

  // 地面餘裕讀數（CanvasTexture）
  const readCanvas = document.createElement('canvas');
  readCanvas.width = 900; readCanvas.height = 260;
  const readTex = new THREE.CanvasTexture(readCanvas);
  readTex.colorSpace = THREE.SRGBColorSpace;    // Albedo 必須 SRGB（MODULE_API §1.2）
  const readMat = new THREE.MeshBasicMaterial({ map: readTex, transparent: true, opacity: 0, depthWrite: false });
  const readPlane = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 0.78), readMat);
  readPlane.rotation.x = -Math.PI / 2;
  readPlane.position.y = 0.012;
  slotRoot.add(readPlane);
  disposables.push({ dispose: () => { readTex.dispose(); readMat.dispose(); readPlane.geometry.dispose(); } });

  // 擦痕貼片（失敗時出現在巷壁上）
  const scuffMat = new THREE.MeshBasicMaterial({ color: 0x9A9187, transparent: true, opacity: 0, depthWrite: false });
  const scuff = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.16), scuffMat);
  scuff.rotation.y = -Math.PI / 2;
  group.add(scuff);
  disposables.push({ dispose: () => { scuffMat.dispose(); scuff.geometry.dispose(); } });

  /* 車位幾何（公尺）：長沿 X、寬沿 Z、高沿 Y，入口貼著巷子 +X 側牆 */
  const BAY_X0 = ALLEY_HALF;              // 車位入口的 x
  const LANE_X = -0.28;                   // 車道中心線 x（靠左一點，留出轉彎空間）
  function slotDims() {
    return { L: cm2m(STATE.slot.len), W: cm2m(STATE.slot.wid), H: cm2m(STATE.slot.hei) };
  }
  function bayCenterX() { return BAY_X0 + slotDims().L / 2; }

  function refreshSlotGeometry() {
    const { L, W, H } = slotDims();
    const cx = BAY_X0 + L / 2;
    wireBox.scale.set(L, H, W);
    wireBox.position.set(cx, H / 2, 0);
    // 左右兩條白線（沿 X），底線（沿 Z）
    gLines[0].scale.set(L, 0.12, 1); gLines[0].position.set(cx, 0.006, -W / 2);
    gLines[1].scale.set(L, 0.12, 1); gLines[1].position.set(cx, 0.006, +W / 2);
    gLines[2].scale.set(0.12, W, 1); gLines[2].position.set(BAY_X0 + L, 0.006, 0);
    readPlane.position.set(BAY_X0 + L * 0.62, 0.012, 0);
    scuff.position.set(BAY_X0 - 0.02, 0.55, -W / 2 - 0.05);
  }
  refreshSlotGeometry();

  function drawReadout(r) {
    const g = readCanvas.getContext('2d');
    g.clearRect(0, 0, 900, 260);
    g.fillStyle = 'rgba(248,248,249,0.93)'; g.fillRect(0, 0, 900, 260);
    g.strokeStyle = r.fits ? '#9BA1A9' : '#B98A84'; g.lineWidth = 4; g.strokeRect(2, 2, 896, 256);
    const F = (px, w) => `${w || 400} ${px}px "Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif`;
    g.fillStyle = '#22252B'; g.font = F(40, 600);
    if (r.fits) {
      g.fillText(`開門餘裕 ${r.doorClear.toFixed(1)} cm／每側`, 34, 68);
      g.font = F(34, 500); g.fillStyle = '#4A4F57';
      g.fillText(`「${r.doorVerdict}」`, 34, 116);
      g.font = F(28, 400); g.fillStyle = '#5C626B';
      g.fillText(`長度餘裕 ${r.lenClear.toFixed(1)} cm　　高度餘裕 ${r.heiClear.toFixed(1)} cm`, 34, 166);
      g.font = F(22, 400); g.fillStyle = '#7E838B';
      g.fillText(`開門餘裕 =（車位寬 ${STATE.slot.wid} − 車寬 ${r.W.toFixed(1)}）÷ 2`, 34, 210);
    } else {
      g.fillStyle = '#8A3A34';
      g.fillText('塞不進去', 34, 70);
      g.font = F(30, 500); g.fillStyle = '#5C626B';
      g.fillText(r.fails.join('　'), 34, 124);
      g.font = F(24, 400); g.fillStyle = '#7E838B';
      g.fillText(`車身 ${r.L.toFixed(1)} × ${r.W.toFixed(1)} × ${r.H.toFixed(1)} cm`, 34, 172);
      g.fillText(`車位 ${STATE.slot.len} × ${STATE.slot.wid} × ${STATE.slot.hei} cm`, 34, 210);
    }
    readTex.needsUpdate = true;
  }

  /* ═══════════ 車隊 ═══════════ */
  const ordered = cars.slice();
  let fleet = null;
  try {
    if (ctx.carModels && typeof ctx.carModels.createFleet === 'function') {
      fleet = ctx.carModels.createFleet(ordered.map((c) => c.id));
    }
  } catch (e) { console.warn('[room2] createFleet 失敗，改用替身：', e); }
  if (!fleet) { fleet = makeFallbackFleet(THREE, ordered); disposables.push(fleet); }
  if (fleet.group) group.add(fleet.group);

  const idxOf = new Map();
  ordered.forEach((c, i) => {
    let k = i;
    try { if (typeof fleet.indexOf === 'function') { const j = fleet.indexOf(c.id); if (j >= 0) k = j; } } catch (_) {}
    idxOf.set(c.id, k);
  });
  function setVis(carId, on) { try { fleet.setVisible(idxOf.get(carId), on); } catch (_) {} }
  ordered.forEach((c) => setVis(c.id, false));

  /* ═══════════ 進場流程狀態機 ═══════════ */
  /**
   * phase: 'in'(開進巷子/排隊) → 'park'|'failin' → 'hold'|'failstop'/'failwag'
   *        → 'out'|'failout' → 'away' → 'done'
   * 車位是互斥資源（一次一台）；排不上的就在巷子裡排隊。
   */
  const actors = [];          // 進行中的車
  let queueHead = null;       // 正在用車位的 actor
  let spawnTimer = 0, spawnPtr = 0, running = false, finished = false;
  let fitInfo = evaluateAll(cars, STATE.slot);
  const results = new Map();  // carId -> 結果列（實際跑過的）

  function makeActor(car) {
    return {
      car, id: car.id, idx: idxOf.get(car.id),
      x: LANE_X, z: ENTRY_Z, yaw: 0, phase: 'in', t: 0,
      fx: LANE_X, fyaw: 0, fz: 0,    // 階段起點
      r: evaluateFit(car, STATE.slot),
      qz: ENTRY_Z,
    };
  }

  function startParade(fromIndex = 0) {
    for (const a of actors) setVis(a.id, false);
    actors.length = 0;
    queueHead = null;
    spawnPtr = fromIndex; spawnTimer = SPAWN_GAP; running = true; finished = false;   // 第一台立刻進場
    readMat.opacity = 0; scuffMat.opacity = 0;
    refreshPanel();
  }

  function replayOne(carId) {
    const car = cars.find((c) => c.id === carId);
    if (!car) return;
    for (const a of actors) setVis(a.id, false);
    actors.length = 0; queueHead = null;
    running = false; finished = false;
    readMat.opacity = 0; scuffMat.opacity = 0;
    const a = makeActor(car);
    actors.push(a); setVis(a.id, true);
    setCurrent(a);
  }

  function fastForward() {
    running = false;
    for (const a of actors) setVis(a.id, false);
    actors.length = 0; queueHead = null; spawnPtr = ordered.length;
    for (const c of cars) results.set(c.id, evaluateFit(c, STATE.slot));
    finished = true;
    readMat.opacity = 0;
    refreshPanel();
  }

  /* ═══════════ DOM ═══════════ */
  let root = null, elCur = null, elCounts = null, elList = null, elNeed = null;

  function buildDom() {
    root = document.createElement('div');
    root.className = 'b5r2';
    root.innerHTML = `
<style>
.b5r2{position:absolute;inset:0;pointer-events:none;color:#22252B;
  font:400 14px/1.55 "Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;}
.b5r2 .card{pointer-events:auto;background:rgba(250,250,251,.94);border:1px solid #DCDFE4;
  border-radius:10px;box-shadow:0 6px 22px rgba(28,32,38,.09);backdrop-filter:blur(6px);}
.b5r2 h2{margin:0 0 6px;font-size:16px;font-weight:600;letter-spacing:.02em;}
.b5r2 .sub{color:#6B7078;font-size:12.5px;}
.b5r2 .slot{position:absolute;left:22px;top:22px;width:338px;padding:16px 18px;}
.b5r2 .row{display:flex;align-items:center;gap:10px;margin:9px 0;}
.b5r2 .row label{width:56px;font-size:13px;color:#3A3E45;}
.b5r2 .row input[type=range]{flex:1;}
.b5r2 .row .v{width:66px;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;color:#22252B;}
.b5r2 .ref{margin-top:10px;font-size:11.8px;color:#6B7078;line-height:1.7;
  border-top:1px solid #E4E6EA;padding-top:9px;}
.b5r2 .warn{margin-top:9px;font-size:12.6px;font-weight:600;color:#8A3A34;
  background:#F7EFEE;border:1px solid #E6D2CF;border-radius:7px;padding:7px 9px;}
.b5r2 .ov{position:absolute;right:22px;top:22px;width:330px;padding:16px 18px;
  max-height:calc(100vh - 44px);display:flex;flex-direction:column;}
.b5r2 .counts{display:flex;gap:10px;margin:8px 0 4px;}
.b5r2 .pill{flex:1;border:1px solid #DCDFE4;border-radius:8px;padding:9px 10px;text-align:center;
  transition:transform 180ms ${EASE.micro},box-shadow 180ms ${EASE.micro};}
.b5r2 .pill b{display:block;font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;}
.b5r2 .pill.in b{color:#2C5F4A;} .b5r2 .pill.out b{color:#8A3A34;}
.b5r2 .pill span{font-size:11.5px;color:#6B7078;}
.b5r2 .list{margin-top:9px;overflow:auto;flex:1;min-height:0;border-top:1px solid #E4E6EA;padding-top:6px;}
.b5r2 .it{display:flex;justify-content:space-between;align-items:center;gap:8px;
  padding:5px 7px;border-radius:6px;cursor:pointer;font-size:12.4px;
  transition:transform 160ms ${EASE.micro},background 160ms ${EASE.micro};}
.b5r2 .it:hover{background:#EFF1F3;transform:translateX(3px) scale(1.012);}
.b5r2 .it .n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.b5r2 .it .m{flex:none;font-variant-numeric:tabular-nums;color:#4A4F57;font-size:11.6px;}
.b5r2 .it.bad .m{color:#8A3A34;}
.b5r2 .cur{position:absolute;left:50%;bottom:22px;transform:translateX(-50%) translateY(12px);
  width:min(560px,calc(100vw - 44px));padding:14px 18px;opacity:0;
  transition:opacity 320ms ${EASE.component},transform 320ms ${EASE.component};}
.b5r2 .cur.on{opacity:1;transform:translateX(-50%) translateY(0);}
.b5r2 .cur .t{font-size:15px;font-weight:600;}
.b5r2 .cur .m{margin-top:5px;font-size:13px;color:#3A3E45;}
.b5r2 .cur .m.bad{color:#8A3A34;}
.b5r2 .cur .f{margin-top:6px;font-size:11.5px;color:#7E838B;}
.b5r2 .btn{pointer-events:auto;display:inline-block;padding:6px 12px;border:1px solid #C7CBD1;border-radius:7px;
  background:#FFF;color:#22252B;font-size:12.5px;cursor:pointer;margin-right:6px;
  transition:transform 170ms ${EASE.micro},box-shadow 170ms ${EASE.micro},background 170ms ${EASE.micro};}
.b5r2 .btn:hover{transform:scale(1.05);box-shadow:0 4px 12px rgba(28,32,38,.14);background:#F3F4F6;}
.b5r2 .btn:active{transform:scale(.985);}
</style>
<div class="card slot">
  <h2>廳二 · 窄巷 · 先拉出你家的車位</h2>
  <div class="sub">三根滑桿，拖動時 3D 框會即時變形。</div>
  <div data-el="sliders"></div>
  <div class="ref">
    參考：<b>${REF_LEGAL}</b>　｜　<b>${REF_MECH}</b><br>
    巷道寬 ${ALLEY_W.toFixed(1)} m；本次 39 台最寬 1.87 m（Mufasa），巷子本身都進得去，
    <b>是車位框塞不塞得下</b>決定成敗。
  </div>
  <div class="warn">${WEIGHT_WARNING}</div>
  <div style="margin-top:10px">
    <span class="btn" data-act="start">從第 1 台開始開進來</span>
    <span class="btn" data-act="ff">全部快轉</span>
  </div>
  <div class="sub" style="margin-top:7px" data-el="need"></div>
</div>
<div class="card ov">
  <h2>總覽</h2>
  <div class="counts">
    <div class="pill in"><b data-el="cin">0</b><span>進得去</span></div>
    <div class="pill out"><b data-el="cout">0</b><span>進不去</span></div>
  </div>
  <div class="sub">點任一台可重播那一台的進場。</div>
  <div class="list" data-el="list"></div>
</div>
<div class="card cur" data-el="cur"></div>`;

    const sl = root.querySelector('[data-el=sliders]');
    for (const k of ['len', 'wid', 'hei']) {
      const R = SLOT_RANGE[k];
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<label>${R.label}</label>
        <input type="range" min="${R.min}" max="${R.max}" step="${R.step}" value="${clamp(STATE.slot[k], R.min, R.max)}" data-s="${k}">
        <span class="v" data-sv="${k}">${clamp(STATE.slot[k], R.min, R.max)} cm</span>`;
      sl.appendChild(row);
    }
    // ★ 一律 oninput：拖動過程中框就要即時變形
    sl.addEventListener('input', (e) => {
      const k = e.target && e.target.dataset && e.target.dataset.s;
      if (!k) return;
      STATE.slot[k] = parseInt(e.target.value, 10);
      const v = root.querySelector(`[data-sv="${k}"]`);
      if (v) v.textContent = `${STATE.slot[k]} cm`;
      refreshSlotGeometry();
      fitInfo = evaluateAll(cars, STATE.slot);
      for (const a of actors) a.r = evaluateFit(a.car, STATE.slot);
      results.clear();
      refreshPanel();
      emit(EV.SLOT_CHANGED, { room: ROOM_KEY, slot: { ...STATE.slot } });
      emit(EV.STATE_CHANGED, { keys: ['slot'], room: ROOM_KEY });
    });

    root.addEventListener('click', (e) => {
      const t = e.target.closest ? e.target.closest('[data-act],[data-car]') : null;
      if (!t) return;
      if (t.dataset.act === 'start') startParade(0);
      else if (t.dataset.act === 'ff') fastForward();
      else if (t.dataset.car) replayOne(t.dataset.car);
    });

    elCur = root.querySelector('[data-el=cur]');
    elCounts = { in: root.querySelector('[data-el=cin]'), out: root.querySelector('[data-el=cout]') };
    elList = root.querySelector('[data-el=list]');
    elNeed = root.querySelector('[data-el=need]');
    (ctx.ui || document.body).appendChild(root);
    refreshPanel();
  }

  function refreshPanel() {
    if (!root) return;
    elCounts.in.textContent = String(fitInfo.inCount);
    elCounts.out.textContent = String(fitInfo.outCount);
    const n = fitInfo.needed;
    elNeed.innerHTML = `放得下全部 39 台所需的最小車位：<b>${n.len.toFixed(1)} × ${n.wid.toFixed(1)} × ${n.hei.toFixed(1)} cm</b>` +
      `（車長最長 ${n.len.toFixed(1)}、車寬最寬 ${n.wid.toFixed(1)}、車高最高 ${n.hei.toFixed(1)}）`;
    elList.innerHTML = fitInfo.rows.map((r) =>
      `<div class="it ${r.fits ? '' : 'bad'}" data-car="${r.car.id}">` +
      `<span class="n">${esc(carName(r.car))}</span>` +
      `<span class="m">${r.fits ? `開門 ${r.doorClear.toFixed(1)}cm · ${r.doorVerdict}` : r.fails.join('/')}</span></div>`).join('');
  }

  function setCurrent(a) {
    if (!elCur) return;
    const r = a.r;
    elCur.innerHTML =
      `<div class="t">${esc(carName(a.car))}　<span style="font-weight:400;color:#6B7078;font-size:12.5px">` +
      `${r.L.toFixed(1)} × ${r.W.toFixed(1)} × ${r.H.toFixed(1)} cm　行李廂 ${esc(cargoText(a.car))}</span></div>` +
      (r.fits
        ? `<div class="m">開門餘裕 <b>${r.doorClear.toFixed(1)} cm</b>／每側 —— 「${r.doorVerdict}」　` +
          `長度餘裕 ${r.lenClear.toFixed(1)} cm　高度餘裕 ${r.heiClear.toFixed(1)} cm</div>` +
          `<div class="f">開門餘裕 =（車位寬 ${STATE.slot.wid} cm − 車寬 ${r.W.toFixed(1)} cm）÷ 2　｜　${WEIGHT_WARNING}</div>`
        : `<div class="m bad">塞不進去：${esc(r.fails.join('、'))} —— 車頭進去一半就卡住，只能倒車離開。</div>` +
          `<div class="f">車位 ${STATE.slot.len} × ${STATE.slot.wid} × ${STATE.slot.hei} cm　｜　${WEIGHT_WARNING}</div>`);
    elCur.classList.add('on');
  }

  /* ═══════════ 每幀推進 ═══════════ */
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
  function push(a) {
    _p.set(a.x, 0, a.z);
    _e.set(0, a.yaw, 0);
    _q.setFromEuler(_e);
    try { fleet.setTransform(a.idx, _p, _q); } catch (_) {}
  }

  /** 巷子裡的排隊位置：第 0 位對齊車位口，第 1 位就在車位口後方等，之後每 4.6 m 一台 */
  function queueZ(k) { return k === 0 ? 0 : 2.9 + 4.6 * (k - 1); }

  function stepActor(a, dt) {
    const bayX = bayCenterX();
    const halfLen = mm2m(a.car.length) / 2;
    switch (a.phase) {
      case 'in': {
        const k = actors.filter((o) => o.phase === 'in').indexOf(a);
        const target = (queueHead === null && k === 0) ? 0 : queueZ(Math.max(k, queueHead === null ? 0 : k + 1));
        // 指數 ease-out 逼近（不是 linear，也不是預設 ease）
        a.z += (target - a.z) * (1 - Math.exp(-5.2 * dt));
        a.x += (LANE_X - a.x) * (1 - Math.exp(-6 * dt));
        a.yaw += (0 - a.yaw) * (1 - Math.exp(-6 * dt));
        if (queueHead === null && k === 0 && Math.abs(a.z) < 0.12) {
          a.z = 0; queueHead = a; a.t = 0;
          a.fx = a.x; a.fyaw = a.yaw;
          a.r = evaluateFit(a.car, STATE.slot);
          a.phase = a.r.fits ? 'park' : 'failin';
          setCurrent(a);
          drawReadout(a.r);
        }
        break;
      }
      case 'park': {
        a.t += dt;
        const u = EZ_PARK(clamp(a.t / T_PARK, 0, 1));
        a.x = lerp(a.fx, bayX, u);
        a.yaw = lerp(a.fyaw, -Math.PI / 2, u);
        readMat.opacity = 0.92 * u;
        if (a.t >= T_PARK) { a.phase = 'hold'; a.t = 0; results.set(a.id, a.r); refreshPanel(); }
        break;
      }
      case 'hold': {
        a.t += dt;
        if (a.t >= T_HOLD) { a.phase = 'out'; a.t = 0; a.fx = a.x; a.fyaw = a.yaw; }
        break;
      }
      case 'out': {
        a.t += dt;
        const u = EASE_FN.inOutCubic(clamp(a.t / T_OUT, 0, 1));
        a.x = lerp(a.fx, LANE_X, u);
        a.yaw = lerp(a.fyaw, 0, u);
        readMat.opacity = 0.92 * (1 - u);
        // 車已退出車位中心一半以上就把「車位」這個互斥資源釋放，下一台才不用乾等
        if (u > 0.55 && queueHead === a) queueHead = null;
        if (a.t >= T_OUT) { a.phase = 'away'; a.t = 0; if (queueHead === a) queueHead = null; }
        break;
      }
      /* ── 塞不進：車頭進去一半 → 停住 → 輕微左右擺動 → 倒退出去（合計 2.6 秒） ── */
      case 'failin': {
        a.t += dt;
        const u = EZ_NOSE_IN(clamp(a.t / T_FAIL_IN, 0, 1));
        const noseTarget = BAY_X0 + halfLen * 0.5;     // 車頭只進去一半
        a.x = lerp(a.fx, noseTarget, u);
        a.yaw = lerp(a.fyaw, -Math.PI / 2 * 0.62, u);
        readMat.opacity = 0.92 * u;
        scuffMat.opacity = 0.42 * u;                   // 車身擦到牆
        if (a.t >= T_FAIL_IN) { a.phase = 'failstop'; a.t = 0; a.fx = a.x; a.fyaw = a.yaw; }
        break;
      }
      case 'failstop': {
        a.t += dt;                                     // 完全靜止
        if (a.t >= T_FAIL_STOP) { a.phase = 'failwag'; a.t = 0; }
        break;
      }
      case 'failwag': {
        a.t += dt;
        const p = clamp(a.t / T_FAIL_WAG, 0, 1);
        const damp = 1 - EASE_FN.outCubic(p);
        a.yaw = a.fyaw + Math.sin(p * Math.PI * 6) * 0.055 * damp;
        a.z = Math.sin(p * Math.PI * 6) * 0.045 * damp;
        if (a.t >= T_FAIL_WAG) { a.phase = 'failout'; a.t = 0; a.fx = a.x; a.fyaw = a.yaw; a.fz = a.z; }
        break;
      }
      case 'failout': {
        a.t += dt;
        const u = EZ_BACK_OUT(clamp(a.t / T_FAIL_OUT, 0, 1));
        a.x = lerp(a.fx, LANE_X, u);
        a.yaw = lerp(a.fyaw, 0, u);
        a.z = lerp(a.fz || 0, 0, u);
        readMat.opacity = 0.92 * (1 - u);
        scuffMat.opacity = 0.42 * (1 - u);
        if (a.t >= T_FAIL_OUT) {
          a.phase = 'away'; a.t = 0;
          results.set(a.id, a.r); refreshPanel();
          if (queueHead === a) queueHead = null;
        }
        break;
      }
      case 'away': {
        a.z += (EXIT_Z - a.z) * (1 - Math.exp(-2.2 * dt));
        a.x += (LANE_X - a.x) * (1 - Math.exp(-5 * dt));
        if (a.z <= EXIT_Z + 0.6) a.phase = 'done';
        break;
      }
      default: break;
    }
    push(a);
  }

  /* ═══════════ RoomHandle ═══════════ */
  const handle = {
    key: ROOM_KEY,
    group,
    spawn: { pos: [LANE_X - 0.4, 1.60, ENTRY_Z + 3.5], yaw: 0 },   // 站在巷口，朝 -Z 看進巷子

    enter() {
      if (entered) return;
      entered = true;
      buildDom();
      refreshSlotGeometry();
      fitInfo = evaluateAll(cars, STATE.slot);
      refreshPanel();
      offs.push(on(EV.SLOT_CHANGED, (e) => {
        if (e.detail && e.detail.room === ROOM_KEY) return;   // 自己發的不用再處理
        for (const k of ['len', 'wid', 'hei']) {
          const el = root && root.querySelector(`[data-s="${k}"]`);
          if (el) el.value = String(STATE.slot[k]);
          const v = root && root.querySelector(`[data-sv="${k}"]`);
          if (v) v.textContent = `${STATE.slot[k]} cm`;
        }
        refreshSlotGeometry();
        fitInfo = evaluateAll(cars, STATE.slot);
        refreshPanel();
      }));
      try { if (ctx.lighting && rig && rig.envKind && ctx.lighting.setEnvironment) ctx.lighting.setEnvironment(rig.envKind); } catch (_) {}
      emit(EV.ROOM_ENTER, { room: ROOM_KEY });
      startParade(0);
    },

    exit() {
      if (!entered) return;
      entered = false;
      running = false;
      while (offs.length) { try { offs.pop()(); } catch (_) {} }
      for (const a of actors) setVis(a.id, false);
      actors.length = 0; queueHead = null;
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = elCur = elCounts = elList = elNeed = null;
      emit(EV.ROOM_EXIT, { room: ROOM_KEY });
    },

    update(dt, elapsed, camera) {
      if (!entered) return;
      dt = Math.min(dt || 0, 0.05);

      if (running && spawnPtr < ordered.length) {
        spawnTimer += dt;
        while (spawnTimer >= SPAWN_GAP && spawnPtr < ordered.length) {
          spawnTimer -= SPAWN_GAP;
          const a = makeActor(ordered[spawnPtr++]);
          actors.push(a); setVis(a.id, true); push(a);
        }
      }

      for (let i = actors.length - 1; i >= 0; i--) {
        const a = actors[i];
        stepActor(a, dt);
        if (a.phase === 'done') { setVis(a.id, false); actors.splice(i, 1); }
      }
      try { fleet.commit(); } catch (_) {}

      if (running && !finished && spawnPtr >= ordered.length && actors.length === 0) {
        finished = true; running = false;
        if (elCur) {
          elCur.innerHTML =
            `<div class="t">39 台跑完了。</div>` +
            `<div class="m">車位 ${STATE.slot.len} × ${STATE.slot.wid} × ${STATE.slot.hei} cm　→　` +
            `<b>${fitInfo.inCount} 台進得去</b>、<b>${fitInfo.outCount} 台進不去</b>。</div>` +
            `<div class="f">${WEIGHT_WARNING}　｜　${REF_LEGAL}　${REF_MECH}</div>`;
          elCur.classList.add('on');
        }
      }

      try { if (rig && rig.update) rig.update(dt, elapsed); } catch (_) {}
      try { if (ctx.carModels && ctx.carModels.update) ctx.carModels.update(dt, elapsed, camera); } catch (_) {}
    },

    dispose() {
      handle.exit();
      try { if (rig && rig.dispose) rig.dispose(); } catch (_) {}
      for (const d of disposables) { try { d.dispose(); } catch (_) {} }
      disposables.length = 0;
      if (group.parent) group.parent.remove(group);
    },

    __debug: {
      evaluateFit, evaluateAll,
      stats: () => evaluateAll(cars, STATE.slot),
      replay: (id) => replayOne(id),
      start: () => startParade(0),
      fastForward,
    },
  };

  return handle;
}
