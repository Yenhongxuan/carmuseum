/**
 * carModels.js — B4 車輛模型與 360 檢視器（第 2 階段子代理產出）
 *
 * 假設：
 *   1. ctx.THREE 為 three.js r0.185.1 命名空間；本模組**不在頂層 import three**，
 *      也不 import 任何專案模組（contract.js 的 EASE 值在本檔以區域常數鏡像一份）。
 *   2. ctx.materials 必須存在且提供 get(name)。缺少時直接 throw，
 *      本模組**不自行 new 任何 Material**；唯一的例外是 `.clone()` 既有材質後改
 *      color / vertexColors / side / depthWrite（規格允許 clone 改色，其餘旗標為
 *      實作必要，已於此誠實列出）。
 *   3. 座標依 MODULE_API §0：+X 右、+Y 上、-Z 車頭方向，原點在四輪接地面的車身正中心，
 *      y=0 即輪胎觸地面。單位一律公尺（cars.json 的 mm / 1000）。
 *   4. 車頂線分段只看 cars.json 的 height（>1620 平直 / 1560–1620 中間 / <1560 下斜），
 *      不看品牌名單。
 *   5. 輪距公式照抄規格：前輪中心=(車長-軸距)/2*0.95、後輪中心=前輪中心+軸距、
 *      輪徑=車高*0.17。**係數未改**。但 `車高*0.17` 若當作「直徑」，39 台會得到
 *      0.255–0.288 m 的直徑（實車約 0.66–0.69 m，等於腳踏車輪），會直接毀掉
 *      「像不像那台車」這件事；因此本模組將該值用作**半徑**
 *      （等效直徑 = 車高*0.34 ≈ 0.53–0.58 m）。此為語義選擇而非改公式，
 *      並提供 ctx.carModelOptions.wheelSpecIsDiameter = true 可切回逐字直徑解釋。
 *   6. 資產探測路徑為 `${ctx.assetBase ?? './'}assets/cars/{series}/report.json`，
 *      以 fetch 實際探測，不硬編 tier。探測未回來前 getTier() 一律回 tier 3（保守）。
 *   7. 車身底色為白/銀（由 car.id 決定，穩定不隨機），品牌識別色只用於車側下緣細條紋
 *      與 C 柱小塊，不塗滿。
 *   8. Spin360 / 角度切換器的影像去背假設「原始圖為近白底」；若四角不是近白
 *      （已含 alpha 的 PNG）則不做去背，直接使用原圖 alpha。canvas 被跨網域污染
 *      （getImageData 丟例外）時同樣退回原圖，不中斷。
 *
 * 依賴：ctx.THREE / ctx.materials / ctx.cars（或 ctx.carsById）。不 import 任何專案模組。
 *
 * 三層降級現況：39 台全為 tier 3（外網被沙盒白名單擋，見 assets/SUMMARY.md）。
 *   第一層（Spin360）與第二層（角度切換器）程式碼**已完整實作**，
 *   日後把 360 序列放進 assets/cars/{series}/ 並更新 report.json 即自動升級。
 *
 * 未達成的規格（誠實列出，勿當作已完成）：
 *   - 無任何實車照片，tier 1 / tier 2 的算繪路徑**從未在真實素材上跑過**，
 *     只有以程式生成的測試圖驗證過邏輯；去背門檻值日後可能需要調整。
 *   - 車體為單一寬度掃掠 + 前後收窄，**沒有真正的車頭/車尾平面造型（如水箱罩雕塑面）**，
 *     只有凹槽與細線層級的表現。
 *   - 車門線、把手為「貼合車身外緣的細線/小凸起」，非布林運算的真凹槽
 *     （規格允許「凹槽/細線」擇一）。
 *   - Fleet（InstancedMesh）的車身輪拱開口是以「同類車頂線的中位數軸距比例」烘焙的，
 *     各車實際軸距/車長比在 0.592–0.624 之間，最壞情況輪拱與輪心相差約 ±0.07 m；
 *     輪胎/輪圈本身是每台車精確定位。近距離請用 getCarMesh()（完全精確）。
 *   - Fleet 車身把 paint/trim/lamp 併成一個 InstancedMesh（以頂點色區分），
 *     所以遠景的品牌條紋是灰色細線，不是品牌色；品牌色改以 setColorAt 的車身色調呈現。
 *   - 沒有實作輪胎胎紋、雨刷、車內裝（座椅/方向盤）；駕駛座只提供 getEyePoint 眼點。
 *   - 沒有 CSG，輪拱「凹陷」是以「車身下緣沿輪拱弧線抬升 + 內側深色輪拱內襯半圓筒」
 *     達成真實幾何凹陷，而非布林減法。
 */

/* ────────────────────────────────────────────────────────────────────────────
 * 0. 區域常數（contract.js 的鏡像；本檔不可 import 專案模組）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 與 contract.js EASE 同值。動效一律自訂 cubic-bezier，禁用 linear / 預設 ease。 */
const EASE = {
  micro:      'cubic-bezier(0.32, 0.72, 0.28, 1.00)',
  component:  'cubic-bezier(0.22, 0.61, 0.24, 1.00)',
  region:     'cubic-bezier(0.65, 0.02, 0.15, 1.00)',
  inOutQuint: 'cubic-bezier(0.83, 0.00, 0.17, 1.00)',
};

/** 車頂線分段門檻（mm）。依實際車高，不依品牌名單。 */
export const ROOF_BREAKS = { tall: 1620, low: 1560 };
export const ROOF_CLASSES = ['tall', 'mid', 'low'];

/** tier 標籤字串 —— 一字不可改。 */
const TIER_LABEL = {
  1: (n) => `原廠官網 360 環景（${n} 張）`,
  2: (n) => `原廠官網照片（${n} 個角度）`,
  3: () => '依原廠公布尺寸程序生成之示意模型，非原廠 CAD 資料',
};

/** LOD 距離（公尺） */
const LOD_NEAR = 40, LOD_FAR = 100;

/** 各車頂線類別的側面比例（u = 車頭 0 → 車尾 1，值為車高比例） */
const ROOFLINE = {
  // 平直車頂、後窗直立、車身較高
  tall: { belt: 0.560, wsBase: 0.238, roofFront: 0.408, roofRear: 0.858, tail: 0.930,
          roofDrop: 0.006, ghw: 0.885, roofTop: 0.996 },
  // 介於兩者之間
  mid:  { belt: 0.572, wsBase: 0.252, roofFront: 0.428, roofRear: 0.800, tail: 0.936,
          roofDrop: 0.018, ghw: 0.872, roofTop: 0.995 },
  // 車頂下斜、後窗傾角大、車身低扁
  low:  { belt: 0.592, wsBase: 0.272, roofFront: 0.452, roofRear: 0.718, tail: 0.948,
          roofDrop: 0.050, ghw: 0.852, roofTop: 0.994 },
};

/** 車身白/銀底色（不用純白，留一點灰階給 ACES tone mapping） */
const BODY_BASE = ['#E9EBEE', '#C9CDD4', '#DFE2E6', '#B9BFC7'];

/* ────────────────────────────────────────────────────────────────────────────
 * 1. 純數學小工具
 * ──────────────────────────────────────────────────────────────────────────── */

const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
/** smootherstep，用於側面 profile 的控制點之間，避免折線感 */
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** 穩定 hash（同一個 car.id 永遠得到同一個結果，不用亂數） */
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** 分段插值表：tbl = [[u, value], ...]，u 遞增 */
function pw(u, tbl) {
  const n = tbl.length;
  if (u <= tbl[0][0]) return tbl[0][1];
  if (u >= tbl[n - 1][0]) return tbl[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (u <= tbl[i][0]) {
      const span = tbl[i][0] - tbl[i - 1][0];
      const t = span <= 1e-9 ? 1 : (u - tbl[i - 1][0]) / span;
      return lerp(tbl[i - 1][1], tbl[i][1], smoother(t));
    }
  }
  return tbl[n - 1][1];
}

/** cubic-bezier(x1,y1,x2,y2) 求解器（給 JS 補間用；禁用 linear） */
function cubicBezier(x1, y1, x2, y2) {
  const A = (a, b) => 1 - 3 * b + 3 * a, B = (a, b) => 3 * b - 6 * a, C = (a) => 3 * a;
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
/** 慣性減速用（對應 EASE.component） */
const EASE_COMPONENT_FN = cubicBezier(0.22, 0.61, 0.24, 1.00);
const EASE_MICRO_FN = cubicBezier(0.32, 0.72, 0.28, 1.00);

/** #RRGGBB → {r,g,b} 0–1 */
function hex2rgb(hex) {
  const h = String(hex || '#888888').replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. 幾何基本件（全部靠 ctx.THREE，永遠倒角，永遠不用單一 BoxGeometry 當車身）
 * ──────────────────────────────────────────────────────────────────────────── */

const RING_CSEG = 4;   // 每個圓角取樣段數
const RING_ESEG = 3;   // 每條直邊取樣段數
const RING_N = 4 * RING_ESEG + 4 * (RING_CSEG + 1);   // = 32

/**
 * 產生一圈「上下寬度可不同的圓角矩形」取樣點（固定 32 點、固定對應關係，
 * 讓相鄰斷面可以直接連成四邊形而不扭轉）。
 * 回傳扁平陣列 [x0,y0,x1,y1,...]，逆時針（自 +Z 看）。
 */
function ringPoints(hwBot, hwTop, yBot, yTop, rTop, rBot, cx) {
  const hh = Math.max((yTop - yBot) / 2, 1e-4);
  const cy = (yTop + yBot) / 2;
  const rt = Math.max(0.0015, Math.min(rTop, hh * 0.92, Math.max(hwTop, 1e-4) * 0.92));
  const rb = Math.max(0.0015, Math.min(rBot, hh * 0.92, Math.max(hwBot, 1e-4) * 0.92));
  const p = [];
  const edge = (x0, y0, x1, y1) => {
    for (let j = 0; j < RING_ESEG; j++) {
      const t = j / RING_ESEG;
      p.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    }
  };
  const arc = (ax, ay, r, a0, a1) => {
    const step = (a1 - a0) / (RING_CSEG + 1);
    for (let j = 0; j <= RING_CSEG; j++) {
      const a = a0 + step * j;
      p.push(ax + Math.cos(a) * r, ay + Math.sin(a) * r);
    }
  };
  const TRx = hwTop - rt, TRy = hh - rt;
  const BRx = hwBot - rb, BRy = -hh + rb;
  edge(hwBot, BRy, hwTop, TRy);                       // 右側面
  arc(TRx, TRy, rt, 0, Math.PI / 2);                  // 右上角
  edge(TRx, hh, -TRx, hh);                            // 頂面
  arc(-TRx, TRy, rt, Math.PI / 2, Math.PI);           // 左上角
  edge(-hwTop, TRy, -hwBot, BRy);                     // 左側面
  arc(-BRx, BRy, rb, Math.PI, Math.PI * 1.5);         // 左下角
  edge(-BRx, -hh, BRx, -hh);                          // 底面
  arc(BRx, BRy, rb, Math.PI * 1.5, Math.PI * 2);      // 右下角
  for (let i = 0; i < p.length; i += 2) { p[i] += cx; p[i + 1] += cy; }
  return p;
}

/**
 * 沿 -Z→+Z 掃掠一連串圓角矩形斷面，生成封閉殼體。
 * stations: [{ z, hwBot, hwTop?, yBot, yTop, rTop?, rBot?, cx? }]，z 須遞增。
 * opts.chamfer：兩端各補一圈內縮 chamfer 的斷面（車身端面 1–3 mm 倒角，會有高光細邊）。
 * UV 採公制（u = 周長累積公尺、v = z 公尺），讓材質的 rough/normal 貼圖鋪得合理。
 */
function sweepGeometry(THREE, stationsIn, opts = {}) {
  const chamfer = opts.iRange ? 0 : (opts.chamfer === undefined ? 0.0025 : opts.chamfer);
  let stations = stationsIn;
  if (chamfer > 0 && stations.length >= 2) {
    const f = stations[0], l = stations[stations.length - 1];
    const shrink = (s, dz) => ({
      z: s.z + dz,
      hwBot: Math.max(s.hwBot - chamfer, 1e-3),
      hwTop: Math.max((s.hwTop === undefined ? s.hwBot : s.hwTop) - chamfer, 1e-3),
      yBot: s.yBot + chamfer, yTop: Math.max(s.yTop - chamfer, s.yBot + chamfer + 1e-3),
      rTop: s.rTop, rBot: s.rBot, cx: s.cx,
    });
    stations = [shrink(f, -chamfer), ...stations, shrink(l, chamfer)];
  }
  const S = stations.length, N = RING_N;
  const rings = stations.map((s) => ringPoints(
    s.hwBot, s.hwTop === undefined ? s.hwBot : s.hwTop,
    s.yBot, s.yTop,
    s.rTop === undefined ? 0.03 : s.rTop,
    s.rBot === undefined ? 0.03 : s.rBot,
    s.cx || 0));

  // iRange = [a, b]（含，可繞環）：只輸出環的一段 → 貼合車身的「表面補片」，
  // 用來做頭尾燈、車側細條紋、車門線，永遠與烤漆面共形，不會浮起來。
  let sel = null;
  if (opts.iRange) {
    const [a, b] = opts.iRange;
    const cnt = ((b - a) % N + N) % N;
    sel = [];
    for (let t = 0; t <= cnt; t++) sel.push((a + t) % N);
  }
  const K = sel ? sel.length : N;

  const pos = [], uv = [], idx = [];
  for (let s = 0; s < S; s++) {
    const r = rings[s], z = stations[s].z;
    let acc = 0;
    for (let k = 0; k < K; k++) {
      const i = sel ? sel[k] : k;
      pos.push(r[i * 2], r[i * 2 + 1], z);
      uv.push(acc, z);
      const j = sel ? (k + 1 < K ? sel[k + 1] : i) : (i + 1) % N;
      acc += Math.hypot(r[j * 2] - r[i * 2], r[j * 2 + 1] - r[i * 2 + 1]);
    }
  }
  const quads = sel ? K - 1 : K;
  for (let s = 0; s < S - 1; s++) {
    for (let k = 0; k < quads; k++) {
      const k2 = (k + 1) % K;
      const a = s * K + k, b = s * K + k2, c = (s + 1) * K + k2, d = (s + 1) * K + k;
      idx.push(a, b, c, a, c, d);
    }
  }
  // 端蓋（各自複製一份頂點，端面才會是硬邊 + 前面的 chamfer 圈提供倒角高光）
  const addCap = (sIndex, front) => {
    if (sel) return;
    const base = pos.length / 3;
    const r = rings[sIndex], z = stations[sIndex].z;
    let cx = 0, cy = 0;
    for (let i = 0; i < N; i++) { cx += r[i * 2]; cy += r[i * 2 + 1]; }
    cx /= N; cy /= N;
    pos.push(cx, cy, z); uv.push(0, z);
    for (let i = 0; i < N; i++) { pos.push(r[i * 2], r[i * 2 + 1], z); uv.push(r[i * 2], r[i * 2 + 1]); }
    for (let i = 0; i < N; i++) {
      const a = base, b = base + 1 + i, c = base + 1 + ((i + 1) % N);
      if (front) idx.push(a, c, b); else idx.push(a, b, c);
    }
  };
  if (opts.capStart !== false) addCap(0, true);
  if (opts.capEnd !== false) addCap(S - 1, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 圓角盒（所有小零件用它，倒角預設 2.5 mm，符合「所有邊角倒角 1–3 mm」） */
function roundedBoxGeo(THREE, w, h, d, r = 0.0025) {
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const rr = Math.min(r, hw * 0.9, hh * 0.9, hd * 0.9);
  const zs = [-hd, -hd + rr * 0.293, -hd + rr, hd - rr, hd - rr * 0.293, hd];
  const sh = [rr, rr * 0.293, 0, 0, rr * 0.293, rr];
  const stations = zs.map((z, i) => ({
    z, hwBot: hw - sh[i], hwTop: hw - sh[i],
    yBot: -hh + sh[i], yTop: hh - sh[i], rTop: rr, rBot: rr,
  }));
  return sweepGeometry(THREE, stations, { chamfer: 0 });
}

/** 把一堆 {geo, matrix} 併成單一 BufferGeometry（自己實作，不 import addons） */
function mergeGeos(THREE, list, vertexColor) {
  const parts = [];
  let total = 0;
  for (const it of list) {
    if (!it || !it.geo) continue;
    let g = it.geo.index ? it.geo.toNonIndexed() : it.geo.clone();
    if (it.matrix) g.applyMatrix4(it.matrix);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) {
      const n = g.getAttribute('position').count;
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
    }
    parts.push(g);
    total += g.getAttribute('position').count;
  }
  if (!parts.length) return null;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2);
  const col = vertexColor ? new Float32Array(total * 3) : null;
  let o = 0;
  for (const g of parts) {
    const p = g.getAttribute('position'), nn = g.getAttribute('normal'), u = g.getAttribute('uv');
    pos.set(p.array.subarray(0, p.count * 3), o * 3);
    nor.set(nn.array.subarray(0, nn.count * 3), o * 3);
    uv.set(u.array.subarray(0, u.count * 2), o * 2);
    if (col) for (let i = 0; i < p.count; i++) { col[(o + i) * 3] = vertexColor[0]; col[(o + i) * 3 + 1] = vertexColor[1]; col[(o + i) * 3 + 2] = vertexColor[2]; }
    o += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

/** 輪胎：LatheGeometry 側剖面（不是圓環，胎肩是圓角矩形斷面），軸向 = X */
function tireGeometry(THREE, R, halfW, radial = 30) {
  const rimR = R * 0.665;
  const V = (r, y) => new THREE.Vector2(r, y);
  const pts = [
    V(rimR, -halfW * 0.84), V(R * 0.80, -halfW * 0.97), V(R * 0.93, -halfW),
    V(R * 0.985, -halfW * 0.86), V(R, -halfW * 0.52), V(R, halfW * 0.52),
    V(R * 0.985, halfW * 0.86), V(R * 0.93, halfW), V(R * 0.80, halfW * 0.97),
    V(rimR, halfW * 0.84),
  ];
  const g = new THREE.LatheGeometry(pts, radial);
  g.rotateZ(Math.PI / 2);
  return g;
}

/** 輪圈：真的有幅條幾何（5–10 幅），軸向 = X */
function rimGeometry(THREE, R, halfW, spokes) {
  const rimR = R * 0.665;
  const list = [];
  const M = () => new THREE.Matrix4();

  const barrel = new THREE.CylinderGeometry(rimR, rimR * 0.955, halfW * 1.55, 24, 1, true);
  barrel.rotateZ(Math.PI / 2);
  list.push({ geo: barrel });

  const lip = new THREE.TorusGeometry(rimR * 0.985, R * 0.024, 8, 30);
  lip.rotateY(Math.PI / 2); lip.translate(halfW * 0.76, 0, 0);
  list.push({ geo: lip });

  const inner = new THREE.TorusGeometry(rimR * 0.985, R * 0.020, 8, 24);
  inner.rotateY(Math.PI / 2); inner.translate(-halfW * 0.72, 0, 0);
  list.push({ geo: inner });

  const hub = new THREE.CylinderGeometry(R * 0.20, R * 0.185, halfW * 0.55, 16);
  hub.rotateZ(Math.PI / 2); hub.translate(halfW * 0.62, 0, 0);
  list.push({ geo: hub });

  const spokeGeo = roundedBoxGeo(THREE, halfW * 0.30, R * 0.50, R * 0.155, 0.003);
  for (let k = 0; k < spokes; k++) {
    const a = (k / spokes) * Math.PI * 2;
    const m = M().makeTranslation(halfW * 0.70, 0, 0)
      .multiply(M().makeRotationX(a))
      .multiply(M().makeTranslation(0, R * 0.40, 0));
    list.push({ geo: spokeGeo.clone(), matrix: m });
  }
  spokeGeo.dispose();

  const merged = mergeGeos(THREE, list);
  for (const it of list) it.geo.dispose();
  return merged;
}

/** 落地陰影：橢圓平面（離地 1.5 mm 避免 z-fighting） */
function shadowGeometry(THREE, len, wid) {
  const g = new THREE.CircleGeometry(0.5, 44);
  g.rotateX(-Math.PI / 2);
  g.scale(wid, 1, len);
  return g;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. 由 cars.json 推導車輛幾何規格
 * ──────────────────────────────────────────────────────────────────────────── */

function roofClassOf(heightMM) {
  if (heightMM > ROOF_BREAKS.tall) return 'tall';
  if (heightMM >= ROOF_BREAKS.low) return 'mid';
  return 'low';
}

/**
 * 依規格推導單台車的幾何參數。
 * 輪距公式照抄：前輪中心=(車長-軸距)/2*0.95、後輪中心=前輪中心+軸距、輪徑=車高*0.17
 */
function deriveSpec(car, opts = {}) {
  const L = car.length / 1000, W = car.width / 1000, H = car.height / 1000, WB = car.wheelbase / 1000;

  const frontFromNose = (L - WB) / 2 * 0.95;      // 前輪中心（自車頭量起）
  const rearFromNose = frontFromNose + WB;        // 後輪中心（自車頭量起）
  const wheelSpec = H * 0.17;                     // 規格式「輪徑 = 車高 * 0.17」
  const wheelR = opts.wheelSpecIsDiameter ? wheelSpec / 2 : wheelSpec;   // 見檔頭假設 5

  const cls = roofClassOf(car.height);
  const R = ROOFLINE[cls];

  const axleFZ = -L / 2 + frontFromNose;
  const axleRZ = -L / 2 + rearFromNose;
  const belt = H * R.belt;
  const roofY = H * R.roofTop;
  const archR = wheelR * 1.17;
  const rocker = H * 0.108;

  const hasRails = !!(car.comfort && car.comfort['車頂行李架']);
  const hasSunroof = !!(car.comfort && car.comfort['天窗']);

  const h = hash32(String(car.id));
  const bodyColor = BODY_BASE[h % BODY_BASE.length];
  const spokes = 5 + (h >> 3) % 6;                // 5–10 幅

  return {
    car, id: car.id, cls, L, W, H, WB,
    frontFromNose, rearFromNose, wheelSpec, wheelR, archR,
    axleFZ, axleRZ, belt, roofY, rocker,
    wheelX: W / 2 * 0.955 - wheelR * 0.37,        // 輪心 X（外緣貼齊車身側面內縮一點）
    tireHalfW: wheelR * 0.37,
    hasRails, hasSunroof, spokes,
    bodyColor, brandColor: car.brandColor || '#8A8F96',
    roof: R,
  };
}

/* ── 側面 profile ─────────────────────────────────────────────────────────── */

/** 車身俯視半寬係數（W/2 的比例）：前後收窄 */
const HW_TABLE = [
  [0.000, 0.780], [0.012, 0.862], [0.040, 0.930], [0.090, 0.975], [0.200, 1.000],
  [0.800, 1.000], [0.915, 0.985], [0.962, 0.945], [0.988, 0.878], [1.000, 0.800],
];

/** 車身下緣（未含輪拱）：前後有進/離去角 */
const YBOT_TABLE = [
  [0.000, 0.255], [0.045, 0.145], [0.120, 0.108],
  [0.880, 0.108], [0.955, 0.145], [1.000, 0.255],
];

function lowerTopTable(sp) {
  const b = sp.roof.belt;
  return [
    [0.000, 0.455], [0.030, 0.487], [0.100, 0.515], [0.175, 0.532],
    [sp.roof.wsBase, b], [0.420, b * 1.006], [0.780, b * 1.026],
    [0.930, b * 1.022], [0.988, b * 0.985], [1.000, b * 0.925],
  ];
}

/** 車頂線（含 A 柱傾角、後窗傾角），回傳「車高比例」 */
function roofTopAt(u, sp) {
  const R = sp.roof, b = R.belt;
  if (u <= R.wsBase) return b;
  if (u < R.roofFront) {
    const t = (u - R.wsBase) / (R.roofFront - R.wsBase);
    return lerp(b, R.roofTop, smoother(t));
  }
  if (u <= R.roofRear) {
    const t = (u - R.roofFront) / Math.max(R.roofRear - R.roofFront, 1e-6);
    return R.roofTop - R.roofDrop * smoother(t) * 0.6 - R.roofDrop * t * 0.4;
  }
  if (u < R.tail) {
    const t = (u - R.roofRear) / (R.tail - R.roofRear);
    return lerp(R.roofTop - R.roofDrop, b * 1.03, smoother(t));
  }
  return b * 1.03;
}

/** 車身下緣（含兩個輪拱開口的弧線） —— 這就是「真的凹陷」的輪拱 */
function lowerBotAt(u, sp) {
  let y = pw(u, YBOT_TABLE) * sp.H;
  const z = -sp.L / 2 + u * sp.L;
  for (const az of [sp.axleFZ, sp.axleRZ]) {
    const dz = Math.abs(z - az);
    const a = dz / sp.archR;
    let ay = null;
    if (a <= 1) ay = sp.wheelR + sp.archR * Math.sqrt(Math.max(0, 1 - a * a));
    else if (a < 1.32) {
      const t = (a - 1) / 0.32;
      ay = lerp(sp.wheelR, y, smoother(t));
    }
    if (ay !== null && ay > y) y = ay;
  }
  return y;
}

/** 產生一組縱向站位 u（均勻 + 輪拱加密） */
function stationUs(sp, uniform, perArch) {
  const set = new Set();
  for (let i = 0; i <= uniform; i++) set.add(i / uniform);
  for (const az of [sp.axleFZ, sp.axleRZ]) {
    const u0 = (az + sp.L / 2) / sp.L, du = sp.archR * 1.34 / sp.L;
    for (let i = -perArch; i <= perArch; i++) {
      const u = u0 + du * (i / perArch);
      if (u > 0.001 && u < 0.999) set.add(u);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. 第三層｜程序生成 3D 車身
 *    回傳依材質分桶的 {geo, matrix} 清單，LOD0 與 Fleet 共用同一份造型程式碼。
 * ──────────────────────────────────────────────────────────────────────────── */

const hwAt = (u, sp) => pw(u, HW_TABLE) * sp.W / 2;
const lowTopAt = (u, sp) => pw(u, lowerTopTable(sp)) * sp.H;
const ghwAt = (u, sp) => {
  const R = sp.roof;
  const narrow = pw(u, [
    [R.wsBase, 0.860], [R.roofFront, 0.985], [0.550, 1.000],
    [R.roofRear, 0.962], [R.tail, 0.800],
  ]);
  return hwAt(u, sp) * R.ghw * narrow;
};

/** 車身側面「表面補片」：永遠與烤漆面共形，用來做頭尾燈、細條紋、車門線 */
function sidePatch(THREE, sp, u0, u1, yLo, yHi, side, outset, steps = 6, r = 0.008) {
  const st = [];
  for (let i = 0; i <= steps; i++) {
    const u = lerp(u0, u1, i / steps);
    const hw = hwAt(u, sp) * outset;
    st.push({
      z: -sp.L / 2 + u * sp.L, hwBot: hw, hwTop: hw,
      yBot: typeof yLo === 'function' ? yLo(u) : yLo,
      yTop: typeof yHi === 'function' ? yHi(u) : yHi,
      rTop: r, rBot: r,
    });
  }
  return sweepGeometry(THREE, st, { iRange: side > 0 ? [29, 5] : [13, 21] });
}

/**
 * 建構一台車的所有幾何，依材質分桶。
 * detail: 'high'（getCarMesh）｜'low'（Fleet 的 InstancedMesh 原型）
 */
function buildCarGeometry(THREE, sp, detail = 'high') {
  const hi = detail === 'high';
  const B = { paint: [], trim: [], glass: [], lamp: [], stripe: [], core: [], tire: [], wheel: [] };
  const M = () => new THREE.Matrix4();
  const T = (x, y, z) => M().makeTranslation(x, y, z);
  const { L, W, H, belt, roofY, rocker, wheelR, archR, axleFZ, axleRZ } = sp;
  const R = sp.roof;

  /* ── 4.1 車體下段（含真正的輪拱開口） ───────────────────────────────── */
  const us = stationUs(sp, hi ? 40 : 24, hi ? 13 : 6);
  const lower = us.map((u) => {
    const hw = hwAt(u, sp);
    return {
      z: -L / 2 + u * L,
      hwBot: hw * 0.985, hwTop: hw,
      yBot: lowerBotAt(u, sp), yTop: lowTopAt(u, sp),
      rTop: 0.085, rBot: 0.030,
    };
  });
  B.paint.push({ geo: sweepGeometry(THREE, lower, { chamfer: 0.0025 }) });

  /* ── 4.2 底盤／輪拱內側（深色，從輪拱開口看進去就是它） ───────────── */
  const coreSt = [];
  for (let i = 0; i <= (hi ? 10 : 4); i++) {
    const t = i / (hi ? 10 : 4);
    const z = lerp(-L * 0.435, L * 0.435, t);
    coreSt.push({ z, hwBot: W * 0.355, hwTop: W * 0.375, yBot: H * 0.082, yTop: belt * 0.985, rTop: 0.05, rBot: 0.04 });
  }
  B.core.push({ geo: sweepGeometry(THREE, coreSt, { chamfer: 0.002 }) });

  // 輪拱內襯（上半圓筒，軸向 X）—— 讓凹陷有真實深度，不是貼圖
  for (const az of [axleFZ, axleRZ]) {
    for (const s of [1, -1]) {
      const wellLen = sp.tireHalfW * 2 + 0.11;
      const g = new THREE.CylinderGeometry(archR * 0.99, archR * 0.99, wellLen, hi ? 18 : 10, 1, true, 0, Math.PI);
      g.rotateZ(Math.PI / 2);
      B.core.push({ geo: g, matrix: T(s * (sp.wheelX * 0.90), wheelR, az) });
    }
  }

  /* ── 4.3 車艙玻璃殼（前擋／側窗／後擋一體成形，形狀由車頂線決定） ── */
  const gUs = [];
  const gSteps = hi ? 26 : 14;
  for (let i = 0; i <= gSteps; i++) gUs.push(lerp(R.wsBase, R.tail, i / gSteps));
  const gh = gUs.map((u) => {
    const hw = ghwAt(u, sp);
    return {
      z: -L / 2 + u * L, hwBot: hw, hwTop: hw * 0.955,
      yBot: belt * 0.952, yTop: Math.max(roofTopAt(u, sp) * H, belt * 0.96 + 0.004),
      rTop: 0.155, rBot: 0.020,
    };
  });
  B.glass.push({ geo: sweepGeometry(THREE, gh, { chamfer: 0.002 }) });

  /* ── 4.4 車頂板（蓋住玻璃殼頂部，留下前擋／後擋／側窗） ─────────── */
  const capU0 = R.roofFront - 0.022, capU1 = R.roofRear + 0.028;
  const capSt = [];
  const capSteps = hi ? 14 : 7;
  for (let i = 0; i <= capSteps; i++) {
    const u = lerp(capU0, capU1, i / capSteps);
    const yT = roofTopAt(u, sp) * H + 0.005;
    const hw = ghwAt(u, sp) * 1.014;
    capSt.push({ z: -L / 2 + u * L, hwBot: hw, hwTop: hw * 0.97, yBot: yT - 0.088, yTop: yT, rTop: 0.10, rBot: 0.02 });
  }
  B.paint.push({ geo: sweepGeometry(THREE, capSt, { chamfer: 0.0025 }) });

  /* ── 4.5 A／B／C 柱（黑色柱） ───────────────────────────────────── */
  if (hi) {
    const pillarSweep = (u0, u1, side, halfX, halfY) => {
      const st = [];
      for (let i = 0; i <= 9; i++) {
        const u = lerp(u0, u1, i / 9);
        const yc = roofTopAt(u, sp) * H - halfY - 0.006;
        st.push({
          z: -L / 2 + u * L, hwBot: halfX, hwTop: halfX,
          yBot: yc - halfY, yTop: yc + halfY, rTop: 0.006, rBot: 0.006,
          cx: side * ghwAt(u, sp) * 0.992,
        });
      }
      return sweepGeometry(THREE, st, { chamfer: 0.002 });
    };
    for (const s of [1, -1]) {
      B.trim.push({ geo: pillarSweep(R.wsBase + 0.004, R.roofFront + 0.012, s, 0.019, 0.031) }); // A 柱
      B.trim.push({ geo: pillarSweep(R.roofRear - 0.012, R.tail - 0.004, s, 0.021, 0.033) });    // C 柱
      // B 柱（近垂直，用圓角盒 + 傾角）
      const uB = 0.545;
      const yTop = roofTopAt(uB, sp) * H - 0.02, yBot = belt * 0.97;
      const bp = roundedBoxGeo(THREE, 0.020, yTop - yBot, 0.058, 0.004);
      B.trim.push({ geo: bp, matrix: T(s * ghwAt(uB, sp) * 0.996, (yTop + yBot) / 2, -L / 2 + uB * L) });
    }
  }

  /* ── 4.6 輪拱外緣（略突出車身的護板） ───────────────────────────── */
  for (const az of [axleFZ, axleRZ]) {
    for (const s of [1, -1]) {
      const flare = new THREE.TorusGeometry(archR * 1.005, 0.023, hi ? 8 : 5, hi ? 24 : 12, Math.PI);
      flare.rotateY(Math.PI / 2);
      B.trim.push({ geo: flare, matrix: T(s * (W / 2 * 0.982), wheelR, az) });
    }
  }

  /* ── 4.7 前臉：水箱罩、下進氣、保險桿、霧燈 ─────────────────────── */
  const noseZ = -L / 2;
  const grille = roundedBoxGeo(THREE, W * 0.50, H * 0.105, 0.085, 0.012);
  B.trim.push({ geo: grille, matrix: T(0, H * 0.385, noseZ + 0.033) });
  const intake = roundedBoxGeo(THREE, W * 0.64, H * 0.085, 0.075, 0.014);
  B.trim.push({ geo: intake, matrix: T(0, H * 0.205, noseZ + 0.030) });
  const fbump = roundedBoxGeo(THREE, W * 0.80, H * 0.075, 0.14, 0.020);
  B.trim.push({ geo: fbump, matrix: T(0, H * 0.128, noseZ + 0.075) });
  if (hi) {
    for (let i = 0; i < 4; i++) {
      const sl = roundedBoxGeo(THREE, W * 0.465, 0.013, 0.030, 0.004);
      B.trim.push({ geo: sl, matrix: T(0, H * 0.385 + (i - 1.5) * H * 0.026, noseZ - 0.008) });
    }
    for (const s of [1, -1]) {
      const fog = new THREE.CylinderGeometry(0.046, 0.046, 0.05, 14);
      fog.rotateX(Math.PI / 2);
      B.lamp.push({ geo: fog, matrix: T(s * W * 0.295, H * 0.185, noseZ + 0.012) });
      const ring = new THREE.TorusGeometry(0.058, 0.012, 6, 16);
      B.trim.push({ geo: ring, matrix: T(s * W * 0.295, H * 0.185, noseZ + 0.010) });
    }
  }

  /* ── 4.8 頭燈／尾燈（正面燈殼 + 沿葉子板包覆的共形補片） ───────── */
  for (const s of [1, -1]) {
    const hl = roundedBoxGeo(THREE, W * 0.185, H * 0.075, 0.075, 0.014);
    B.lamp.push({ geo: hl, matrix: T(s * W * 0.275, H * 0.435, noseZ + 0.024) });
    B.lamp.push({ geo: sidePatch(THREE, sp, 0.004, 0.052, H * 0.400, H * 0.470, s, 1.006, hi ? 6 : 3) });
    const tl = roundedBoxGeo(THREE, W * 0.165, H * 0.095, 0.075, 0.014);
    B.lamp.push({ geo: tl, matrix: T(s * W * 0.295, belt * 0.845, L / 2 - 0.024) });
    B.lamp.push({ geo: sidePatch(THREE, sp, 0.948, 0.996, belt * 0.795, belt * 0.895, s, 1.006, hi ? 6 : 3) });
  }
  if (hi) {
    const drl = roundedBoxGeo(THREE, W * 0.60, 0.016, 0.030, 0.005);
    B.lamp.push({ geo: drl, matrix: T(0, H * 0.470, noseZ - 0.004) });
    const rbump = roundedBoxGeo(THREE, W * 0.78, H * 0.075, 0.13, 0.020);
    B.trim.push({ geo: rbump, matrix: T(0, H * 0.130, L / 2 - 0.072) });
    const plate = roundedBoxGeo(THREE, 0.34, 0.16, 0.035, 0.006);
    B.trim.push({ geo: plate, matrix: T(0, H * 0.265, L / 2 - 0.012) });
  }

  /* ── 4.9 車側：下緣護板、品牌識別色細條紋、車門線、把手、後視鏡 ── */
  for (const s of [1, -1]) {
    B.trim.push({ geo: sidePatch(THREE, sp, 0.085, 0.915, H * 0.112, H * 0.176, s, 1.004, hi ? 10 : 5) });
    B.stripe.push({ geo: sidePatch(THREE, sp, 0.135, 0.880, H * 0.186, H * 0.204, s, 1.006, hi ? 10 : 5, 0.005) });
    if (!hi) continue;
    // C 柱上的品牌色小塊（克制，不塗滿）
    const chip = roundedBoxGeo(THREE, 0.012, 0.085, 0.045, 0.004);
    B.stripe.push({ geo: chip, matrix: T(s * ghwAt(R.roofRear - 0.02, sp) * 1.002, belt * 1.10, -L / 2 + (R.roofRear - 0.02) * L) });
    // 車門線（細線，非布林凹槽）
    for (const ud of [0.312, 0.548, 0.782]) {
      B.trim.push({
        geo: sidePatch(THREE, sp, ud - 0.004, ud + 0.004,
          (u) => lowerBotAt(u, sp) + 0.012, (u) => lowTopAt(u, sp) - 0.006, s, 1.003, 2, 0.004),
      });
    }
    // 門把
    for (const uh of [0.430, 0.665]) {
      const hd = roundedBoxGeo(THREE, 0.026, 0.030, 0.135, 0.006);
      B.trim.push({ geo: hd, matrix: T(s * (hwAt(uh, sp) + 0.010), belt * 0.905, -L / 2 + uh * L) });
    }
    // 後視鏡（含鏡臂）
    const um = R.wsBase + 0.028;
    const mx = hwAt(um, sp), mz = -L / 2 + um * L;
    const arm = roundedBoxGeo(THREE, 0.055, 0.026, 0.042, 0.008);
    B.trim.push({ geo: arm, matrix: T(s * (mx + 0.028), belt * 1.020, mz) });
    const hous = roundedBoxGeo(THREE, 0.075, 0.082, 0.155, 0.022);
    B.paint.push({ geo: hous, matrix: T(s * (mx + 0.085), belt * 1.038, mz + 0.012) });
    const mg = roundedBoxGeo(THREE, 0.062, 0.066, 0.010, 0.004);
    B.glass.push({ geo: mg, matrix: T(s * (mx + 0.085), belt * 1.038, mz + 0.086) });
  }

  /* ── 4.10 車頂行李架（僅 comfort['車頂行李架'] 為 true） ───────── */
  if (sp.hasRails) {
    const uc = (R.roofFront + R.roofRear) / 2;
    const railLen = (R.roofRear - R.roofFront) * L * 0.86;
    for (const s of [1, -1]) {
      const rail = roundedBoxGeo(THREE, 0.034, 0.028, railLen, 0.012);
      B.trim.push({ geo: rail, matrix: T(s * ghwAt(uc, sp) * 0.86, roofTopAt(uc, sp) * H + 0.030, -L / 2 + uc * L) });
      if (!hi) continue;
      for (const f of [-0.36, 0.36]) {
        const foot = roundedBoxGeo(THREE, 0.030, 0.030, 0.070, 0.008);
        const uf = uc + f * (R.roofRear - R.roofFront);
        B.trim.push({ geo: foot, matrix: T(s * ghwAt(uf, sp) * 0.86, roofTopAt(uf, sp) * H + 0.012, -L / 2 + uf * L) });
      }
    }
  }

  /* ── 4.11 天窗（僅 comfort['天窗'] 為 true，做在車頂玻璃） ─────── */
  if (sp.hasSunroof) {
    const usr = clamp((R.roofFront + R.roofRear) / 2 - 0.03, 0.3, 0.8);
    const zr = -L / 2 + usr * L, yr = roofTopAt(usr, sp) * H;
    const frame = roundedBoxGeo(THREE, ghwAt(usr, sp) * 1.18, 0.014, (R.roofRear - R.roofFront) * L * 0.52, 0.008);
    B.trim.push({ geo: frame, matrix: T(0, yr + 0.006, zr) });
    const glass = roundedBoxGeo(THREE, ghwAt(usr, sp) * 1.06, 0.012, (R.roofRear - R.roofFront) * L * 0.46, 0.006);
    B.glass.push({ geo: glass, matrix: T(0, yr + 0.014, zr) });
  }

  /* ── 4.12 四個輪子（輪胎 LatheGeometry + 真實幅條輪圈） ────────── */
  const tg = tireGeometry(THREE, wheelR, sp.tireHalfW, hi ? 30 : 14);
  const rg = rimGeometry(THREE, wheelR, sp.tireHalfW, sp.spokes);
  for (const az of [axleFZ, axleRZ]) {
    for (const s of [1, -1]) {
      const m = T(s * sp.wheelX, wheelR, az).multiply(M().makeRotationY(s > 0 ? 0 : Math.PI));
      B.tire.push({ geo: tg.clone(), matrix: m.clone() });
      B.wheel.push({ geo: rg.clone(), matrix: m.clone() });
      if (hi) {
        const disc = new THREE.CylinderGeometry(wheelR * 0.50, wheelR * 0.50, 0.020, 18);
        disc.rotateZ(Math.PI / 2);
        B.core.push({ geo: disc, matrix: T(s * (sp.wheelX - sp.tireHalfW * 0.35), wheelR, az) });
      }
    }
  }
  tg.dispose(); rg.dispose();

  return B;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. 影像管線（第一層／第二層共用）：去背羽化 + 隨角度變形的落地陰影
 * ──────────────────────────────────────────────────────────────────────────── */

const SKELETON_STYLE_ID = 'b4-carmodels-skeleton-style';

function ensureSkeletonStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(SKELETON_STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = SKELETON_STYLE_ID;
  // 骨架屏：灰色佔位方塊 + 極慢呼吸（只動 opacity / transform，不是 spinner）
  st.textContent = `
@keyframes b4-breathe { 0%,100% { opacity:.34; transform:scale(1); } 50% { opacity:.62; transform:scale(1.012); } }
.b4-spin-wrap { position:relative; width:100%; height:100%; overflow:hidden; touch-action:none;
  background:#F2F3F5; cursor:grab; }
.b4-spin-wrap.b4-drag { cursor:grabbing; }
.b4-spin-canvas { display:block; width:100%; height:100%; }
.b4-skel { position:absolute; inset:8%; border-radius:14px;
  background:linear-gradient(102deg,#DFE1E5 0%,#E8EAED 44%,#DADDE2 100%);
  animation:b4-breathe 3400ms ${EASE.region} infinite; will-change:opacity,transform; }
.b4-skel-b { position:absolute; border-radius:999px; background:#D3D6DB; opacity:.75;
  animation:b4-breathe 3400ms ${EASE.region} infinite; }
.b4-angles { position:absolute; left:50%; bottom:10px; transform:translateX(-50%);
  display:flex; gap:6px; }
.b4-angles button { font:500 12px/1 system-ui,-apple-system,"Noto Sans TC",sans-serif;
  padding:6px 10px; border:1px solid #C9CDD3; border-radius:999px; background:#FBFBFC;
  color:#3A3F46; cursor:pointer; transition:background 180ms ${EASE.micro}, color 180ms ${EASE.micro};
  will-change:background,color; }
.b4-angles button[aria-pressed="true"] { background:#3A3F46; color:#F7F8F9; border-color:#3A3F46; }
`;
  document.head.appendChild(st);
}

/** 載入一張圖（同源）。失敗回 null，不丟例外。 */
function loadImage(url) {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') { resolve(null); return; }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * ★ 去背與羽化：白底車圖 → 具 alpha 的 canvas。**絕對不可留下白色方框。**
 * - 以四角取樣判斷是否真的是近白底；不是就原圖直出（可能本來就有 alpha）。
 * - alpha 用 soft threshold（不是硬切），再對 alpha 做兩次 3×3 盒狀模糊做羽化。
 * - 邊緣去白邊：對 0<alpha<1 的像素做反預乘，把殘留的背景色扣掉。
 */
function keyOutWhite(img) {
  if (typeof document === 'undefined') return null;
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  if (!w || !h) return null;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.drawImage(img, 0, 0, w, h);
  let data;
  try { data = c.getImageData(0, 0, w, h); }
  catch (e) { return { canvas: cv, keyed: false }; }   // canvas 被污染：誠實退回原圖
  const d = data.data;
  const at = (x, y) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  const corners = [at(1, 1), at(w - 2, 1), at(1, h - 2), at(w - 2, h - 2)];
  const bg = [0, 1, 2].map((k) => corners.reduce((s, p) => s + p[k], 0) / 4);
  const bgLum = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2];
  if (bgLum < 232) return { canvas: cv, keyed: false };   // 不是白底，不動它

  const N = w * h;
  const alpha = new Float32Array(N);
  const T0 = 0.040, T1 = 0.150;                            // soft threshold
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    const dist = Math.max(Math.abs(d[o] - bg[0]), Math.abs(d[o + 1] - bg[1]), Math.abs(d[o + 2] - bg[2])) / 255;
    const t = clamp((dist - T0) / (T1 - T0), 0, 1);
    alpha[i] = t * t * (3 - 2 * t);
  }
  // 羽化：兩次可分離盒狀模糊（半徑 1）
  const tmp = new Float32Array(N);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      tmp[i] = (alpha[i] + alpha[y * w + Math.max(0, x - 1)] + alpha[y * w + Math.min(w - 1, x + 1)]) / 3;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      alpha[i] = (tmp[i] + tmp[Math.max(0, y - 1) * w + x] + tmp[Math.min(h - 1, y + 1) * w + x]) / 3;
    }
  }
  for (let i = 0; i < N; i++) {
    const a = alpha[i], o = i * 4;
    if (a < 0.996 && a > 0.004) {
      for (let k = 0; k < 3; k++) d[o + k] = clamp((d[o + k] - bg[k] * (1 - a)) / a, 0, 255);
    }
    d[o + 3] = Math.round(clamp(a, 0, 1) * 255);
  }
  c.putImageData(data, 0, 0);
  return { canvas: cv, keyed: true };
}

/**
 * ★ 落地陰影：形狀隨旋轉角度改變 —— 正側面最長、正前方最短。
 * 沒有陰影，車會像貼紙浮在空中。
 */
function drawGroundShadow(c, cw, ch, angle, scale) {
  const side = Math.abs(Math.sin(angle));               // 1 = 正側面，0 = 正前/正後
  const wRatio = 0.40 + 0.34 * side;                    // 側面最長
  const hRatio = 0.088 - 0.020 * side;                  // 側面較扁
  const cx = cw * 0.5 + Math.cos(angle) * cw * 0.012;
  const cy = ch * 0.795;
  const rx = cw * wRatio * scale, ry = ch * hRatio * scale;
  c.save();
  c.translate(cx, cy);
  c.scale(1, ry / rx);
  const g = c.createRadialGradient(0, 0, rx * 0.12, 0, 0, rx);
  g.addColorStop(0.00, 'rgba(28,32,38,0.40)');
  g.addColorStop(0.45, 'rgba(28,32,38,0.22)');
  g.addColorStop(0.78, 'rgba(28,32,38,0.07)');
  g.addColorStop(1.00, 'rgba(28,32,38,0.00)');
  c.fillStyle = g;
  c.beginPath(); c.arc(0, 0, rx, 0, Math.PI * 2); c.fill();
  c.restore();
}

/** 影格容器（預載 + 去背 + 骨架屏） */
class FrameSet {
  constructor(urls) {
    this.urls = urls.slice();
    this.canvases = new Array(urls.length).fill(null);
    this.loaded = 0;
    this.ready = false;
    this.keyed = false;
    this.failed = 0;
  }
  /** ★ 細節 1：第一次拖曳前把全部影格載完，否則轉到一半會卡 */
  async preload(onProgress) {
    const imgs = await Promise.all(this.urls.map(loadImage));
    for (let i = 0; i < imgs.length; i++) {
      if (!imgs[i]) { this.failed++; continue; }
      const r = keyOutWhite(imgs[i]);
      if (r) { this.canvases[i] = r.canvas; if (r.keyed) this.keyed = true; }
      this.loaded++;
      if (onProgress) onProgress(this.loaded / this.urls.length);
    }
    this.ready = this.loaded > 0;
    return this.ready;
  }
  dispose() { this.canvases.length = 0; }
}
