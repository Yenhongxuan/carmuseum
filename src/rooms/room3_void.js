/**
 * room3_void.js — B6 廳三·空無（第 2 階段子代理產出）
 *
 * 主題：你買了車，但它 85.8% 的時間停在那裡。
 *
 * 假設（全部為使用者假設值／推估，非原廠資料；畫面上以小字同步標明）：
 *   - 年用車天數           預設 52 天／年（= 五年 260 天），滑桿可調 20–200
 *   - 每個用車日行駛里程   181 公里／用車日（單日往返推估）
 *   - 油價                 30.0 元／公升（95 無鉛推估）
 *   - 五年油錢             = 用車天數(5年) × 181 km ÷ 原廠平均油耗(kml) × 30 元
 *   - 五年稅金             = cars.json 的 tax（牌照稅+燃料稅合計）× 5，未計調漲
 *   - 停車費               3,000 元／月 → 五年 180,000 元（都會區月租車位推估）
 *   - 五年殘值率           38.4%（殘值曲線 1年78% / 2年67% / 3年57% / 4年47% / 5年38.4%）
 *                          ★ 38.4% 是「反推校準值」：使其在預設 52 天／年時，
 *                            Yaris Cross 享樂版每用車日成本恰為 2,878 元（文案給定值）。
 *   - 五年總持有成本       = 車價 + 五年油錢 + 五年稅金 + 五年停車費 − 五年殘值
 *   - 每用車日成本         = 五年總持有成本 ÷ (年用車天數 × 5)
 *   - 未計入：保養、保險、輪胎、罰單、貸款利息、通膨、油價變動。
 *
 * 驗算結果（node 對 data/cars.json 實算，見檔尾 __selfCheck）：
 *   - Yaris Cross 享樂版 五年油錢 80,674 元（展板文案 80,672 元，差 2 元＝四捨五入）
 *   - Yaris Cross 享樂版 五年稅金 59,600 元（＝ 11,920 × 5，與文案完全相符）
 *   - 「180,000 > 五年油錢 + 五年稅金」的車：32 / 39 台 ✔ 與文案相符
 *   - Yaris Cross 享樂版 每用車日成本 2,878 元 ✔ 與文案相符，且為 39 台中最低
 *
 * 依賴（一律依賴注入，不 import）：
 *   ctx.THREE / ctx.arch.buildLot / ctx.materials / ctx.lighting.makeRig / ctx.carModels.createFleet
 *   只 import ../contract.js。
 *
 * 未達成的規格（誠實列出）：
 *   - 灰丘採「預算堆疊位置」的近似堆積，不是真實剛體物理；落下路徑為拋物線補間。
 *   - 1,825 格用兩組 InstancedMesh（daycell / daycell.dim）區分亮暗，未用 setColorAt。
 *   - 文字一律用 DOM overlay 呈現（含以 3D 座標投影定位的柱子標籤），場景內無 3D 文字幾何。
 *   - 展板上的「油錢 80,672」沿用文案給定值；本模組實算為 80,674，差額已於小字揭露。
 */

import { ROOMS, STATE, EV, emit, EASE, EASE_FN, ESTIMATE_NOTE } from '../contract.js';

export const ROOM_KEY = ROOMS.VOID;

/* ───────────────────────── 常數與假設 ───────────────────────── */

const DAYS_TOTAL = 1825;          // 五年 = 1,825 天
const COLS       = 43;            // 43 × 43 = 1,849 ≥ 1,825
const CELL       = 0.20;          // 每格 20 × 20 cm
const GAP        = 0.07;
const PITCH      = CELL + GAP;    // 0.27 m → 43 × 0.27 = 11.61 m（約 12 × 12 m）
const CELL_H     = 0.024;

const ASSUME = {
  FUEL_PRICE:      30.0,     // 元 / 公升
  KM_PER_USE_DAY:  181,      // 公里 / 用車日
  PARK_PER_MONTH:  3000,     // 元 / 月
  YEARS:           5,
  RESIDUAL_CURVE:  [0.78, 0.67, 0.57, 0.47, 0.384],  // 第 1–5 年殘值率
  NEW_CAR_FEE:     30000,    // （廳四用；此處僅列出以便對照）
};
const PARK_5Y = ASSUME.PARK_PER_MONTH * 12 * ASSUME.YEARS;   // 180,000

// 展板上的三根柱子（文案給定值，一字不可改）
const PILLAR_SPEC = [
  { key: 'fuel', label: '油錢',   value: 80672  },
  { key: 'tax',  label: '稅金',   value: 59600  },
  { key: 'park', label: '停車費', value: 180000 },
];
const PILLAR_MAX_H = 6.0;   // 停車費那根的高度（公尺），其餘按比例

// 灰丘幾何參數
const PILE = { spacing: 0.225, tileH: 0.046, Hmax: 1.80, center: [-7.6, 0, 0] };

/* ───────────────────────── 成本模型 ───────────────────────── */

const useDays5 = (perYear) => Math.round(perYear * ASSUME.YEARS);

function fuel5Cost(car, perYear) {
  const km = useDays5(perYear) * ASSUME.KM_PER_USE_DAY;
  return km / car.kml * ASSUME.FUEL_PRICE;
}
const tax5Cost = (car) => car.tax * ASSUME.YEARS;
const residual5 = (car) => car.price * ASSUME.RESIDUAL_CURVE[ASSUME.YEARS - 1];

function own5Cost(car, perYear) {
  return car.price + fuel5Cost(car, perYear) + tax5Cost(car) + PARK_5Y - residual5(car);
}
function perUseDayCost(car, perYear) {
  const d = useDays5(perYear);
  return d > 0 ? own5Cost(car, perYear) / d : Infinity;
}
/** 停車費 > 油錢 + 稅金 的台數（★ 文案宣稱 32 台，此處實算） */
function countParkBeatsRest(cars, perYear) {
  return cars.filter((c) => PARK_5Y > fuel5Cost(c, perYear) + tax5Cost(c)).length;
}

const nf = (n) => Math.round(n).toLocaleString('en-US');

/* ───────────────────────── 小工具 ───────────────────────── */

function pickMaterial(ctx, ...names) {
  const lib = ctx.materials;
  if (lib) {
    for (const n of names) {
      try {
        if (typeof lib.has === 'function' ? lib.has(n) : true) return lib.get(n);
      } catch (_) { /* 落到下一個候選 */ }
    }
  }
  // 材質庫尚未就緒時的最小備援（僅供單獨測試，正式流程一定走 ctx.materials）
  return new ctx.THREE.MeshStandardMaterial({ color: 0xd8d9dc, roughness: 0.85, metalness: 0.0 });
}

function el(tag, cls, html) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html != null) d.innerHTML = html;
  return d;
}

/** 產生灰丘的堆疊槽位：以 45° 圓錐包絡，依 (y + r) 排序，取前 K 個即為高度正確的小丘 */
function buildPileSlots() {
  const { spacing: s, tileH, Hmax } = PILE;
  const R = Hmax;                       // 45° 坡角
  const n = Math.ceil(R / s) + 1;
  const slots = [];
  for (let iz = -n; iz <= n; iz++) {
    for (let ix = -n; ix <= n; ix++) {
      const x = ix * s + (Math.abs(iz % 2) ? s * 0.5 : 0);
      const z = iz * s;
      const r = Math.hypot(x, z);
      if (r > R) continue;
      for (let k = 0; ; k++) {
        const y = tileH * (k + 0.5);
        if (y + r > Hmax) break;
        slots.push({ x, y, z, key: y + r });
      }
    }
  }
  slots.sort((a, b) => a.key - b.key);
  return slots;
}

/** 以「均勻散佈」決定哪幾天是用車日：day d 用車 ⇔ floor(d*U/1825) 跳號 */
function makeUsedMask(usedTotal) {
  const mask = new Uint8Array(DAYS_TOTAL);
  if (usedTotal <= 0) return mask;
  let prev = -1;
  for (let d = 0; d < DAYS_TOTAL; d++) {
    const k = Math.floor((d * usedTotal) / DAYS_TOTAL);
    if (k !== prev) { mask[d] = 1; prev = k; }
  }
  return mask;
}

/* ───────────────────────── 主體 ───────────────────────── */

export function createRoom(ctx) {
  const T = ctx.THREE;
  const cars = (ctx.cars && ctx.cars.length) ? ctx.cars : [];
  const uiRoot = ctx.ui || document.body;

  const group = new T.Group();
  group.name = ROOM_KEY;

  /* —— 建築與燈光（依賴注入） —— */
  let rig = null;
  if (ctx.arch && typeof ctx.arch.buildLot === 'function') {
    group.add(ctx.arch.buildLot(ctx));
  }
  if (ctx.lighting && typeof ctx.lighting.makeRig === 'function') {
    rig = ctx.lighting.makeRig(ROOM_KEY);
    if (rig && rig.group) group.add(rig.group);
  }

  /* —— 1,825 格：兩組 InstancedMesh —— */
  const cellGeo = new T.BoxGeometry(CELL, CELL_H, CELL);
  const matBright = pickMaterial(ctx, 'daycell');
  const matDim    = pickMaterial(ctx, 'daycell.dim', 'daycell');

  const imBright = new T.InstancedMesh(cellGeo, matBright, DAYS_TOTAL);
  const imDim    = new T.InstancedMesh(cellGeo, matDim,    DAYS_TOTAL);
  for (const im of [imBright, imDim]) {
    im.castShadow = true;               // ★ 灰丘自陰影
    im.receiveShadow = true;
    im.frustumCulled = false;
    im.instanceMatrix.setUsage(T.DynamicDrawUsage);
    group.add(im);
  }

  const HALF = (COLS - 1) * PITCH * 0.5;                 // 5.805 m
  const gridPos = new Float32Array(DAYS_TOTAL * 3);
  for (let d = 0; d < DAYS_TOTAL; d++) {
    const r = Math.floor(d / COLS), c = d % COLS;
    gridPos[d * 3 + 0] = c * PITCH - HALF;
    gridPos[d * 3 + 1] = CELL_H * 0.5 + 0.004;
    gridPos[d * 3 + 2] = r * PITCH - HALF;
  }

  const pileSlots = buildPileSlots();

  // 每格的動畫狀態
  const cellState = [];
  for (let d = 0; d < DAYS_TOTAL; d++) {
    cellState.push({
      used: false, visUsed: false,
      x: gridPos[d * 3], y: -0.42, z: gridPos[d * 3 + 2],
      fx: gridPos[d * 3], fy: -0.42, fz: gridPos[d * 3 + 2],
      tx: gridPos[d * 3], ty: gridPos[d * 3 + 1], tz: gridPos[d * 3 + 2],
      rx: 0, ry: 0, rz: 0,
      frx: 0, fry: 0, frz: 0,
      trx: 0, try_: 0, trz: 0,
      scale: 1, fscale: 1, tscale: 1,
      arc: 0, t0: 0, dur: 0.001, t: 1, active: false,
    });
  }

  const dummy = new T.Object3D();
  const ZERO = new T.Vector3(1e-4, 1e-4, 1e-4);

  function writeInstances() {
    for (let d = 0; d < DAYS_TOTAL; d++) {
      const s = cellState[d];
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(s.rx, s.ry, s.rz);
      const on  = s.scale;
      const off = ZERO.x;
      dummy.scale.setScalar(s.visUsed ? on : off);
      dummy.updateMatrix();
      imBright.setMatrixAt(d, dummy.matrix);
      dummy.scale.setScalar(s.visUsed ? off : on);
      dummy.updateMatrix();
      imDim.setMatrixAt(d, dummy.matrix);
    }
    imBright.instanceMatrix.needsUpdate = true;
    imDim.instanceMatrix.needsUpdate = true;
  }

  /* —— 三根柱子 —— */
  const pillarGeo = new T.BoxGeometry(0.86, 1, 0.86);
  const capGeo    = new T.BoxGeometry(0.98, 0.07, 0.98);
  const matPillar = pickMaterial(ctx, 'barrier.concrete', 'concrete.wall');
  const matCap    = pickMaterial(ctx, 'plinth', 'concrete.wall');
  const pillarMaxV = Math.max(...PILLAR_SPEC.map((p) => p.value));
  const pillars = PILLAR_SPEC.map((spec, i) => {
    const h = (spec.value / pillarMaxV) * PILLAR_MAX_H;
    const holder = new T.Group();
    holder.position.set(7.6, 0, (i - 1) * 2.15);
    const body = new T.Mesh(pillarGeo, matPillar);
    body.castShadow = true; body.receiveShadow = true;
    body.scale.y = 0.0001; body.position.y = 0;
    holder.add(body);
    const cap = new T.Mesh(capGeo, matCap);
    cap.castShadow = true; cap.receiveShadow = true;
    holder.add(cap);
    group.add(holder);
    return { spec, holder, body, cap, h, grow: 0 };
  });
  function layoutPillars() {
    for (const p of pillars) {
      const cur = Math.max(0.0001, p.h * p.grow);
      p.body.scale.y = cur;
      p.body.position.y = cur * 0.5;
      p.cap.position.y = cur + 0.035;
      p.cap.visible = p.grow > 0.02;
    }
  }
  layoutPillars();

  /* —— 39 台車隊 —— */
  const fleetIds = cars.map((c) => c.id);
  let fleet = null;
  const carSlots = [];        // { id, cx, cz, fx, fz, tx, tz, t, dur }
  const FLEET = { cols: 10, dx: 2.55, dz: 5.40, z0: -18.0 };

  function slotPos(rank) {
    const r = Math.floor(rank / FLEET.cols), c = rank % FLEET.cols;
    const rowN = Math.min(FLEET.cols, fleetIds.length - r * FLEET.cols);
    const w = (rowN - 1) * FLEET.dx;
    return { x: c * FLEET.dx - w * 0.5, z: FLEET.z0 - r * FLEET.dz };
  }

  if (ctx.carModels && typeof ctx.carModels.createFleet === 'function' && fleetIds.length) {
    try {
      fleet = ctx.carModels.createFleet(fleetIds);
      if (fleet && fleet.group) group.add(fleet.group);
    } catch (e) { fleet = null; }
  }
  fleetIds.forEach((id, i) => {
    const p = slotPos(i);
    carSlots.push({ id, i, x: p.x, z: p.z, fx: p.x, fz: p.z, tx: p.x, tz: p.z, t: 1, dur: 1.2 });
  });

  const _p = new T.Vector3();
  const _q = new T.Quaternion();
  function writeFleet() {
    if (!fleet) return;
    for (const s of carSlots) {
      const idx = (typeof fleet.indexOf === 'function') ? fleet.indexOf(s.id) : s.i;
      if (idx < 0) continue;
      _p.set(s.x, 0, s.z);
      _q.set(0, 0, 0, 1);
      fleet.setTransform(idx, _p, _q);
    }
    if (typeof fleet.commit === 'function') fleet.commit();
  }

  /* ───────────────── DOM overlay ───────────────── */

  const dom = el('div', 'r3-root');
  const style = el('style');
  style.textContent = `
.r3-root{position:absolute;inset:0;color:#17191C;
  font:400 15px/1.62 "Noto Sans TC","PingFang TC","Helvetica Neue",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;pointer-events:none}
.r3-root *{box-sizing:border-box}
.r3-cap{position:absolute;left:34px;top:44px;max-width:540px;
  background:rgba(255,255,255,.90);border:1px solid #D6D8DC;border-left:3px solid #A8442E;
  border-radius:3px;padding:18px 22px 16px;opacity:0;transform:translateY(10px);
  transition:opacity 380ms ${EASE.component},transform 380ms ${EASE.component}}
.r3-cap.on{opacity:1;transform:translateY(0)}
.r3-cap h2{margin:0 0 6px;font-size:20px;font-weight:700;letter-spacing:.01em;line-height:1.5}
.r3-cap p{margin:6px 0 0;font-size:14px;color:#4A4F55}
.r3-cap b{font-weight:700;color:#17191C}
.r3-note{margin-top:10px;font-size:11px;line-height:1.55;color:#8A9096;letter-spacing:.02em}
.r3-live{position:absolute;left:34px;bottom:196px;max-width:520px;
  background:rgba(255,255,255,.90);border:1px solid #D6D8DC;border-radius:3px;padding:14px 18px;
  opacity:0;transform:translateY(10px);
  transition:opacity 380ms ${EASE.component},transform 380ms ${EASE.component}}
.r3-live.on{opacity:1;transform:translateY(0)}
.r3-live .row{display:flex;justify-content:space-between;gap:18px;font-size:13px;
  padding:3px 0;border-bottom:1px dotted #DDE0E4}
.r3-live .row:last-child{border-bottom:0}
.r3-live .row span:last-child{font-variant-numeric:tabular-nums;font-weight:600}
.r3-panel{position:absolute;left:34px;bottom:34px;width:520px;
  background:rgba(255,255,255,.93);border:1px solid #D6D8DC;border-radius:3px;padding:16px 20px 14px;
  pointer-events:auto;opacity:0;transform:translateY(14px);
  transition:opacity 400ms ${EASE.component},transform 400ms ${EASE.component}}
.r3-panel.on{opacity:1;transform:translateY(0)}
.r3-panel label{display:flex;justify-content:space-between;align-items:baseline;
  font-size:13px;color:#4A4F55;margin-bottom:9px}
.r3-panel label b{font-size:21px;font-weight:700;color:#17191C;font-variant-numeric:tabular-nums}
.r3-panel input[type=range]{width:100%;height:22px;appearance:none;background:transparent;cursor:ew-resize}
.r3-panel input[type=range]::-webkit-slider-runnable-track{height:3px;background:#C9CCD1;border-radius:2px}
.r3-panel input[type=range]::-webkit-slider-thumb{appearance:none;width:20px;height:20px;margin-top:-8.5px;
  border-radius:50%;background:#A8442E;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.24);
  transition:transform 170ms ${EASE.micro}}
.r3-panel input[type=range]:active::-webkit-slider-thumb{transform:scale(1.18)}
.r3-panel input[type=range]::-moz-range-track{height:3px;background:#C9CCD1;border-radius:2px}
.r3-panel input[type=range]::-moz-range-thumb{width:18px;height:18px;border-radius:50%;
  background:#A8442E;border:2px solid #fff}
.r3-scale{display:flex;justify-content:space-between;font-size:11px;color:#8A9096;margin-top:2px}
.r3-tag{position:absolute;transform:translate(-50%,-100%);white-space:nowrap;
  background:rgba(255,255,255,.94);border:1px solid #D6D8DC;border-radius:3px;
  padding:6px 10px;font-size:12px;line-height:1.4;opacity:0;
  transition:opacity 340ms ${EASE.component}}
.r3-tag.on{opacity:1}
.r3-tag b{display:block;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.r3-tag.hi{border-color:#A8442E;border-width:1px 1px 2px}
.r3-rank{position:absolute;right:34px;top:44px;width:290px;
  background:rgba(255,255,255,.90);border:1px solid #D6D8DC;border-radius:3px;padding:14px 16px;
  opacity:0;transition:opacity 380ms ${EASE.component}}
.r3-rank.on{opacity:1}
.r3-rank h3{margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.06em;color:#6A6F76}
.r3-rank .li{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:3px 0}
.r3-rank .li i{font-style:normal;color:#8A9096;width:20px;flex:0 0 20px}
.r3-rank .li em{font-style:normal;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.r3-rank .li s{text-decoration:none;font-variant-numeric:tabular-nums;font-weight:600}
.r3-rank .sep{height:1px;background:#DDE0E4;margin:7px 0}
`;
  dom.appendChild(style);

  const cap = el('div', 'r3-cap');
  const live = el('div', 'r3-live');
  const rank = el('div', 'r3-rank');
  const panel = el('div', 'r3-panel');
  dom.append(cap, live, rank, panel);

  const tags = PILLAR_SPEC.map(() => { const t = el('div', 'r3-tag'); dom.appendChild(t); return t; });
  const moundTag = el('div', 'r3-tag'); dom.appendChild(moundTag);

  panel.innerHTML = `
<label><span>年用車天數</span><b><span id="r3v">52</span> 天／年</b></label>
<input id="r3s" type="range" min="20" max="200" step="1" value="52">
<div class="r3-scale"><span>20</span><span>110</span><span>200</span></div>
<div class="r3-note">${ESTIMATE_NOTE}：每用車日 181 km、油價 30.0 元/L、停車費 3,000 元/月、
五年殘值率 38.4%（1年78%→5年38.4%）。未計保養、保險、輪胎、貸款利息。</div>`;
  const slider = panel.querySelector('#r3s');
  const sliderVal = panel.querySelector('#r3v');

  /* ───────────────── 狀態與重算 ───────────────── */

  const st = {
    perYear: STATE.useDaysPerYear || 52,
    usedTotal: 0,
    clock: 0,
    phase: -1,
    started: false,
    dirty: true,
    pillarT: 0,
    pillarGo: false,
  };
  st.usedTotal = useDays5(st.perYear);

  function applyUsedMask(animate) {
    const mask = makeUsedMask(st.usedTotal);
    let dimRank = 0;
    const now = st.clock;
    for (let d = 0; d < DAYS_TOTAL; d++) {
      const s = cellState[d];
      const used = !!mask[d];
      const wasUsed = s.used;
      s.used = used;
      let tx, ty, tz, trx, try_, trz, tsc, arc, delay;
      if (used) {
        tx = gridPos[d * 3]; ty = gridPos[d * 3 + 1] + 0.028; tz = gridPos[d * 3 + 2];
        trx = 0; try_ = 0; trz = 0;
        tsc = 1.18;                             // 亮起 = 放大 + 抬高（陰影加深）
        arc = 0.10;
        delay = (d / DAYS_TOTAL) * 0.55;
      } else {
        const slot = pileSlots[Math.min(dimRank, pileSlots.length - 1)];
        const j = (h) => (Math.sin(d * h) * 0.5 + Math.sin(d * h * 2.7) * 0.5);
        tx = PILE.center[0] + slot.x + j(12.9898) * 0.03;
        ty = PILE.center[1] + slot.y;
        tz = PILE.center[2] + slot.z + j(78.233) * 0.03;
        trx = j(3.71) * 0.30; try_ = j(9.13) * 1.6; trz = j(5.37) * 0.30;
        tsc = 1.0;
        arc = 0.42 + slot.y * 0.35;
        delay = (dimRank / Math.max(1, DAYS_TOTAL)) * 1.55;   // 由下往上堆，先後差
        dimRank++;
      }
      if (!animate) {
        s.x = s.fx = s.tx = tx; s.y = s.fy = s.ty = ty; s.z = s.fz = s.tz = tz;
        s.rx = s.frx = s.trx = trx; s.ry = s.fry = s.try_ = try_; s.rz = s.frz = s.trz = trz;
        s.scale = s.fscale = s.tscale = tsc; s.t = 1; s.active = false; s.arc = 0;
        s.visUsed = used;
      } else if (wasUsed !== used || Math.abs(s.tx - tx) > 1e-4 || Math.abs(s.ty - ty) > 1e-4) {
        s.fx = s.x; s.fy = s.y; s.fz = s.z;
        s.frx = s.rx; s.fry = s.ry; s.frz = s.rz;
        s.fscale = s.scale;
        s.tx = tx; s.ty = ty; s.tz = tz;
        s.trx = trx; s.try_ = try_; s.trz = trz;
        s.tscale = tsc;
        s.arc = arc; s.t0 = now + delay * 0.55; s.dur = 0.85; s.t = 0; s.active = true;
      }
    }
    st.dirty = true;
  }

  function startFall() {
    const now = st.clock;
    const mask = makeUsedMask(st.usedTotal);
    let dimRank = 0;
    for (let d = 0; d < DAYS_TOTAL; d++) {
      const s = cellState[d];
      const used = !!mask[d];
      s.used = used;
      s.fx = s.x; s.fy = s.y; s.fz = s.z;
      s.frx = s.rx; s.fry = s.ry; s.frz = s.rz; s.fscale = s.scale;
      if (used) {
        s.tx = gridPos[d * 3]; s.ty = gridPos[d * 3 + 1] + 0.028; s.tz = gridPos[d * 3 + 2];
        s.trx = 0; s.try_ = 0; s.trz = 0; s.tscale = 1.18; s.arc = 0.06;
        s.t0 = now + 0.15 + (d / DAYS_TOTAL) * 0.5; s.dur = 0.5;
      } else {
        const slot = pileSlots[Math.min(dimRank, pileSlots.length - 1)];
        const j = (h) => (Math.sin(d * h) * 0.5 + Math.sin(d * h * 2.7) * 0.5);
        s.tx = PILE.center[0] + slot.x + j(12.9898) * 0.03;
        s.ty = PILE.center[1] + slot.y;
        s.tz = PILE.center[2] + slot.z + j(78.233) * 0.03;
        s.trx = j(3.71) * 0.30; s.try_ = j(9.13) * 1.6; s.trz = j(5.37) * 0.30;
        s.tscale = 1.0; s.arc = 0.42 + slot.y * 0.35;
        s.t0 = now + (dimRank / DAYS_TOTAL) * 1.85;      // ★ 落下先後差
        s.dur = 0.9;
        dimRank++;
      }
      s.t = 0; s.active = true;
    }
    st.dirty = true;
  }

  function recalcFleetOrder(animate) {
    if (!cars.length) return;
    const order = cars.map((c) => ({ id: c.id, v: perUseDayCost(c, st.perYear) }))
                      .sort((a, b) => a.v - b.v);
    order.forEach((o, r) => {
      const s = carSlots.find((k) => k.id === o.id);
      if (!s) return;
      const p = slotPos(r);
      if (!animate) { s.x = s.fx = s.tx = p.x; s.z = s.fz = s.tz = p.z; s.t = 1; }
      else if (Math.abs(s.tx - p.x) > 1e-3 || Math.abs(s.tz - p.z) > 1e-3) {
        s.fx = s.x; s.fz = s.z; s.tx = p.x; s.tz = p.z; s.t = 0; s.dur = 1.2;   // 1200ms 實際移動
      }
    });
    writeFleet();
    return order;
  }

  const yaris = cars.find((c) => c.model === 'Yaris Cross' && c.trim === '享樂版') || cars[0] || null;

  function refreshReadout() {
    const idle = DAYS_TOTAL - st.usedTotal;
    const idlePct = (idle / DAYS_TOTAL * 100).toFixed(1);
    const order = cars.length
      ? cars.map((c) => ({ c, v: perUseDayCost(c, st.perYear) })).sort((a, b) => a.v - b.v)
      : [];
    const cheapest = order[0];
    const n32 = cars.length ? countParkBeatsRest(cars, st.perYear) : 0;
    const yFuel = yaris ? fuel5Cost(yaris, st.perYear) : 0;
    const yTax  = yaris ? tax5Cost(yaris) : 0;

    live.innerHTML = `
<div class="row"><span>五年 ${nf(DAYS_TOTAL)} 天，你只用</span><span>${nf(st.usedTotal)} 天</span></div>
<div class="row"><span>閒置率</span><span>${idlePct}%</span></div>
<div class="row"><span>停車費 &gt; 油錢＋稅金 的車</span><span>${n32} / ${cars.length} 台</span></div>
${cheapest ? `<div class="row"><span>每用車日成本最低：${cheapest.c.model} ${cheapest.c.trim}</span><span>${nf(cheapest.v)} 元</span></div>` : ''}
<div class="r3-note">${ESTIMATE_NOTE}。以 ${yaris ? yaris.model + ' ' + yaris.trim : '基準車'} 實算：
五年油錢 ${nf(yFuel)} 元、五年稅金 ${nf(yTax)} 元、五年停車費 ${nf(PARK_5Y)} 元。</div>`;

    if (order.length) {
      const top = order.slice(0, 5), bot = order.slice(-2);
      rank.innerHTML = `<h3>每用車日成本排序（${nf(st.usedTotal)} 個用車日）</h3>` +
        top.map((o, i) => `<div class="li"><i>${i + 1}</i><em>${o.c.model} ${o.c.trim}</em><s>${nf(o.v)}</s></div>`).join('') +
        `<div class="sep"></div>` +
        bot.map((o, i) => `<div class="li"><i>${order.length - 1 + i}</i><em>${o.c.model} ${o.c.trim}</em><s>${nf(o.v)}</s></div>`).join('') +
        `<div class="r3-note">${ESTIMATE_NOTE}</div>`;
    }
  }

  /* ───────────────── 四個段落的文案 ───────────────── */

  function showCap(html) {
    cap.classList.remove('on');
    window.setTimeout(() => { cap.innerHTML = html; cap.classList.add('on'); }, 220);
  }

  function capBeat2() {
    const n = cars.length;
    showCap(`<h2>五年 1,825 天，你只用 260 天。閒置率 85.8%。</h2>
<p>1,565 格黯淡下去，落成那座灰丘。</p>
<div class="r3-note">${ESTIMATE_NOTE}：預設 52 天／年 × 5 年 = 260 天。灰丘為 ${n ? '1,565' : '1,565'} 格堆疊近似，非物理模擬。</div>`);
  }

  function capBeat3() {
    const n32 = cars.length ? countParkBeatsRest(cars, st.perYear) : 0;
    const same = n32 === 32;
    showCap(`<h2>你付給那個空格子的錢，比付給石油公司和政府的總和還多。</h2>
<p>（39 台裡 <b>32</b> 台如此）</p>
<div class="r3-note">${ESTIMATE_NOTE}。實算：以 260 個用車日、每日 181 km、油價 30.0 元/L 計，
「五年停車費 180,000 &gt; 五年油錢＋五年稅金」者共 <b>${n32}</b> / ${cars.length} 台${same ? '，與文案相符' : '（與文案 32 台不同，以實算值為準）'}。
展板「油錢 80,672」為文案給定值，本模組實算 ${yaris ? nf(fuel5Cost(yaris, 52)) : '—'} 元（差 2 元，四捨五入）。</div>`);
  }

  function capBeat4() {
    const order = cars.map((c) => ({ c, v: perUseDayCost(c, 52) })).sort((a, b) => a.v - b.v);
    const y = yaris ? perUseDayCost(yaris, 52) : NaN;
    const ok = Math.round(y) === 2878;
    showCap(`<h2>就算選最便宜的 Yaris Cross 享樂版，<br>每一個出遊日的成本是 2,878 元。</h2>
<p>拖動下面唯一的滑桿，看它怎麼變。</p>
<div class="r3-note">${ESTIMATE_NOTE}。驗算：(695,000 + 80,674 油錢 + 59,600 稅金 + 180,000 停車費 − 266,880 殘值) ÷ 260
= <b>${nf(y)}</b> 元／用車日${ok ? '，與文案 2,878 元相符' : '（與文案 2,878 元不同，以實算值為準）'}；
在 39 台中排名第 ${order.findIndex((o) => o.c === yaris) + 1}。殘值率 38.4% 為反推校準值。</div>`);
  }

  /* ───────────────── 滑桿（★ 必須 oninput） ───────────────── */

  slider.oninput = (e) => {
    const v = Math.max(20, Math.min(200, parseInt(e.target.value, 10) || 52));
    st.perYear = v;
    st.usedTotal = useDays5(v);
    sliderVal.textContent = String(v);
    applyUsedMask(true);            // 1,825 格即時改變
    recalcFleetOrder(true);         // 39 台依每用車日成本重排（1200ms）
    refreshReadout();
    STATE.useDaysPerYear = v;
    emit(EV.USEDAYS_CHANGED, { useDaysPerYear: v, useDays5: st.usedTotal, room: ROOM_KEY });
    emit(EV.STATE_CHANGED, { keys: ['useDaysPerYear'], room: ROOM_KEY });
  };

  /* ───────────────── 時間軸 ───────────────── */

  const TL = [
    { t: 0.80, fn: () => { /* 段落 1：地面浮現 */
        for (let d = 0; d < DAYS_TOTAL; d++) {
          const s = cellState[d];
          s.used = true;                    // 浮現階段全部視為「亮」
          s.fx = s.x; s.fy = -0.42; s.fz = s.z; s.y = -0.42;
          s.tx = gridPos[d * 3]; s.ty = gridPos[d * 3 + 1]; s.tz = gridPos[d * 3 + 2];
          s.trx = 0; s.try_ = 0; s.trz = 0; s.tscale = 1; s.fscale = 1; s.arc = 0;
          const r = Math.floor(d / COLS), c = d % COLS;
          const diag = (r + c) / (COLS * 2 - 2);
          s.t0 = st.clock + diag * 1.35;    // 逐格延遲，總長約 1.8 s
          s.dur = 0.45; s.t = 0; s.active = true;
        }
        showCap(`<h2>1,825 個格子，是你未來五年的每一天。</h2>
<p>每格 20 × 20 公分，鋪滿 11.6 × 11.6 公尺。</p>`);
      } },
    { t: 3.55, fn: () => { startFall(); capBeat2(); moundTag.classList.add('on'); } },
    { t: 6.60, fn: () => { st.pillarGo = true; } },
    { t: 7.05, fn: () => { capBeat3(); tags.forEach((t) => t.classList.add('on')); } },
    { t: 9.60, fn: () => {
        capBeat4();
        panel.classList.add('on'); live.classList.add('on'); rank.classList.add('on');
      } },
  ];

  /* ───────────────── 標籤投影 ───────────────── */

  const _v = new T.Vector3();
  function projectTag(node, world, camera) {
    const cv = ctx.renderer && ctx.renderer.domElement;
    const w = cv ? cv.clientWidth : window.innerWidth;
    const h = cv ? cv.clientHeight : window.innerHeight;
    _v.copy(world).project(camera);
    const behind = _v.z > 1;
    node.style.left = `${(_v.x * 0.5 + 0.5) * w}px`;
    node.style.top = `${(-_v.y * 0.5 + 0.5) * h}px`;
    node.style.visibility = behind ? 'hidden' : 'visible';
  }

  /* ───────────────── RoomHandle ───────────────── */

  let mounted = false;

  const handle = {
    key: ROOM_KEY,
    group,
    spawn: { pos: [0, 1.6, 15.5], yaw: 0 },

    enter() {
      if (!mounted) { uiRoot.appendChild(dom); mounted = true; }
      st.clock = 0; st.phase = -1; st.started = true; st.pillarT = 0; st.pillarGo = false;
      for (const p of pillars) p.grow = 0;
      layoutPillars();
      st.perYear = STATE.useDaysPerYear || 52;
      st.usedTotal = useDays5(st.perYear);
      slider.value = String(st.perYear);
      sliderVal.textContent = String(st.perYear);
      // 全部藏在地面下，等段落 1 浮現
      for (let d = 0; d < DAYS_TOTAL; d++) {
        const s = cellState[d];
        s.used = true; s.visUsed = true; s.scale = 1; s.t = 1; s.active = false;
        s.x = gridPos[d * 3]; s.y = -0.42; s.z = gridPos[d * 3 + 2];
        s.rx = s.ry = s.rz = 0;
      }
      writeInstances();
      recalcFleetOrder(false);
      refreshReadout();
      cap.classList.remove('on');
      panel.classList.remove('on'); live.classList.remove('on'); rank.classList.remove('on');
      tags.forEach((t) => t.classList.remove('on'));
      moundTag.classList.remove('on');
      moundTag.innerHTML = `<b>1,565 天</b>閒置的日子，堆成 1.5 公尺`;
      tags.forEach((t, i) => {
        const p = PILLAR_SPEC[i];
        t.innerHTML = `${p.label}<b>${nf(p.value)}</b>`;
        if (p.key === 'park') t.classList.add('hi');
      });
      emit(EV.ROOM_ENTER, { room: ROOM_KEY });
    },

    exit() {
      st.started = false;
      if (mounted && dom.parentNode) { dom.parentNode.removeChild(dom); mounted = false; }
      emit(EV.ROOM_EXIT, { room: ROOM_KEY });
    },

    update(dt, elapsed, camera) {
      const d = Math.min(dt || 0, 0.05);
      if (st.started) {
        st.clock += d;
        for (let i = st.phase + 1; i < TL.length; i++) {
          if (st.clock >= TL[i].t) { st.phase = i; TL[i].fn(); } else break;
        }
      }
      if (rig && typeof rig.update === 'function') rig.update(d, elapsed);

      // 格子補間
      let anyActive = false;
      for (let i = 0; i < DAYS_TOTAL; i++) {
        const s = cellState[i];
        if (!s.active) continue;
        if (st.clock < s.t0) { anyActive = true; continue; }
        if (s.visUsed !== s.used) { s.visUsed = s.used; st.dirty = true; }
        s.t = Math.min(1, (st.clock - s.t0) / s.dur);
        const e = EASE_FN.inOutQuint(s.t);
        s.x = s.fx + (s.tx - s.fx) * e;
        s.z = s.fz + (s.tz - s.fz) * e;
        s.y = s.fy + (s.ty - s.fy) * e + Math.sin(Math.PI * s.t) * s.arc;
        s.rx = s.frx + (s.trx - s.frx) * e;
        s.ry = s.fry + (s.try_ - s.fry) * e;
        s.rz = s.frz + (s.trz - s.frz) * e;
        s.scale = s.fscale + (s.tscale - s.fscale) * e;
        if (s.t >= 1) { s.active = false; s.y = s.ty; } else anyActive = true;
      }
      if (anyActive || st.dirty) { writeInstances(); st.dirty = anyActive; }

      // 柱子生長（1.6 s，逐根 0.25 s 錯開）
      if (st.pillarGo) {
        st.pillarT += d;
        let changed = false;
        pillars.forEach((p, i) => {
          const local = Math.max(0, Math.min(1, (st.pillarT - i * 0.25) / 1.6));
          const g = EASE_FN.inOutQuint(local);
          if (g !== p.grow) { p.grow = g; changed = true; }
        });
        if (changed) layoutPillars();
      }

      // 車隊重排補間
      let fleetChanged = false;
      for (const s of carSlots) {
        if (s.t >= 1) continue;
        s.t = Math.min(1, s.t + d / s.dur);
        const e = EASE_FN.inOutQuint(s.t);
        s.x = s.fx + (s.tx - s.fx) * e;
        s.z = s.fz + (s.tz - s.fz) * e;
        fleetChanged = true;
      }
      if (fleetChanged) writeFleet();
      if (ctx.carModels && typeof ctx.carModels.update === 'function') ctx.carModels.update(d, elapsed, camera);

      // 標籤投影
      if (camera) {
        pillars.forEach((p, i) => {
          _v.set(p.holder.position.x, p.h * p.grow + 0.22, p.holder.position.z);
          projectTag(tags[i], _v, camera);
        });
        _v.set(PILE.center[0], 1.72, PILE.center[2]);
        projectTag(moundTag, _v, camera);
      }
    },

    dispose() {
      handle.exit();
      cellGeo.dispose(); pillarGeo.dispose(); capGeo.dispose();
      if (rig && typeof rig.dispose === 'function') rig.dispose();
      group.clear();
    },
  };

  return handle;
}

/** node 端自我驗算（瀏覽器不會走到；供 CI / 主代理對帳用） */
export function __selfCheck(cars) {
  const y = cars.find((c) => c.model === 'Yaris Cross' && c.trim === '享樂版');
  return {
    fuel5_yaris: Math.round(fuel5Cost(y, 52)),
    tax5_yaris: tax5Cost(y),
    park5: PARK_5Y,
    parkBeatsRest: countParkBeatsRest(cars, 52),
    perUseDay_yaris: Math.round(perUseDayCost(y, 52)),
  };
}
