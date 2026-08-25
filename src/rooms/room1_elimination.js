/**
 * room1_elimination.js — B5 廳一 · 美術館 · 淘汰（第 2 階段子代理產出）
 *
 * 假設：
 *   1. ctx 依 MODULE_API.md §4 提供；單獨測試時由 src/testkit.js 組出最小 ctx。
 *   2. 1 three.js unit = 1 公尺；Y 軸向上；地面 y = 0；車輛本地 -Z 為車頭方向，
 *      原點在四輪接地面的車身正中心（MODULE_API.md §0）。
 *   3. cars.json 的 length/width/height/wheelbase 單位是 mm，price/tax 單位是新台幣元。
 *   4. ctx.arch.buildGallery(ctx) 回傳的美術館以原點為中心、地面在 y=0、
 *      可用空間至少 40 m(X) × 32 m(Z)。若 ctx.arch.DIMENSIONS.gallery 提供
 *      width/depth（公尺）則以它為準自動縮放車陣間距。
 *   5. B1 若有預埋展籤錨點，會是 arch group 內名稱以 "label" 開頭的 Object3D；
 *      數量 >= 39 時本模組直接沿用其世界座標，否則自行生成展籤柱。
 *   6. 「被支配」與「雙胞胎」一律由 scoring.dominatedSet() / scoring.twins() 即時算出，
 *      **完全沒有硬編任何車號**；權重歸零時（EV.WEIGHTS_CHANGED）整組重算。
 *   7. 「真正不同的選項」數字由程式算出，不硬編（見 countDistinctOptions()）。
 *   8. ctx.carModels / ctx.arch / ctx.lighting 若尚未就緒（單檔開發階段），
 *      本模組會退回內建的極簡替身（灰白色量體盒），只為了讓畫面能跑，不影響介面。
 *
 * 依賴：ctx.arch / ctx.materials / ctx.lighting / ctx.carModels（依賴注入，不 import）
 *       只 import ../contract.js 與 ../scoring.js
 *
 * 未達成的規格：
 *   - 展籤文字用 CanvasTexture 程序繪製；未接字型檔，中文字型依瀏覽器系統字型而異。
 *   - 「熄燈」以展籤轉灰＋車體 highlight 關閉＋沉入地板表現；並未真的關掉 B3 軌道燈的
 *     個別燈頭（LightRig 介面未提供單顆燈頭的 handle，不逾越介面）。
 *   - 雙胞胎圈框為地面細線框（不發光），未做「立體圍欄」。
 *   - 「真正不同的選項」採用規格書給的算式 39 − 被支配 − 雙胞胎組數；另以嚴謹的
 *     等價類（union-find）算法算出第二個數字，兩者都以小字誠實揭露在畫面上。
 */

import { ROOMS, STATE, EV, EASE, EASE_FN, NO_DATA, emit, on } from '../contract.js';
import { DIMS, DIM_LABEL, computeScores, dominatedSet, twins, diffDims } from '../scoring.js';

export const ROOM_KEY = ROOMS.GALLERY;

/* ─────────────────────────── 單位換算（本檔唯一入口） ───────────────────────────
 * cars.json: mm  →  three.js: 公尺。除以 1000。
 * 價格：新台幣元 → 萬元。除以 10000。
 * 這兩個換算全檔只走下面兩個函式，避免散落的魔術數字。
 */
const mm2m  = (mm) => mm / 1000;
const twd2wan = (v) => v / 10000;
const fmtWan = (v) => {
  const w = twd2wan(v);
  return (Math.abs(w - Math.round(w)) < 1e-9) ? String(Math.round(w)) : w.toFixed(1);
};

/* ─────────────────────────── 動效常數 ─────────────────────────── */
const SINK_DEPTH   = 2.05;   // 公尺，沉到看不見
const SINK_DUR     = 1.6;    // 1.2–2.0 秒
const SINK_HOLD    = 0.72;   // 關鍵時刻前的靜止 0.6–0.8 秒
const REVIVE_DUR   = 1.5;
const REVIVE_HOLD  = 0.66;
const HALFRISE_DUR = 0.34;   // 0.3–0.4 秒
const AUTO_TRIGGER_SEC = 30; // 走進去 30 秒後自動觸發
const NEAR_RADIUS  = 5.2;    // 走到旁邊的判定半徑（公尺）

/* ─────────────────────────── 小工具 ─────────────────────────── */
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
/** 行李廂：null 一律顯示 NO_DATA，絕不可寫 0、不可留白、不可估算。 */
function cargoText(c) { return c.cargo == null ? (c.cargoNote || NO_DATA) : `${c.cargo} L`; }
function carName(c) { return `${c.brand} ${c.model} ${c.trim}`; }

/**
 * 「真正不同的選項」— 由程式算出，不硬編。
 * 回傳兩種算法，畫面上兩個都誠實揭露。
 *   spec   = 全部 − 被支配台數 − 雙胞胎組數（規格書給的算式）
 *   strict = 先把配備完全相同者併成同一個等價類（union-find），
 *            再扣掉「整個等價類都被支配」的類別（比較嚴謹、不會重複扣）
 */
export function countDistinctOptions(cars, weights) {
  const dom = dominatedSet(cars, weights);
  const tw = twins(cars);
  const spec = cars.length - dom.length - tw.length;

  const parent = new Map(cars.map((c) => [c.id, c.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const p of tw) union(p.a.id, p.b.id);
  const domIds = new Set(dom.map((d) => d.car.id));
  const classes = new Map();
  for (const c of cars) {
    const r = find(c.id);
    if (!classes.has(r)) classes.set(r, []);
    classes.get(r).push(c);
  }
  let strict = 0;
  for (const members of classes.values()) {
    if (members.some((m) => !domIds.has(m.id))) strict++;
  }
  return { total: cars.length, dominated: dom.length, twinPairs: tw.length, classes: classes.size, spec, strict };
}

/* ─────────────────────────── 替身車隊（B4 未就緒時的最小退路） ─────────────────────────── */
function makeFallbackFleet(THREE, list) {
  const group = new THREE.Group();
  group.name = 'b5.fallbackFleet';
  const meshes = list.map((c) => {
    const g = new THREE.BoxGeometry(mm2m(c.width), mm2m(c.height), mm2m(c.length));
    g.translate(0, mm2m(c.height) / 2, 0);
    const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(c.brandColor || '#C8CBD0'), roughness: 0.58, metalness: 0.04 });
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  });
  return {
    group, __fallback: true,
    setTransform(i, pos, quat) { const m = meshes[i]; if (!m) return; m.position.copy(pos); if (quat) m.quaternion.copy(quat); },
    setHighlight(i, on) { const m = meshes[i]; if (!m) return; m.scale.setScalar(on ? 1.035 : 1); },
    setVisible(i, on) { if (meshes[i]) meshes[i].visible = !!on; },
    indexOf(id) { return list.findIndex((c) => c.id === id); },
    commit() {},
    dispose() { for (const m of meshes) { m.geometry.dispose(); m.material.dispose(); } },
  };
}

/* ─────────────────────────── 展籤（CanvasTexture） ─────────────────────────── */
function drawLabelCanvas(canvas, car, tierLabel, dim, extra) {
  const W = 620, H = 400;
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const ink   = dim ? '#9AA0A9' : '#22252B';
  const ink2  = dim ? '#AEB3BA' : '#5C626B';
  const paper = dim ? '#E5E7EA' : '#F6F7F8';
  g.fillStyle = paper; g.fillRect(0, 0, W, H);
  g.strokeStyle = dim ? '#CDD1D6' : '#D8DBE0'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, W - 3, H - 3);
  // 品牌色細條（熄燈時去飽和）
  g.fillStyle = dim ? '#C4C8CE' : (car.brandColor || '#8B9099');
  g.fillRect(24, 26, 8, 62);
  const F = (px, w) => `${w || 400} ${px}px "Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif`;
  g.fillStyle = ink;  g.font = F(34, 600); g.fillText(`${car.brand} ${car.model}`, 48, 56);
  g.fillStyle = ink2; g.font = F(26, 400); g.fillText(car.trim, 48, 90);
  g.fillStyle = ink;  g.font = F(30, 600); g.fillText(`NT$ ${fmtWan(car.price)} 萬`, 48, 132);

  const rows = [
    ['車身 (mm)', `${car.length} × ${car.width} × ${car.height}`],
    ['軸距 (mm)', `${car.wheelbase}`],
    ['行李廂', cargoText(car)],
    ['動力', `${car.hp} hp${car.torque != null ? ` / ${car.torque} kgm` : ` / 扭力 ${NO_DATA}`}`],
    ['油耗 / 稅金', `${car.kml} km/L　${car.tax.toLocaleString('en-US')} 元/年`],
    ['安全 / 便利', `${car.safetyCount} / 11 項　　${car.comfortCount} / 13 項`],
    ['保固 / 據點', `${car.warranty}　據點${car.dealer}`],
  ];
  let y = 172;
  for (const [k, v] of rows) {
    g.fillStyle = ink2; g.font = F(21, 400); g.fillText(k, 48, y);
    g.fillStyle = ink;  g.font = F(22, 500); g.fillText(v, 210, y);
    y += 29;
  }
  g.strokeStyle = dim ? '#D3D7DC' : '#E1E4E8'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(48, y - 6); g.lineTo(W - 48, y - 6); g.stroke();
  g.fillStyle = ink2; g.font = F(16, 400);
  g.fillText(`模型分級：${tierLabel}`, 48, y + 20);
  if (extra) { g.fillStyle = dim ? '#8C929B' : '#7A0F0F'; g.font = F(18, 600); g.fillText(extra, 48, y + 46); }
}

/* ─────────────────────────── 主體 ─────────────────────────── */
export function createRoom(ctx) {
  const THREE = ctx.THREE;
  const cars = ctx.cars || [];
  if (cars.length && !cars[0].s) computeScores(cars);

  const group = new THREE.Group();
  group.name = ROOM_KEY;

  const disposables = [];   // { dispose() }
  const offs = [];          // 事件解除註冊
  let entered = false;

  /* ── 建築 ── */
  let archGroup = null;
  try {
    if (ctx.arch && typeof ctx.arch.buildGallery === 'function') {
      archGroup = ctx.arch.buildGallery(ctx);
      if (archGroup) group.add(archGroup);
    }
  } catch (e) { console.warn('[room1] buildGallery 失敗，改用空場地：', e); }
  if (!archGroup) {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(56, 40),
      new THREE.MeshStandardMaterial({ color: 0xE8E9EB, roughness: 0.92, metalness: 0 })
    );
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.name = 'b5.fallbackFloor';
    group.add(floor);
    disposables.push({ dispose: () => { floor.geometry.dispose(); floor.material.dispose(); } });
  }

  /* ── 光照 ── */
  let rig = null;
  try {
    if (ctx.lighting && typeof ctx.lighting.makeRig === 'function') {
      rig = ctx.lighting.makeRig(ROOM_KEY);
      if (rig && rig.group) group.add(rig.group);
    }
  } catch (e) { console.warn('[room1] makeRig 失敗：', e); }
  if (!rig) {
    const hemi = new THREE.HemisphereLight(0xFFFFFF, 0xD6D8DC, 0.55);
    const sun = new THREE.DirectionalLight(0xFFFFFF, 2.1);
    sun.position.set(9, 14, 8); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.normalBias = 0.03;
    sun.shadow.camera.left = -30; sun.shadow.camera.right = 30;
    sun.shadow.camera.top = 30; sun.shadow.camera.bottom = -30; sun.shadow.camera.far = 60;
    group.add(hemi, sun);
    rig = { group: null, exposure: 1.1, envKind: 'gallery', update() {}, dispose() { hemi.dispose(); sun.dispose(); } };
  }

  /* ── 版面：依 series 分群，讓雙胞胎自然相鄰 ── */
  const ordered = cars.slice().sort((a, b) =>
    (a.series || '').localeCompare(b.series || '') || a.id.localeCompare(b.id, 'en', { numeric: true }));

  const gd = (ctx.arch && ctx.arch.DIMENSIONS && ctx.arch.DIMENSIONS.gallery) || null;
  const availX = Number(gd && (gd.width ?? gd.w ?? gd.sizeX)) || 42;
  const availZ = Number(gd && (gd.depth ?? gd.d ?? gd.sizeZ)) || 34;
  const COLS = 10;
  const ROWS = Math.ceil(ordered.length / COLS);
  const GAPX = clamp((availX * 0.86) / COLS, 2.9, 3.9);
  const GAPZ = clamp((availZ * 0.80) / ROWS, 6.0, 7.6);

  const slots = ordered.map((car, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    return {
      car,
      idx: -1,
      base: new THREE.Vector3((col - (COLS - 1) / 2) * GAPX, 0, (row - (ROWS - 1) / 2) * GAPZ),
      yaw: Math.PI,               // 車頭 -Z 轉 180° → 面向 +Z（面向入口）
      y: 0, from: 0, to: 0, t: 0, dur: 0, hold: 0, ease: EASE_FN.inOutQuint, running: false,
      eliminated: false, raised: false, by: [], label: null, tex: null, canvas: null, tier: '',
    };
  });
  const slotById = new Map(slots.map((s) => [s.car.id, s]));

  /* ── 車隊 ── */
  let fleet = null;
  try {
    if (ctx.carModels && typeof ctx.carModels.createFleet === 'function') {
      fleet = ctx.carModels.createFleet(ordered.map((c) => c.id));
    }
  } catch (e) { console.warn('[room1] createFleet 失敗，改用替身：', e); }
  if (!fleet) { fleet = makeFallbackFleet(THREE, ordered); disposables.push(fleet); }
  if (fleet.group) group.add(fleet.group);
  slots.forEach((s, i) => {
    let idx = i;
    try { if (typeof fleet.indexOf === 'function') { const k = fleet.indexOf(s.car.id); if (k >= 0) idx = k; } } catch (_) {}
    s.idx = idx;
  });

  /* ── 展籤 ── */
  const labelRoot = new THREE.Group(); labelRoot.name = 'b5.labels'; group.add(labelRoot);
  // B1 若預埋了展籤錨點就沿用
  let anchors = [];
  if (archGroup) {
    archGroup.updateWorldMatrix(true, true);
    archGroup.traverse((o) => { if (o.name && /^label/i.test(o.name)) anchors.push(o); });
    if (anchors.length < slots.length) anchors = [];
  }
  const LBL_W = 0.66, LBL_H = 0.426;
  const postGeo = new THREE.CylinderGeometry(0.028, 0.034, 0.9, 12);
  disposables.push({ dispose: () => postGeo.dispose() });
  let plinthMat = null;
  try { plinthMat = ctx.materials && ctx.materials.get ? ctx.materials.get('plinth') : null; } catch (_) { plinthMat = null; }
  if (!plinthMat) {
    plinthMat = new THREE.MeshStandardMaterial({ color: 0xC9CCD1, roughness: 0.6, metalness: 0.08 });
    disposables.push({ dispose: () => plinthMat.dispose() });
  }

  slots.forEach((s, i) => {
    const holder = new THREE.Group();
    if (anchors.length) {
      anchors[i].getWorldPosition(holder.position);
      holder.quaternion.copy(anchors[i].getWorldQuaternion(new THREE.Quaternion()));
    } else {
      holder.position.set(s.base.x + 0.05, 0, s.base.z + Math.min(2.7, GAPZ / 2 - 0.5));
    }
    const post = new THREE.Mesh(postGeo, plinthMat);
    post.position.y = 0.45; post.castShadow = true; holder.add(post);

    const canvas = document.createElement('canvas');
    const tier = (() => {
      try { return ctx.carModels && ctx.carModels.getTier ? (ctx.carModels.getTier(s.car.id).label || '') : ''; }
      catch (_) { return ''; }
    })() || '依原廠公布尺寸程序生成之示意模型，非原廠 CAD 資料';
    drawLabelCanvas(canvas, s.car, tier, false, null);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;         // Albedo 必須設 SRGB（MODULE_API §1.2）
    tex.anisotropy = 4; tex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.78, metalness: 0 });
    const card = new THREE.Mesh(new THREE.PlaneGeometry(LBL_W, LBL_H), mat);
    card.position.set(0, 0.92, 0.02);
    card.rotation.x = -0.28;
    card.castShadow = false; card.receiveShadow = true;
    holder.add(card);
    labelRoot.add(holder);

    s.label = holder; s.tex = tex; s.canvas = canvas; s.tier = tier;
    disposables.push({ dispose: () => { tex.dispose(); mat.dispose(); card.geometry.dispose(); } });
  });

  function redrawLabel(s, dim, extra) {
    drawLabelCanvas(s.canvas, s.car, s.tier, dim, extra);
    s.tex.needsUpdate = true;
  }

  /* ── 雙胞胎圈框（淺色、細、不發光） ── */
  const twinRoot = new THREE.Group(); twinRoot.name = 'b5.twins'; group.add(twinRoot);
  const twinLineMat = new THREE.LineBasicMaterial({ color: 0xB4B9C1, transparent: true, opacity: 0.95 });
  disposables.push({ dispose: () => twinLineMat.dispose() });
  const twinPairs = twins(cars);

  function roundedRectPoints(cx, cz, halfX, halfZ, r, y) {
    const pts = [], seg = 6;
    const corners = [[+1, +1], [-1, +1], [-1, -1], [+1, -1]];
    for (let ci = 0; ci < 4; ci++) {
      const [sx, sz] = corners[ci];
      const ax = cx + sx * (halfX - r), az = cz + sz * (halfZ - r);
      const a0 = Math.atan2(sz, sx) - Math.PI / 4;
      for (let k = 0; k <= seg; k++) {
        const a = a0 + (k / seg) * (Math.PI / 2);
        pts.push(new THREE.Vector3(ax + Math.cos(a) * r, y, az + Math.sin(a) * r));
      }
    }
    pts.push(pts[0].clone());
    return pts;
  }

  twinPairs.forEach((p, pi) => {
    const sa = slotById.get(p.a.id), sb = slotById.get(p.b.id);
    if (!sa || !sb) return;
    const minX = Math.min(sa.base.x - mm2m(p.a.width) / 2, sb.base.x - mm2m(p.b.width) / 2) - 0.42;
    const maxX = Math.max(sa.base.x + mm2m(p.a.width) / 2, sb.base.x + mm2m(p.b.width) / 2) + 0.42;
    const minZ = Math.min(sa.base.z - mm2m(p.a.length) / 2, sb.base.z - mm2m(p.b.length) / 2) - 0.42;
    const maxZ = Math.max(sa.base.z + mm2m(p.a.length) / 2, sb.base.z + mm2m(p.b.length) / 2) + 0.42;
    const y = 0.014 + pi * 0.004;   // 多組重疊時錯開，避免 z-fighting
    const pts = roundedRectPoints((minX + maxX) / 2, (minZ + maxZ) / 2, (maxX - minX) / 2, (maxZ - minZ) / 2, 0.38, y);
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, twinLineMat);
    line.name = `twin.${p.a.id}-${p.b.id}`;
    twinRoot.add(line);
    disposables.push({ dispose: () => geo.dispose() });

    // 地面小牌：配備完全相同 · 差 N 萬
    const cvs = document.createElement('canvas');
    cvs.width = 560; cvs.height = 92;
    const g2 = cvs.getContext('2d');
    g2.fillStyle = '#F2F3F5'; g2.fillRect(0, 0, 560, 92);
    g2.strokeStyle = '#C9CDD3'; g2.lineWidth = 2; g2.strokeRect(1, 1, 558, 90);
    g2.fillStyle = '#3A3E45';
    g2.font = '30px "Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif';
    g2.fillText(`配備完全相同　差 ${fmtWan(p.priceGap)} 萬`, 22, 58);
    const t2 = new THREE.CanvasTexture(cvs); t2.colorSpace = THREE.SRGBColorSpace;
    const m2 = new THREE.MeshBasicMaterial({ map: t2, transparent: true, opacity: 0.9, depthWrite: false });
    const plaque = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.246), m2);
    plaque.rotation.x = -Math.PI / 2;
    plaque.position.set((minX + maxX) / 2, y + 0.002, maxZ - 0.24);
    twinRoot.add(plaque);
    disposables.push({ dispose: () => { t2.dispose(); m2.dispose(); plaque.geometry.dispose(); } });
  });

  /* ─────────────────── 支配關係 ─────────────────── */
  let current = new Map();   // carId -> [支配它的車]
  function recomputeDominance() {
    const dom = dominatedSet(cars, STATE.weights);
    const next = new Map(dom.map((d) => [d.car.id, d.by]));
    return next;
  }

  function startAnim(s, to, dur, hold, ease) {
    s.from = s.y; s.to = to; s.t = 0; s.dur = dur; s.hold = hold || 0;
    s.ease = ease || EASE_FN.inOutQuint; s.running = true;
  }

  function applyDominance(next, { animate = true } = {}) {
    const added = [], removed = [];
    for (const [id, by] of next) if (!current.has(id)) added.push(id);
    for (const id of current.keys()) if (!next.has(id)) removed.push(id);
    current = next;

    for (const s of slots) {
      const by = current.get(s.car.id);
      if (by) {
        s.by = by; s.eliminated = true;
      } else if (s.eliminated) {
        s.eliminated = false; s.by = []; s.raised = false;
      }
    }
    for (const id of added) {
      const s = slotById.get(id); if (!s) continue;
      redrawLabel(s, true, `已被 ${s.by.map((b) => b.trim).join(' / ')} 完全支配`);
      try { fleet.setHighlight(s.idx, false); } catch (_) {}
      if (animate) startAnim(s, -SINK_DEPTH, SINK_DUR, SINK_HOLD, EASE_FN.inOutQuint);
      else { s.y = -SINK_DEPTH; s.running = false; }
      emit(EV.CAR_ELIMINATED, { room: ROOM_KEY, carId: id, by: s.by.map((b) => b.id) });
    }
    for (const id of removed) {
      const s = slotById.get(id); if (!s) continue;
      redrawLabel(s, false, '權重改變後不再被支配 — 浮回展場');
      if (animate) startAnim(s, 0, REVIVE_DUR, REVIVE_HOLD, EASE_FN.inOutQuint);
      else { s.y = 0; s.running = false; }
      emit(EV.CAR_REVIVED, { room: ROOM_KEY, carId: id });
    }

    STATE.alive = cars.filter((c) => !current.has(c.id)).map((c) => c.id);
    emit(EV.STATE_CHANGED, { keys: ['alive'], room: ROOM_KEY });
    refreshHud();
    return { added, removed };
  }

  /* ─────────────────── 「輸在哪」的具體數字 ─────────────────── */
  function explainDim(dim, a, b) {   // a = 輸的那台，b = 贏的那台
    const n = (v) => Number(v).toLocaleString('en-US');
    switch (dim) {
      case 'price': {
        const d = a.price - b.price;
        return d > 0
          ? `價格：便宜 ${fmtWan(d)} 萬（${fmtWan(b.price)} 萬 vs ${fmtWan(a.price)} 萬）`
          : `價格：貴 ${fmtWan(-d)} 萬（${fmtWan(b.price)} 萬 vs ${fmtWan(a.price)} 萬）`;
      }
      case 'safety':   return `主動安全：${b.safetyCount} 項 vs ${a.safetyCount} 項（共 11 項）`;
      case 'equip':    return `內裝配備：${b.comfortCount} 項 vs ${a.comfortCount} 項（共 13 項）`;
      case 'fuel':     return `油耗：${b.kml} vs ${a.kml} km/L`;
      case 'power':    return `動力：${b.hp} hp / ${b.torque != null ? b.torque + ' kgm' : '扭力 ' + NO_DATA}　vs　${a.hp} hp / ${a.torque != null ? a.torque + ' kgm' : '扭力 ' + NO_DATA}`;
      case 'space':    return `空間：軸距 ${n(b.wheelbase)} vs ${n(a.wheelbase)} mm；行李廂 ${cargoText(b)} vs ${cargoText(a)}`;
      case 'park':     return `好停：車長 ${n(b.length)} vs ${n(a.length)} mm、車寬 ${n(b.width)} vs ${n(a.width)} mm`;
      case 'tax':      return `稅金：${n(b.tax)} vs ${n(a.tax)} 元/年`;
      case 'warranty': return `保固：${b.warranty} vs ${a.warranty}`;
      case 'dealer':   return `服務據點：${b.dealer} vs ${a.dealer}`;
      default:         return `${DIM_LABEL[dim] || dim}：有差距`;
    }
  }
  function loseReasons(a, b) {
    const out = [];
    const dd = diffDims(a, b).slice(0, 3);
    for (const d of dd) out.push(explainDim(d.dim, a, b));
    if (a.safetyCode === b.safetyCode && a.comfortCode === b.comfortCode) {
      out.push(`配備：完全相同（安全 ${a.safetyCount} 項、便利 ${a.comfortCount} 項，逐項一字不差）`);
    }
    if (!out.length) out.push('十個維度全部打平，只差在被支配的臨界。');
    return out;
  }

  /* ─────────────────── DOM ─────────────────── */
  let root = null, elCount = null, elHead = null, elFine = null, elTimer = null, elBtn = null,
      elDetail = null, elWeights = null;
  let hudInfo = null;

  function buildDom() {
    root = document.createElement('div');
    root.className = 'b5r1';
    root.innerHTML = `
<style>
.b5r1{position:absolute;inset:0;pointer-events:none;color:#22252B;
  font:400 14px/1.55 "Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;}
.b5r1 .card{pointer-events:auto;background:rgba(250,250,251,.94);border:1px solid #DCDFE4;
  border-radius:10px;box-shadow:0 6px 22px rgba(28,32,38,.09);backdrop-filter:blur(6px);}
.b5r1 .hud{position:absolute;left:22px;top:22px;width:326px;padding:16px 18px;}
.b5r1 h2{margin:0 0 6px;font-size:16px;font-weight:600;letter-spacing:.02em;}
.b5r1 .sub{color:#6B7078;font-size:12.5px;margin-bottom:12px;}
.b5r1 .headline{font-size:19px;font-weight:600;line-height:1.5;margin:10px 0 4px;
  opacity:0;transform:translateY(8px);transition:opacity 1400ms ${EASE.region},transform 1400ms ${EASE.region};}
.b5r1 .headline.on{opacity:1;transform:translateY(0);}
.b5r1 .fine{font-size:11.5px;color:#7E838B;line-height:1.6;margin-top:8px;}
.b5r1 .btn{pointer-events:auto;display:inline-block;padding:7px 14px;border:1px solid #C7CBD1;border-radius:7px;
  background:#FFF;color:#22252B;font-size:13px;cursor:pointer;
  transition:transform 170ms ${EASE.micro},box-shadow 170ms ${EASE.micro},background 170ms ${EASE.micro};}
.b5r1 .btn:hover{transform:scale(1.045);box-shadow:0 4px 12px rgba(28,32,38,.14);background:#F3F4F6;}
.b5r1 .btn:active{transform:scale(.985);}
.b5r1 .timer{font-variant-numeric:tabular-nums;font-size:13px;color:#4A4F57;margin-left:10px;}
.b5r1 .detail{position:absolute;right:22px;bottom:22px;width:392px;padding:16px 18px;
  opacity:0;transform:translateY(14px) scale(.985);pointer-events:none;
  transition:opacity 340ms ${EASE.component},transform 340ms ${EASE.component};}
.b5r1 .detail.on{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;}
.b5r1 .detail .t{font-size:15px;font-weight:600;margin-bottom:2px;}
.b5r1 .detail .lost{font-size:12.5px;color:#8A3A34;margin:6px 0 9px;}
.b5r1 .detail ul{margin:0;padding-left:17px;}
.b5r1 .detail li{font-size:12.8px;margin:4px 0;color:#3A3E45;}
.b5r1 .wp{position:absolute;left:22px;bottom:22px;width:326px;padding:14px 16px;max-height:46vh;overflow:auto;}
.b5r1 .wp .row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:5px 0;}
.b5r1 .wp .row span{font-size:12.5px;color:#3A3E45;}
.b5r1 .wp input[type=range]{width:132px;}
.b5r1 .wp .val{width:30px;text-align:right;font-variant-numeric:tabular-nums;font-size:12px;color:#6B7078;}
.b5r1 .tag{display:inline-block;font-size:11px;color:#6B7078;border:1px solid #DCDFE4;border-radius:4px;padding:1px 6px;margin-right:5px;}
</style>
<div class="card hud">
  <h2>廳一 · 美術館</h2>
  <div class="sub">39 台車陳列於此。被完全支配的，會自己走下舞台。</div>
  <div><span class="btn" data-act="trigger">立即觸發淘汰</span><span class="timer" data-el="timer"></span></div>
  <div class="headline" data-el="head"></div>
  <div data-el="count"></div>
  <div class="fine" data-el="fine"></div>
</div>
<div class="card detail" data-el="detail"></div>
<div class="card wp" data-el="weights">
  <h2 style="margin-bottom:8px">十維權重（拖到 0 就把該維度排除）</h2>
  <div class="sub" style="margin-bottom:8px">權重歸零時支配關係會即時重算，部分車會浮回來。</div>
  <div data-el="wrows"></div>
  <div style="margin-top:8px"><span class="btn" data-act="wreset">全部還原為 1</span></div>
</div>`;
    elHead = root.querySelector('[data-el=head]');
    elCount = root.querySelector('[data-el=count]');
    elFine = root.querySelector('[data-el=fine]');
    elTimer = root.querySelector('[data-el=timer]');
    elDetail = root.querySelector('[data-el=detail]');
    elWeights = root.querySelector('[data-el=weights]');
    elBtn = root.querySelector('[data-act=trigger]');

    const wrows = root.querySelector('[data-el=wrows]');
    for (const d of DIMS) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span>${DIM_LABEL[d]}</span>
        <input type="range" min="0" max="10" step="0.1" value="${STATE.weights[d]}" data-w="${d}">
        <span class="val" data-v="${d}">${Number(STATE.weights[d]).toFixed(1)}</span>`;
      wrows.appendChild(row);
    }
    // 滑桿一律 oninput（拖動過程即時生效）
    wrows.addEventListener('input', (e) => {
      const k = e.target && e.target.dataset && e.target.dataset.w;
      if (!k) return;
      STATE.weights[k] = parseFloat(e.target.value);
      const v = root.querySelector(`[data-v="${k}"]`);
      if (v) v.textContent = Number(STATE.weights[k]).toFixed(1);
      emit(EV.WEIGHTS_CHANGED, { room: ROOM_KEY, dim: k, value: STATE.weights[k] });
      emit(EV.STATE_CHANGED, { keys: ['weights'], room: ROOM_KEY });
    });
    root.addEventListener('click', (e) => {
      const act = e.target && e.target.dataset && e.target.dataset.act;
      if (act === 'trigger') triggerElimination(true);
      else if (act === 'wreset') {
        for (const d of DIMS) {
          STATE.weights[d] = 1;
          const s = root.querySelector(`[data-w="${d}"]`); if (s) s.value = '1';
          const v = root.querySelector(`[data-v="${d}"]`); if (v) v.textContent = '1.0';
        }
        emit(EV.WEIGHTS_CHANGED, { room: ROOM_KEY, dim: '*', value: 1 });
        emit(EV.STATE_CHANGED, { keys: ['weights'], room: ROOM_KEY });
      }
    });
    (ctx.ui || document.body).appendChild(root);
  }

  function refreshHud() {
    if (!root) return;
    const info = countDistinctOptions(cars, STATE.weights);
    hudInfo = info;
    elCount.innerHTML = `<div style="margin-top:6px">
      <span class="tag">被支配 ${info.dominated} 台</span>
      <span class="tag">雙胞胎 ${info.twinPairs} 組</span></div>`;
    elFine.innerHTML =
      `計算方式（即時由 data/cars.json 算出，未硬編任何車號）：<br>` +
      `${info.total} 台 − 被完全支配 ${info.dominated} 台 − 配備完全相同的雙胞胎 ${info.twinPairs} 組 = <b>${info.spec}</b>。<br>` +
      `另以等價類嚴謹計算（先把配備完全相同者併成一類，共 ${info.classes} 類，再扣掉整類都被支配者）＝ <b>${info.strict}</b>。<br>` +
      `兩個數字都誠實列出：前者是規格書給的算式，會把同時「被支配」又「是雙胞胎」的車重複扣一次。`;
    if (triggered) {
      elHead.textContent = `${info.total} 台 → ${info.spec} 個真正不同的選項。這是這座美術館給你的第一份禮物。`;
      elHead.classList.add('on');
    }
  }

  /* ─────────────────── 觸發 ─────────────────── */
  let clock = 0, triggered = false;
  function triggerElimination(manual) {
    if (triggered) return;
    triggered = true;
    if (elBtn) elBtn.style.display = 'none';
    if (elTimer) elTimer.textContent = manual ? '已手動觸發' : '30 秒到了';
    applyDominance(recomputeDominance(), { animate: true });
  }

  /* ─────────────────── 近距離說明 ─────────────────── */
  let nearId = null;
  function showDetail(s) {
    if (!elDetail) return;
    const winners = s.by;
    const w0 = winners[0];
    const items = loseReasons(s.car, w0).map((x) => `<li>${esc(x)}</li>`).join('');
    elDetail.innerHTML =
      `<div class="t">${esc(carName(s.car))}</div>` +
      `<div class="lost">輸給 ${esc(winners.map((w) => `${w.model} ${w.trim}`).join(' 、 '))}` +
      `${winners.length > 1 ? `（同時被 ${winners.length} 台完全支配）` : ''}</div>` +
      `<div style="font-size:12.5px;color:#6B7078;margin-bottom:4px">輸在哪（十維中差距最大的幾項）</div>` +
      `<ul>${items}</ul>` +
      `<div style="font-size:11.5px;color:#7E838B;margin-top:9px">` +
      `參與比較的維度：${esc(DIMS.filter((d) => STATE.weights[d] > 0).map((d) => DIM_LABEL[d]).join('、') || '（全部權重為 0，退回十維）')}` +
      `</div>`;
    elDetail.classList.add('on');
  }
  function hideDetail() { if (elDetail) elDetail.classList.remove('on'); }

  /* ─────────────────── RoomHandle ─────────────────── */
  const _tmpPos = new THREE.Vector3();
  const _tmpQuat = new THREE.Quaternion();
  const _euler = new THREE.Euler();

  function pushTransforms() {
    for (const s of slots) {
      _tmpPos.set(s.base.x, s.y, s.base.z);
      _euler.set(0, s.yaw, 0);
      _tmpQuat.setFromEuler(_euler);
      try { fleet.setTransform(s.idx, _tmpPos, _tmpQuat); } catch (_) {}
    }
    try { fleet.commit(); } catch (_) {}
  }

  const handle = {
    key: ROOM_KEY,
    group,
    spawn: { pos: [0, 1.60, (ROWS - 1) / 2 * GAPZ + 11], yaw: 0 },   // 站在入口，朝 -Z 看進展場

    enter() {
      if (entered) return;
      entered = true;
      clock = 0; triggered = false;
      buildDom();
      // 初始：先不淘汰，讓 39 台都在場上
      current = new Map();
      for (const s of slots) { s.y = 0; s.running = false; s.eliminated = false; s.raised = false; s.by = []; }
      STATE.alive = cars.map((c) => c.id);
      refreshHud();
      pushTransforms();
      offs.push(on(EV.WEIGHTS_CHANGED, () => {
        if (!triggered) { refreshHud(); return; }
        applyDominance(recomputeDominance(), { animate: true });
      }));
      try { if (ctx.lighting && rig && rig.envKind && ctx.lighting.setEnvironment) ctx.lighting.setEnvironment(rig.envKind); } catch (_) {}
      emit(EV.ROOM_ENTER, { room: ROOM_KEY });
    },

    exit() {
      if (!entered) return;
      entered = false;
      while (offs.length) { try { offs.pop()(); } catch (_) {} }
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = elCount = elHead = elFine = elTimer = elBtn = elDetail = elWeights = null;
      emit(EV.ROOM_EXIT, { room: ROOM_KEY });
    },

    update(dt, elapsed, camera) {
      if (!entered) return;
      dt = Math.min(dt || 0, 0.05);
      clock += dt;

      if (!triggered) {
        const left = Math.max(0, AUTO_TRIGGER_SEC - clock);
        if (elTimer) elTimer.textContent = `　${left.toFixed(1)} 秒後自動觸發`;
        if (left <= 0) triggerElimination(false);
      }

      // 動畫推進
      let dirty = false;
      for (const s of slots) {
        if (!s.running) continue;
        dirty = true;
        if (s.hold > 0) { s.hold -= dt; continue; }
        s.t += dt;
        const u = clamp(s.t / s.dur, 0, 1);
        s.y = lerp(s.from, s.to, s.ease(u));
        if (u >= 1) { s.running = false; s.y = s.to; }
      }

      // 近距離：沉下去的車浮起一半
      if (camera && triggered) {
        let best = null, bestD = Infinity;
        for (const s of slots) {
          if (!s.eliminated) continue;
          const dx = camera.position.x - s.base.x, dz = camera.position.z - s.base.z;
          const d = Math.hypot(dx, dz);
          if (d < NEAR_RADIUS && d < bestD) { best = s; bestD = d; }
        }
        const bid = best ? best.car.id : null;
        if (bid !== nearId) {
          if (nearId) {
            const prev = slotById.get(nearId);
            if (prev && prev.eliminated) { prev.raised = false; startAnim(prev, -SINK_DEPTH, HALFRISE_DUR, 0, EASE_FN.inOutCubic); }
            try { if (prev) fleet.setHighlight(prev.idx, false); } catch (_) {}
          }
          nearId = bid;
          if (best) {
            best.raised = true;
            startAnim(best, -SINK_DEPTH * 0.5, HALFRISE_DUR, 0, EASE_FN.outCubic);
            try { fleet.setHighlight(best.idx, true); } catch (_) {}
            showDetail(best);
          } else hideDetail();
          dirty = true;
        }
      }

      if (dirty) pushTransforms();
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

    /* ── 測試/主代理可用的檢查點（非 RoomHandle 必要介面） ── */
    __debug: {
      slots, twinPairs,
      stats: () => countDistinctOptions(cars, STATE.weights),
      dominated: () => dominatedSet(cars, STATE.weights).map((d) => ({ id: d.car.id, by: d.by.map((b) => b.id) })),
      trigger: () => triggerElimination(true),
    },
  };

  return handle;
}
