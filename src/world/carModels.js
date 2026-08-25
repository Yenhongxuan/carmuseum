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
  const chamfer = opts.chamfer === undefined ? 0.0025 : opts.chamfer;
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

  const pos = [], uv = [], idx = [];
  // 側面
  for (let s = 0; s < S; s++) {
    const r = rings[s], z = stations[s].z;
    let acc = 0;
    for (let i = 0; i < N; i++) {
      pos.push(r[i * 2], r[i * 2 + 1], z);
      uv.push(acc, z);
      const j = (i + 1) % N;
      acc += Math.hypot(r[j * 2] - r[i * 2], r[j * 2 + 1] - r[i * 2 + 1]);
    }
  }
  for (let s = 0; s < S - 1; s++) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const a = s * N + i, b = s * N + j, c = (s + 1) * N + j, d = (s + 1) * N + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  // 端蓋（各自複製一份頂點，端面才會是硬邊 + 前面的 chamfer 圈提供倒角高光）
  const addCap = (sIndex, front) => {
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
  [0.000, 0.42], [0.012, 0.70], [0.035, 0.88], [0.090, 0.965], [0.200, 1.00],
  [0.800, 1.00], [0.915, 0.975], [0.962, 0.90], [0.988, 0.70], [1.000, 0.44],
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
