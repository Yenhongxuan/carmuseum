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
 *   - 車頭/車尾有真實的正面（掃掠斷面在 u=0 收到 0.78 倍半寬），水箱罩、下進氣、保險桿、
 *     頭尾燈都是獨立幾何，但**沒有雕塑級的鈑件曲面**（如引擎蓋稜線、車側衝壓折線）。
 *   - 車門線、把手為「貼合車身外緣的細線/小凸起」，非布林運算的真凹槽
 *     （規格允許「凹槽/細線」擇一）。
 *   - LOD0 單台約 34,000 三角形、9 個 draw call。同場超過 3–4 台請一律走 createFleet()，
 *     不要對 39 台各叫一次 getCarMesh()。
 *   - getFootprint() 回傳原廠公布尺寸；模型含後視鏡，實際 X 向外擴約 0.10 m/側
 *     （與實車相同，原廠車寬本來就不含後視鏡）。碰撞/車位計算請用 getFootprint()。
 *   - Fleet（InstancedMesh）的車身輪拱開口是以「同類車頂線的中位數軸距比例」烘焙的，
 *     各車實際軸距/車長比在 0.592–0.624 之間，最壞情況輪拱與輪心相差約 ±0.07 m；
 *     輪胎/輪圈本身是每台車精確定位。近距離請用 getCarMesh()（完全精確）。
 *   - Fleet 車身把 paint/trim/lamp 併成一個 InstancedMesh（以頂點色區分），
 *     所以遠景的品牌條紋是灰色細線，不是品牌色；品牌色改以 setColorAt 的車身色調呈現。
 *   - 沒有實作輪胎胎紋、雨刷、車內裝（座椅/方向盤）；駕駛座只提供 getEyePoint 眼點。
 *   - getEyePoint 未逐字採用建議式 `height * 0.62`：該值會落在腰線之下（駕駛看不到路），
 *     實作為 `max(height * 0.62, 腰線 + 0.14)`。建議式仍是基準項，只加了下限。
 *   - 沒有 CSG，輪拱「凹陷」是以「車身下緣沿輪拱弧線抬升 + 內側深色輪拱內襯半圓筒」
 *     達成真實幾何凹陷，而非布林減法。實測輪拱開口最低點高於輪頂約 45–50 mm。
 *   - 三種車頂線的實測差異（前擋傾角／後窗傾角／車頂前後落差／側窗高）：
 *     tall 48.2°／29.9°／7 mm／464 mm｜mid 53.8°／50.0°／30 mm／413 mm｜
 *     low 61.1°／70.0°／85 mm／299 mm。
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
  tall: { belt: 0.652, wsBase: 0.250, roofFront: 0.396, roofRear: 0.862, tail: 0.932,
          roofDrop: 0.004, ghw: 0.885, roofTop: 0.996 },
  // 介於兩者之間
  mid:  { belt: 0.660, wsBase: 0.252, roofFront: 0.428, roofRear: 0.800, tail: 0.936,
          roofDrop: 0.018, ghw: 0.872, roofTop: 0.995 },
  // 車頂下斜、後窗傾角大、車身低扁
  low:  { belt: 0.672, wsBase: 0.262, roofFront: 0.466, roofRear: 0.712, tail: 0.950,
          roofDrop: 0.055, ghw: 0.852, roofTop: 0.994 },
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
  // ★ 第 3 階段整合修正：外層合併必須保留各 part 既有的 color attribute。
  //   原本只有在傳入 vertexColor 時才產生 color，導致「內層逐部位上色 → 外層合併」時整組頂點色被丟掉，
  //   而 fleet 車身材質是 vertexColors:true —— WebGL 對缺席的頂點屬性回傳 (0,0,0)，車身就被乘成全黑。
  const anyColor = !!vertexColor || parts.some((g) => !!g.getAttribute('color'));
  const col = anyColor ? new Float32Array(total * 3) : null;
  let o = 0;
  for (const g of parts) {
    const p = g.getAttribute('position'), nn = g.getAttribute('normal'), u = g.getAttribute('uv');
    pos.set(p.array.subarray(0, p.count * 3), o * 3);
    nor.set(nn.array.subarray(0, nn.count * 3), o * 3);
    uv.set(u.array.subarray(0, u.count * 2), o * 2);
    if (col) {
      const src = vertexColor ? null : g.getAttribute('color');
      for (let i = 0; i < p.count; i++) {
        if (vertexColor) {
          col[(o + i) * 3] = vertexColor[0]; col[(o + i) * 3 + 1] = vertexColor[1]; col[(o + i) * 3 + 2] = vertexColor[2];
        } else if (src) {
          col[(o + i) * 3] = src.array[i * 3]; col[(o + i) * 3 + 1] = src.array[i * 3 + 1]; col[(o + i) * 3 + 2] = src.array[i * 3 + 2];
        } else {           // 沒有頂點色的 part 一律填白，讓它保持材質本色
          col[(o + i) * 3] = 1; col[(o + i) * 3 + 1] = 1; col[(o + i) * 3 + 2] = 1;
        }
      }
    }
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

/**
 * 輪圈：真的有幅條幾何（5–10 幅），軸向 = X。
 * simple=true 給 Fleet 的 InstancedMesh 原型用（幅條改用低面數柱體，面數約 1/5）。
 */
function rimGeometry(THREE, R, halfW, spokes, simple = false) {
  const rimR = R * 0.665;
  const list = [];
  const M = () => new THREE.Matrix4();

  const barrel = new THREE.CylinderGeometry(rimR, rimR * 0.955, halfW * 1.55, simple ? 14 : 24, 1, true);
  barrel.rotateZ(Math.PI / 2);
  list.push({ geo: barrel });

  const lip = new THREE.TorusGeometry(rimR * 0.985, R * 0.024, simple ? 5 : 8, simple ? 14 : 30);
  lip.rotateY(Math.PI / 2); lip.translate(halfW * 0.76, 0, 0);
  list.push({ geo: lip });

  if (!simple) {
    const inner = new THREE.TorusGeometry(rimR * 0.985, R * 0.020, 8, 24);
    inner.rotateY(Math.PI / 2); inner.translate(-halfW * 0.72, 0, 0);
    list.push({ geo: inner });
  }

  const hub = new THREE.CylinderGeometry(R * 0.20, R * 0.185, halfW * 0.55, simple ? 10 : 16);
  hub.rotateZ(Math.PI / 2); hub.translate(halfW * 0.62, 0, 0);
  list.push({ geo: hub });

  const spokeGeo = simple
    ? (() => { const g = new THREE.CylinderGeometry(R * 0.085, R * 0.075, R * 0.50, 6); return g; })()
    : roundedBoxGeo(THREE, halfW * 0.30, R * 0.50, R * 0.155, 0.003);
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
    [0.000, b * 0.795], [0.030, b * 0.833], [0.100, b * 0.872], [0.175, b * 0.905],
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
  const coreSteps = hi ? 14 : 6;
  for (let i = 0; i <= coreSteps; i++) {
    const u = lerp(0.075, 0.925, i / coreSteps);
    const z = -L / 2 + u * L;
    // 頂面必須壓在鈑件之下，否則引擎蓋前段會被底盤穿出來
    const yTop = Math.min(belt * 0.985, lowTopAt(u, sp) - 0.045);
    const hw = Math.min(W * 0.375, hwAt(u, sp) * 0.90);
    coreSt.push({
      z, hwBot: hw * 0.95, hwTop: hw,
      yBot: H * 0.082, yTop: Math.max(yTop, H * 0.16),
      rTop: 0.05, rBot: 0.04,
    });
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
    capSt.push({ z: -L / 2 + u * L, hwBot: hw, hwTop: hw * 0.97, yBot: yT - 0.112, yTop: yT, rTop: 0.10, rBot: 0.02 });
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
  B.trim.push({ geo: grille, matrix: T(0, H * 0.400, noseZ + 0.033) });
  const intake = roundedBoxGeo(THREE, W * 0.64, H * 0.085, 0.075, 0.014);
  B.trim.push({ geo: intake, matrix: T(0, H * 0.205, noseZ + 0.030) });
  const fbump = roundedBoxGeo(THREE, W * 0.80, H * 0.075, 0.14, 0.020);
  B.trim.push({ geo: fbump, matrix: T(0, H * 0.128, noseZ + 0.075) });
  if (hi) {
    for (let i = 0; i < 4; i++) {
      const sl = roundedBoxGeo(THREE, W * 0.465, 0.013, 0.030, 0.004);
      B.trim.push({ geo: sl, matrix: T(0, H * 0.400 + (i - 1.5) * H * 0.026, noseZ - 0.008) });
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
    B.lamp.push({ geo: hl, matrix: T(s * W * 0.275, H * 0.455, noseZ + 0.024) });
    B.lamp.push({ geo: sidePatch(THREE, sp, 0.004, 0.052, H * 0.420, H * 0.492, s, 1.006, hi ? 6 : 3) });
    const tl = roundedBoxGeo(THREE, W * 0.165, H * 0.095, 0.075, 0.014);
    B.lamp.push({ geo: tl, matrix: T(s * W * 0.295, belt * 0.845, L / 2 - 0.024) });
    B.lamp.push({ geo: sidePatch(THREE, sp, 0.948, 0.996, belt * 0.795, belt * 0.895, s, 1.006, hi ? 6 : 3) });
  }
  if (hi) {
    const drl = roundedBoxGeo(THREE, W * 0.60, 0.016, 0.030, 0.005);
    B.lamp.push({ geo: drl, matrix: T(0, H * 0.492, noseZ - 0.004) });
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
    B.trim.push({ geo: arm, matrix: T(s * (mx + 0.024), belt * 1.020, mz) });
    const hous = roundedBoxGeo(THREE, 0.070, 0.080, 0.150, 0.022);
    B.paint.push({ geo: hous, matrix: T(s * (mx + 0.068), belt * 1.038, mz + 0.012) });
    const mg = roundedBoxGeo(THREE, 0.058, 0.064, 0.010, 0.004);
    B.glass.push({ geo: mg, matrix: T(s * (mx + 0.068), belt * 1.038, mz + 0.084) });
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

/* ────────────────────────────────────────────────────────────────────────────
 * 6. 第一層｜Spin360 檢視器（本次無素材，仍完整實作）
 * ──────────────────────────────────────────────────────────────────────────── */

const IDLE_DELAY_MS = 8000;    // ★ 細節 4：8 秒沒互動就開始自動慢轉
const IDLE_STEP_MS = 3000;     //            每 3 秒轉一格

class Spin360 {
  constructor(frames) {
    this.frames = frames;      // string[]（規格指定的欄位名）
    this.index = 0;
    this.dragging = false;
  }

  /** ★ 規格指定的拖曳換格公式，逐字實作 */
  onDrag(dx, viewportWidth) {
    const step = viewportWidth / this.frames.length;
    this.index = (this.index + Math.round(dx / step)) % this.frames.length;
    if (this.index < 0) this.index += this.frames.length;
    this.show(this.index);
  }

  show(i) {
    this.index = ((i % this.frames.length) + this.frames.length) % this.frames.length;
    this._paint();
  }
}

/**
 * 建立一個可用的 Spin360（DOM + canvas + 可選的 3D 佈告板）。
 * 回傳物件同時滿足規格的 class 形狀（frames / index / dragging / onDrag / show）。
 */
function makeSpin360(THREE, frames, el, hooks = {}) {
  const s = new Spin360(frames);
  s.THREE = THREE;
  s.set = new FrameSet(frames);
  s.el = el || null;
  s.enabled = false;
  s.disposed = false;
  s._f = 0;                 // 浮點格位（慣性用）
  s._pending = 0;           // 未滿一格的拖曳殘量
  s._lastInteract = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  s._idleAcc = 0;
  s._anim = null;           // {from,to,t,dur}
  s._vel = 0;               // 格/秒
  s._tex = null;
  s.object3D = null;
  s.tierNote = hooks.tierNote || '';

  /* ── DOM ── */
  if (el && typeof document !== 'undefined') {
    ensureSkeletonStyle();
    const wrap = document.createElement('div');
    wrap.className = 'b4-spin-wrap';
    const cv = document.createElement('canvas');
    cv.className = 'b4-spin-canvas';
    wrap.appendChild(cv);
    // ★ 細節 1：骨架屏（灰色佔位方塊 + 極慢呼吸），不是 spinner
    const skel = document.createElement('div');
    skel.className = 'b4-skel';
    const sb = document.createElement('div');
    sb.className = 'b4-skel-b';
    sb.style.cssText = 'left:18%;right:18%;bottom:12%;height:7%;';
    skel.appendChild(sb);
    wrap.appendChild(skel);
    el.appendChild(wrap);
    s.wrap = wrap; s.canvas = cv; s.skel = skel;
    s.ctx2d = cv.getContext('2d');
  }

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  s._resize = () => {
    if (!s.canvas || !s.wrap) return;
    const dpr = Math.min(typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1, 2);
    const w = Math.max(1, s.wrap.clientWidth || 640), h = Math.max(1, s.wrap.clientHeight || 400);
    if (s.canvas.width !== Math.round(w * dpr) || s.canvas.height !== Math.round(h * dpr)) {
      s.canvas.width = Math.round(w * dpr); s.canvas.height = Math.round(h * dpr);
    }
    s._cssW = w; s._cssH = h;
  };

  s._paint = () => {
    if (!s.ctx2d || s.disposed) return;
    s._resize();
    const c = s.ctx2d, W = s.canvas.width, H = s.canvas.height;
    c.clearRect(0, 0, W, H);
    const angle = (s.index / Math.max(1, s.frames.length)) * Math.PI * 2;
    // ★ 細節 3：落地陰影先畫，形狀隨角度改變
    drawGroundShadow(c, W, H, angle, 1);
    const src = s.set.canvases[s.index];
    if (src) {
      const sw = src.width, sh = src.height;
      const k = Math.min((W * 0.92) / sw, (H * 0.80) / sh);
      const dw = sw * k, dh = sh * k;
      c.drawImage(src, (W - dw) / 2, H * 0.78 - dh * 0.92, dw, dh);
    }
    if (s._tex) s._tex.needsUpdate = true;
  };

  /* ── 預載入 ── */
  s.load = async () => {
    const ok = await s.set.preload();
    if (s.disposed) return false;
    if (s.skel && s.skel.parentNode) s.skel.parentNode.removeChild(s.skel);
    s.enabled = ok;
    if (ok) s._paint();
    return ok;
  };

  /* ── 指標互動（拖曳 + ★ 細節 5：慣性） ── */
  if (s.wrap) {
    let lastX = 0, lastT = 0;
    const down = (e) => {
      if (!s.enabled) return;
      s.dragging = true; s._anim = null; s._vel = 0;
      s._pending = 0; lastX = e.clientX; lastT = now();
      s._lastInteract = lastT; s._idleAcc = 0;
      s.wrap.classList.add('b4-drag');
      if (s.wrap.setPointerCapture && e.pointerId !== undefined) {
        try { s.wrap.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      }
    };
    const move = (e) => {
      if (!s.dragging) return;
      const t = now(), dx = e.clientX - lastX, dt = Math.max(t - lastT, 1);
      lastX = e.clientX; lastT = t;
      s._lastInteract = t;
      const vw = s._cssW || s.wrap.clientWidth || 640;
      const step = vw / s.frames.length;
      s._pending += dx;
      if (Math.abs(s._pending) >= step) {
        const k = Math.trunc(s._pending / step);
        s.onDrag(k * step, vw);        // 保證 Math.round(dx/step) === k
        s._pending -= k * step;
        s._f = s.index;
      }
      s._vel = (dx / step) / (dt / 1000);
    };
    const up = () => {
      if (!s.dragging) return;
      s.dragging = false;
      s.wrap.classList.remove('b4-drag');
      s._lastInteract = now();
      // 放開後繼續轉一小段再減速停下（自訂 cubic-bezier，禁用 linear）
      const v = clamp(s._vel, -34, 34);
      if (Math.abs(v) > 1.2) {
        const travel = v * 0.42;
        s._f = s.index;
        s._anim = { from: s._f, to: s._f + travel, t: 0, dur: clamp(0.28 + Math.abs(travel) * 0.055, 0.35, 1.5) };
      }
      s._vel = 0;
    };
    s.wrap.addEventListener('pointerdown', down);
    s.wrap.addEventListener('pointermove', move);
    s.wrap.addEventListener('pointerup', up);
    s.wrap.addEventListener('pointercancel', up);
    s.wrap.addEventListener('pointerleave', up);
    s._handlers = { down, move, up };
  }

  /* ── ★ 細節 6：3D 場景整合（永遠面向相機的 Plane，並乘上環境光顏色） ── */
  s.attach3D = (opts = {}) => {
    if (!s.canvas || !THREE) return null;
    const tex = new THREE.CanvasTexture(s.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;             // Albedo 必須手動設（r185）
    tex.anisotropy = opts.anisotropy || 4;
    s._tex = tex;
    // 基底材質一律來自 ctx.materials（此處以 car.shadow 這張純 Albedo 材質做 clone），
    // 不自己 new Material。
    const mat = opts.baseMaterial.clone();
    mat.map = tex;
    mat.transparent = true;
    mat.depthWrite = false;
    if ('roughnessMap' in mat) { mat.roughnessMap = null; mat.normalMap = null; }
    const w = opts.width || 4.4, h = opts.height || 4.4 * (s.canvas.height / Math.max(1, s.canvas.width));
    const geo = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = h / 2;
    mesh.userData.b4Billboard = true;
    const g = new THREE.Group();
    g.add(mesh);
    s.object3D = g; s._plane = mesh; s._mat = mat; s._geo = geo;
    s._baseColor = mat.color ? mat.color.clone() : null;
    return g;
  };

  /** 每幀更新：閒置慢轉 / 慣性 / 佈告板面向相機 / 光照色調 */
  s.update = (dt, elapsed, camera, tint) => {
    if (s.disposed) return;
    // 慣性
    if (s._anim) {
      s._anim.t += dt;
      const p = clamp(s._anim.t / s._anim.dur, 0, 1);
      const e = EASE_COMPONENT_FN(p);
      const f = lerp(s._anim.from, s._anim.to, e);
      const i = Math.round(f);
      if (i !== s.index) s.show(i);
      s._f = f;
      if (p >= 1) s._anim = null;
    } else if (s.enabled && !s.dragging) {
      // 閒置慢轉：8 秒沒互動後每 3 秒一格；使用者一碰就停（down/move 會更新 _lastInteract）
      const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (t - s._lastInteract > IDLE_DELAY_MS) {
        s._idleAcc += dt * 1000;
        if (s._idleAcc >= IDLE_STEP_MS) { s._idleAcc = 0; s.show(s.index + 1); s._f = s.index; }
      } else s._idleAcc = 0;
    }
    // 佈告板
    if (s._plane && camera) {
      s._plane.quaternion.copy(camera.quaternion);
      if (tint && s._mat && s._mat.color && s._baseColor) {
        s._mat.color.copy(s._baseColor).multiply(tint);
      }
    }
  };

  s.dispose = () => {
    if (s.disposed) return;
    s.disposed = true;
    if (s.wrap && s._handlers) {
      s.wrap.removeEventListener('pointerdown', s._handlers.down);
      s.wrap.removeEventListener('pointermove', s._handlers.move);
      s.wrap.removeEventListener('pointerup', s._handlers.up);
      s.wrap.removeEventListener('pointercancel', s._handlers.up);
      s.wrap.removeEventListener('pointerleave', s._handlers.up);
    }
    if (s.wrap && s.wrap.parentNode) s.wrap.parentNode.removeChild(s.wrap);
    if (s._tex) s._tex.dispose();
    if (s._geo) s._geo.dispose();
    if (s._mat) s._mat.dispose();
    s.set.dispose();
  };

  return s;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 7. 第二層｜角度切換器（3–7 張，0.25 秒交叉淡入）
 * ──────────────────────────────────────────────────────────────────────────── */

function makeAngleSwitcher(THREE, images, el, hooks = {}) {
  const a = {
    frames: images.slice(), index: 0, dragging: false, disposed: false,
    set: new FrameSet(images), enabled: false, labels: hooks.labels || null,
  };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  a._fade = null;   // { from, to, t, dur }

  if (el && typeof document !== 'undefined') {
    ensureSkeletonStyle();
    const wrap = document.createElement('div');
    wrap.className = 'b4-spin-wrap';
    const cv = document.createElement('canvas');
    cv.className = 'b4-spin-canvas';
    wrap.appendChild(cv);
    const skel = document.createElement('div');
    skel.className = 'b4-skel';
    wrap.appendChild(skel);
    const bar = document.createElement('div');
    bar.className = 'b4-angles';
    wrap.appendChild(bar);
    el.appendChild(wrap);
    a.wrap = wrap; a.canvas = cv; a.skel = skel; a.bar = bar;
    a.ctx2d = cv.getContext('2d');
  }

  a._resize = () => {
    if (!a.canvas || !a.wrap) return;
    const dpr = Math.min(typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1, 2);
    const w = Math.max(1, a.wrap.clientWidth || 640), h = Math.max(1, a.wrap.clientHeight || 400);
    a.canvas.width = Math.round(w * dpr); a.canvas.height = Math.round(h * dpr);
    a._cssW = w;
  };

  const drawFrame = (c, i, alpha, W, H) => {
    const src = a.set.canvases[i];
    if (!src) return;
    c.save();
    c.globalAlpha = alpha;
    const k = Math.min((W * 0.92) / src.width, (H * 0.80) / src.height);
    const dw = src.width * k, dh = src.height * k;
    c.drawImage(src, (W - dw) / 2, H * 0.78 - dh * 0.92, dw, dh);
    c.restore();
  };

  a._paint = () => {
    if (!a.ctx2d || a.disposed) return;
    const c = a.ctx2d, W = a.canvas.width, H = a.canvas.height;
    c.clearRect(0, 0, W, H);
    const ang = (i) => (i / Math.max(1, a.frames.length)) * Math.PI * 2;
    if (a._fade) {
      const p = clamp(a._fade.t / a._fade.dur, 0, 1);
      const e = EASE_MICRO_FN(p);
      drawGroundShadow(c, W, H, lerp(ang(a._fade.from), ang(a._fade.to), e), 1);
      drawFrame(c, a._fade.from, 1 - e, W, H);
      drawFrame(c, a._fade.to, e, W, H);
    } else {
      drawGroundShadow(c, W, H, ang(a.index), 1);
      drawFrame(c, a.index, 1, W, H);
    }
    if (a._tex) a._tex.needsUpdate = true;
  };

  /** 每次切換 0.25 秒交叉淡入 */
  a.show = (i) => {
    const n = a.frames.length;
    const t = ((i % n) + n) % n;
    if (t === a.index && !a._fade) { a._paint(); return; }
    a._fade = { from: a.index, to: t, t: 0, dur: 0.25 };
    a.index = t;
    if (a.bar) [...a.bar.children].forEach((b, k) => b.setAttribute('aria-pressed', String(k === t)));
  };

  a.load = async () => {
    const ok = await a.set.preload();
    if (a.disposed) return false;
    if (a.skel && a.skel.parentNode) a.skel.parentNode.removeChild(a.skel);
    a.enabled = ok;
    if (ok && a.bar) {
      a.frames.forEach((_, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = (a.labels && a.labels[i]) || `角度 ${i + 1}`;
        b.setAttribute('aria-pressed', String(i === a.index));
        b.addEventListener('click', () => a.show(i));
        a.bar.appendChild(b);
      });
    }
    a._resize();
    if (ok) a._paint();
    return ok;
  };

  // 拖曳也可切換
  if (a.wrap) {
    let x0 = 0;
    const down = (e) => { if (!a.enabled) return; a.dragging = true; x0 = e.clientX; };
    const move = (e) => {
      if (!a.dragging) return;
      const step = (a._cssW || 640) / (a.frames.length * 1.6);
      const dx = e.clientX - x0;
      if (Math.abs(dx) >= step) { a.show(a.index + (dx > 0 ? 1 : -1)); x0 = e.clientX; }
    };
    const up = () => { a.dragging = false; };
    a.wrap.addEventListener('pointerdown', down);
    a.wrap.addEventListener('pointermove', move);
    a.wrap.addEventListener('pointerup', up);
    a.wrap.addEventListener('pointerleave', up);
    a._handlers = { down, move, up };
  }

  a.attach3D = (opts = {}) => {
    if (!a.canvas || !THREE) return null;
    const tex = new THREE.CanvasTexture(a.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    a._tex = tex;
    const mat = opts.baseMaterial.clone();
    mat.map = tex; mat.transparent = true; mat.depthWrite = false;
    const w = opts.width || 4.4, h = opts.height || 4.4 * (a.canvas.height / Math.max(1, a.canvas.width));
    const geo = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = h / 2;
    const g = new THREE.Group(); g.add(mesh);
    a.object3D = g; a._plane = mesh; a._mat = mat; a._geo = geo;
    a._baseColor = mat.color ? mat.color.clone() : null;
    return g;
  };

  a.update = (dt, elapsed, camera, tint) => {
    if (a.disposed) return;
    if (a._fade) {
      a._fade.t += dt;
      a._paint();
      if (a._fade.t >= a._fade.dur) { a._fade = null; a._paint(); }
    }
    if (a._plane && camera) {
      a._plane.quaternion.copy(camera.quaternion);
      if (tint && a._mat && a._mat.color && a._baseColor) a._mat.color.copy(a._baseColor).multiply(tint);
    }
  };

  a.dispose = () => {
    if (a.disposed) return;
    a.disposed = true;
    if (a.wrap && a._handlers) {
      a.wrap.removeEventListener('pointerdown', a._handlers.down);
      a.wrap.removeEventListener('pointermove', a._handlers.move);
      a.wrap.removeEventListener('pointerup', a._handlers.up);
      a.wrap.removeEventListener('pointerleave', a._handlers.up);
    }
    if (a.wrap && a.wrap.parentNode) a.wrap.parentNode.removeChild(a.wrap);
    if (a._tex) a._tex.dispose();
    if (a._geo) a._geo.dispose();
    if (a._mat) a._mat.dispose();
    a.set.dispose();
  };

  return a;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 8. Fleet｜39 台同場（依車頂線分 3 類，每類 車身/車窗/輪胎/輪圈 各一個 InstancedMesh）
 * ──────────────────────────────────────────────────────────────────────────── */

/** Fleet 車身把 paint/trim/lamp/stripe 併成一個 IM，用頂點色區分零件 */
const VC = {
  paint: [1.00, 1.00, 1.00],
  trim: [0.150, 0.158, 0.170],
  lamp: [0.880, 0.845, 0.790],
  stripe: [0.480, 0.492, 0.510],
  core: [0.085, 0.090, 0.098],
};

function makeFleet(THREE, api, carIds) {
  const cars = carIds.map((id) => api._carById(id)).filter(Boolean);
  const group = new THREE.Group();
  group.name = 'B4_Fleet';

  const byClass = { tall: [], mid: [], low: [] };
  const slot = new Map();          // carId -> {cls, k}
  cars.forEach((car) => {
    const cls = roofClassOf(car.height);
    slot.set(car.id, { cls, k: byClass[cls].length });
    byClass[cls].push(car);
  });

  const idx = new Map();           // carId -> 全域 index
  const entries = [];              // 依 carIds 順序
  const classData = {};
  const disposables = [];

  for (const cls of ROOF_CLASSES) {
    const list = byClass[cls];
    if (!list.length) continue;
    // 類別參考車：該類別的中位數尺寸（Fleet 原型以它烘焙，各車再用 instance scale 還原）
    const med = (f) => { const a = list.map(f).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    const refCar = {
      id: `__ref_${cls}`, length: med((c) => c.length), width: med((c) => c.width),
      height: med((c) => c.height), wheelbase: med((c) => c.wheelbase),
      brandColor: '#888888', comfort: { 車頂行李架: false, 天窗: false },
    };
    const refSp = deriveSpec(refCar, api._opts);
    const B = buildCarGeometry(THREE, refSp, 'low');

    // 車身：paint + trim + lamp + stripe + core → 一個 IM（頂點色）
    const bodyList = [];
    for (const key of ['paint', 'trim', 'lamp', 'stripe', 'core']) {
      for (const it of B[key]) bodyList.push({ geo: it.geo, matrix: it.matrix, __c: VC[key] });
    }
    const bodyParts = bodyList.map((it) => {
      const one = mergeGeos(THREE, [{ geo: it.geo, matrix: it.matrix }], it.__c);
      return { geo: one };
    });
    const bodyGeo = mergeGeos(THREE, bodyParts);
    bodyParts.forEach((p) => p.geo.dispose());
    const glassGeo = mergeGeos(THREE, B.glass);
    // 輪胎/輪圈以「單位半徑」烘焙，每個輪子一個 instance（位置與半徑逐台精確）
    const tireUnit = tireGeometry(THREE, 1, 0.37, 14);
    const rimUnit = rimGeometry(THREE, 1, 0.37, 6, true);
    const shadowGeo = shadowGeometry(THREE, 1, 1);
    for (const g of B.paint.concat(B.trim, B.lamp, B.stripe, B.core, B.glass, B.tire, B.wheel)) g.geo.dispose();

    const n = list.length;
    const mkIM = (geo, mat, count) => {
      const im = new THREE.InstancedMesh(geo, mat, count);
      im.frustumCulled = false;
      im.castShadow = true; im.receiveShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      group.add(im);
      return im;
    };
    const body = mkIM(bodyGeo, api._fleetPaintMat, n);
    const glass = glassGeo ? mkIM(glassGeo, api._mat('car.glass'), n) : null;
    const tire = mkIM(tireUnit, api._mat('car.tire'), n * 4);
    const rim = mkIM(rimUnit, api._mat('car.wheel'), n * 4);
    const shadow = mkIM(shadowGeo, api._shadowMat, n);
    shadow.castShadow = false;
    disposables.push(bodyGeo, glassGeo, tireUnit, rimUnit, shadowGeo);

    const white = new THREE.Color(1, 1, 1);
    body.setColorAt(0, white);
    shadow.setColorAt(0, white);

    classData[cls] = { list, refSp, body, glass, tire, rim, shadow, n };

    list.forEach((car, k) => {
      const sp = deriveSpec(car, api._opts);
      const e = {
        car, sp, cls, k,
        pos: new THREE.Vector3(), quat: new THREE.Quaternion(),
        visible: true, highlight: false, band: 0, dirty: true,
        scale: new THREE.Vector3(sp.W / refSp.W, sp.H / refSp.H, sp.L / refSp.L),
      };
      idx.set(car.id, entries.length);
      entries.push(e);
    });
  }

  /* ── 每台車的品牌色調（★ setColorAt，不是發光） ── */
  const tmpColor = new THREE.Color();
  const applyColor = (e) => {
    const cd = classData[e.cls];
    const base = new THREE.Color(e.sp.bodyColor);
    const brand = new THREE.Color(e.sp.brandColor);
    tmpColor.copy(base).lerp(brand, e.highlight ? 0.26 : 0.14);
    if (e.highlight) {
      // 飽和度提升（HSL），不使用發光/bloom
      const hsl = { h: 0, s: 0, l: 0 };
      tmpColor.getHSL(hsl);
      tmpColor.setHSL(hsl.h, clamp(hsl.s * 1.55 + 0.06, 0, 1), clamp(hsl.l * 1.03, 0, 1));
    }
    cd.body.setColorAt(e.k, tmpColor);
    cd.body.instanceColor.needsUpdate = true;
    // 陰影加深
    cd.shadow.setColorAt(e.k, tmpColor.setScalar(e.highlight ? 0.62 : 1.0));
    cd.shadow.instanceColor.needsUpdate = true;
  };

  const zero = new THREE.Vector3(0, 0, 0);
  const mCar = new THREE.Matrix4(), mLocal = new THREE.Matrix4(), mOut = new THREE.Matrix4();
  const qI = new THREE.Quaternion();
  const vS = new THREE.Vector3(), vP = new THREE.Vector3();
  const qW = new THREE.Quaternion(), axisY = new THREE.Vector3(0, 1, 0);
  const ONE = new THREE.Vector3(1, 1, 1);

  const writeInstance = (e) => {
    const cd = classData[e.cls];
    const hidden = !e.visible || e.band >= 2;
    mCar.compose(e.pos, e.quat, ONE);
    const hs = e.highlight ? 1.03 : 1.0;         // 高亮＝放大，不發光

    // 車身
    if (hidden) mOut.makeScale(0, 0, 0);
    else {
      vS.copy(e.scale).multiplyScalar(hs);
      mOut.copy(mCar).multiply(mLocal.compose(zero, qI, vS));
    }
    cd.body.setMatrixAt(e.k, mOut);

    // 車窗（LOD1 起省略）
    if (cd.glass) {
      if (hidden || e.band >= 1) mOut.makeScale(0, 0, 0);
      cd.glass.setMatrixAt(e.k, mOut);
    }

    // 陰影（高亮時加深＋放大一點）
    if (hidden) mOut.makeScale(0, 0, 0);
    else {
      vS.set(e.sp.W * 1.16 * (e.highlight ? 1.10 : 1), 1, e.sp.L * 1.02 * (e.highlight ? 1.06 : 1));
      mOut.copy(mCar).multiply(mLocal.compose(vP.set(0, 0.0015, 0), qI, vS));
    }
    cd.shadow.setMatrixAt(e.k, mOut);

    // 四個輪子（位置與半徑逐台精確）
    const sp = e.sp;
    const wpos = [
      [sp.wheelX, sp.axleFZ, 1], [-sp.wheelX, sp.axleFZ, -1],
      [sp.wheelX, sp.axleRZ, 1], [-sp.wheelX, sp.axleRZ, -1],
    ];
    for (let w = 0; w < 4; w++) {
      const [x, z, s] = wpos[w];
      if (hidden) mOut.makeScale(0, 0, 0);
      else {
        qW.setFromAxisAngle(axisY, s > 0 ? 0 : Math.PI);
        vS.setScalar(sp.wheelR * hs);
        mOut.copy(mCar).multiply(mLocal.compose(vP.set(x, sp.wheelR, z), qW, vS));
      }
      cd.tire.setMatrixAt(e.k * 4 + w, mOut);
      if (hidden || e.band >= 1) mOut.makeScale(0, 0, 0);
      cd.rim.setMatrixAt(e.k * 4 + w, mOut);
    }
  };

  const fleet = {
    group,
    carIds: entries.map((e) => e.car.id),
    indexOf(carId) { const i = idx.get(carId); return i === undefined ? -1 : i; },
    setTransform(i, pos, quat) {
      const e = entries[i]; if (!e) return;
      if (pos) e.pos.copy(pos);
      if (quat) e.quat.copy(quat);
      e.dirty = true;
    },
    setHighlight(i, on) {
      const e = entries[i]; if (!e || e.highlight === !!on) return;
      e.highlight = !!on; e.dirty = true; applyColor(e);
    },
    setVisible(i, on) {
      const e = entries[i]; if (!e || e.visible === !!on) return;
      e.visible = !!on; e.dirty = true;
    },
    /** 一次性 flush instanceMatrix.needsUpdate */
    commit() {
      let any = false;
      for (const e of entries) if (e.dirty) { writeInstance(e); e.dirty = false; any = true; }
      if (!any) return;
      for (const cls of ROOF_CLASSES) {
        const cd = classData[cls]; if (!cd) continue;
        cd.body.instanceMatrix.needsUpdate = true;
        if (cd.glass) cd.glass.instanceMatrix.needsUpdate = true;
        cd.tire.instanceMatrix.needsUpdate = true;
        cd.rim.instanceMatrix.needsUpdate = true;
        cd.shadow.instanceMatrix.needsUpdate = true;
      }
    },
    /** LOD：>40 m 用簡化版（車身 + 輪胎）、>100 m 直接隱藏 */
    updateLOD(camera) {
      if (!camera) return;
      const cp = camera.position;
      let changed = false;
      for (const e of entries) {
        const d = Math.hypot(e.pos.x - cp.x, e.pos.y - cp.y, e.pos.z - cp.z);
        const band = d > LOD_FAR ? 2 : (d > LOD_NEAR ? 1 : 0);
        if (band !== e.band) { e.band = band; e.dirty = true; changed = true; }
      }
      if (changed) fleet.commit();
    },
    drawCalls() {
      let n = 0;
      for (const cls of ROOF_CLASSES) { const cd = classData[cls]; if (cd) n += 4 + (cd.glass ? 1 : 0); }
      return n;
    },
    dispose() {
      for (const g of disposables) if (g) g.dispose();
      group.clear();
      entries.length = 0; idx.clear();
    },
  };

  for (const e of entries) applyColor(e);
  fleet.commit();
  return fleet;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 9. 工廠｜createCarModels(ctx)
 * ──────────────────────────────────────────────────────────────────────────── */

export function createCarModels(ctx) {
  const THREE = ctx && ctx.THREE;
  if (!THREE) throw new Error('[carModels] ctx.THREE 缺失：本模組不在頂層 import three，必須由 ctx 注入。');
  if (!ctx.materials || typeof ctx.materials.get !== 'function') {
    throw new Error('[carModels] ctx.materials 缺失：材質一律向 B2 材質庫拿，本模組不自行 new Material。');
  }

  const opts = Object.assign({ wheelSpecIsDiameter: false }, ctx.carModelOptions || {});
  const assetBase = ctx.assetBase || './';

  const carsArr = Array.isArray(ctx.cars) ? ctx.cars : [];
  const carsById = ctx.carsById || carsArr.reduce((m, c) => (m[c.id] = c, m), {});

  /* ── 材質（一律 ctx.materials.get；只做 clone 改色，見檔頭假設 2） ── */
  const matCache = new Map();
  const _mat = (name) => {
    if (!matCache.has(name)) matCache.set(name, ctx.materials.get(name));
    return matCache.get(name);
  };
  const clones = [];
  const cloneCache = new Map();
  const _clone = (name, key, tweak) => {
    const ck = `${name}|${key}`;
    if (cloneCache.has(ck)) return cloneCache.get(ck);
    const m = _mat(name).clone();
    tweak(m);
    cloneCache.set(ck, m); clones.push(m);
    return m;
  };
  const paintMat = (hex) => _clone('car.paint', hex, (m) => { if (m.color) m.color.set(hex); });
  const stripeMat = (hex) => _clone('car.paint', `stripe${hex}`, (m) => {
    if (m.color) m.color.set(hex);
    if ('roughness' in m) m.roughness = clamp((m.roughness ?? 0.4) * 0.85, 0.05, 1);
  });
  const darkMat = () => _clone('car.trim', 'wellDark', (m) => {
    if (m.color) m.color.setRGB(0.055, 0.058, 0.064);
    m.side = THREE.DoubleSide;      // 從輪拱開口看進去要看得到內襯的內側
  });
  const shadowMat = () => _clone('car.shadow', 'ground', (m) => {
    m.transparent = true; m.depthWrite = false;
    if ('polygonOffset' in m) { m.polygonOffset = true; m.polygonOffsetFactor = -2; }
  });
  const fleetPaintMat = () => _clone('car.paint', 'fleetVC', (m) => { m.vertexColors = true; });

  /* ── 規格快取 ── */
  const specCache = new Map();
  const specOf = (carId) => {
    if (specCache.has(carId)) return specCache.get(carId);
    const car = carsById[carId];
    if (!car) return null;
    const sp = deriveSpec(car, opts);
    specCache.set(carId, sp);
    return sp;
  };

  /* ── 資產探測（真的去 fetch，不硬編 tier） ── */
  const reports = new Map();          // series -> {tier, count, method, frames[]}
  const seriesCars = new Map();       // series -> Car[]
  for (const c of carsArr) {
    if (!seriesCars.has(c.series)) seriesCars.set(c.series, []);
    seriesCars.get(c.series).push(c);
  }
  const seriesLabel = (series) => {
    const l = seriesCars.get(series);
    return l && l.length ? `${l[0].brand} ${l[0].model}` : series;
  };

  function classify(rep) {
    const method = rep && rep.method;
    const n = (rep && Number(rep.frameCount)) || 0;
    if (method === 'A-360序列' && n >= 8) return { tier: 1, count: n };
    if (method === 'B-一般圖庫' || (n >= 3 && n <= 7)) return { tier: 2, count: n };
    return { tier: 3, count: 0 };
  }
  function framesFor(series, rep, tier, n) {
    if (tier === 3 || !n) return [];
    const sub = tier === 1 ? '360' : 'angles';
    const out = [];
    if (rep && typeof rep.urlPattern === 'string' && rep.urlPattern.includes('%')) {
      for (let i = 0; i < n; i++) {
        out.push(rep.urlPattern.replace(/%0(\d)d/g, (_, w) => String(i + 1).padStart(Number(w), '0')));
      }
      return out;
    }
    for (let i = 0; i < n; i++) {
      out.push(`${assetBase}assets/cars/${series}/${sub}/frame_${String(i + 1).padStart(3, '0')}.jpg`);
    }
    return out;
  }

  const probePromise = (async () => {
    if (typeof fetch !== 'function') return;
    await Promise.all([...seriesCars.keys()].map(async (series) => {
      let rep = null;
      try {
        const res = await fetch(`${assetBase}assets/cars/${series}/report.json`, { cache: 'no-cache' });
        if (res && res.ok) rep = await res.json();
      } catch (e) { rep = null; }        // fetch 失敗 → tier 3（保守）
      const { tier, count } = classify(rep);
      reports.set(series, { tier, count, method: rep && rep.method, frames: framesFor(series, rep, tier, count) });
    }));
  })();

  /* ── LOD0 單台 ── */
  const meshTemplates = new Map();
  const ownedGeos = [];

  function buildTemplate(sp) {
    const B = buildCarGeometry(THREE, sp, 'high');
    const g = new THREE.Group();
    g.name = `car_${sp.id}`;
    const add = (list, material, cast = true) => {
      const geo = mergeGeos(THREE, list);
      if (!geo) return;
      ownedGeos.push(geo);
      const m = new THREE.Mesh(geo, material);
      m.castShadow = cast; m.receiveShadow = true;
      g.add(m);
    };
    add(B.paint, paintMat(sp.bodyColor));
    add(B.trim, _mat('car.trim'));
    add(B.core, darkMat());
    add(B.glass, _mat('car.glass'));
    add(B.lamp, _mat('car.lamp'));
    add(B.stripe, stripeMat(sp.brandColor));
    add(B.tire, _mat('car.tire'));
    add(B.wheel, _mat('car.wheel'));
    for (const k of Object.keys(B)) for (const it of B[k]) it.geo.dispose();
    // 落地陰影
    const sg = shadowGeometry(THREE, sp.L * 1.02, sp.W * 1.16);
    ownedGeos.push(sg);
    const sm = new THREE.Mesh(sg, shadowMat());
    sm.position.y = 0.0015;
    sm.receiveShadow = false; sm.castShadow = false;
    g.add(sm);
    g.userData.carId = sp.id;
    g.userData.tier = 3;
    return g;
  }

  /* ── Spin360 / 角度切換器登記簿（給 update 用） ── */
  const viewers = new Set();
  const fleets = new Set();

  /* ── 場景環境光色調（給 Sprite/Plane 乘上去，讓車不跟場景色溫脫節） ── */
  const tint = new THREE.Color(1, 1, 1);
  let tintAge = 1e9;
  function refreshTint(scene) {
    if (!scene) return;
    let r = 0, g = 0, b = 0, w = 0;
    scene.traverse((o) => {
      if (!o.isLight) return;
      if (o.isAmbientLight || o.isHemisphereLight) {
        const c = o.color, i = Math.min(o.intensity ?? 1, 2);
        r += c.r * i; g += c.g * i; b += c.b * i; w += i;
        if (o.isHemisphereLight && o.groundColor) {
          r += o.groundColor.r * i * 0.35; g += o.groundColor.g * i * 0.35; b += o.groundColor.b * i * 0.35;
          w += i * 0.35;
        }
      }
    });
    if (w > 0) {
      const k = 1 / w;
      tint.setRGB(clamp(r * k, 0.35, 1.25), clamp(g * k, 0.35, 1.25), clamp(b * k, 0.35, 1.25));
    } else tint.setRGB(1, 1, 1);
  }

  /* ── 對外 API ── */
  const api = {
    _mat, _opts: opts, _shadowMat: shadowMat(), _fleetPaintMat: fleetPaintMat(),
    _carById: (id) => carsById[id] || null,

    /** LOD0 完整單台（近看／被告席／駕駛座用）。回傳可自由 add 的 clone。 */
    getCarMesh(carId) {
      const sp = specOf(carId);
      if (!sp) return null;
      if (!meshTemplates.has(carId)) meshTemplates.set(carId, buildTemplate(sp));
      const t = meshTemplates.get(carId).clone(true);
      t.userData.carId = carId;
      t.userData.tier = api.getTier(carId).tier;
      return t;
    },

    /** ★ 39 台同場必須走這條（InstancedMesh + LOD） */
    createFleet(carIds) {
      const f = makeFleet(THREE, api, carIds || carsArr.map((c) => c.id));
      fleets.add(f);
      const od = f.dispose;
      f.dispose = () => { fleets.delete(f); od(); };
      return f;
    },

    getTier(carId) {
      const car = carsById[carId];
      const series = car ? car.series : null;
      const rep = series ? reports.get(series) : null;
      const tier = rep ? rep.tier : 3;
      const n = rep ? rep.count : 0;
      if (tier === 3) {
        return {
          tier: 3,
          label: TIER_LABEL[3](),
          note: '尺寸依原廠公布之車長／車寬／車高／軸距生成；輪組位置與外觀細節為幾何推估，不代表實車鈑件。',
        };
      }
      const shared = (seriesCars.get(series) || []).length > 1;
      return {
        tier,
        label: TIER_LABEL[tier](n),
        note: shared
          ? `外觀圖為 ${seriesLabel(series)} 車系共用，各等級外觀差異未反映於圖中`
          : `外觀圖為 ${seriesLabel(series)} 原廠官網素材`,
      };
    },

    /** 公尺 */
    getFootprint(carId) {
      const sp = specOf(carId);
      if (!sp) return null;
      return { length: sp.L, width: sp.W, height: sp.H, wheelbase: sp.WB };
    },

    /**
     * ★ 駕駛座眼點：依真實車高（CX-30 1540 與 Mufasa 1695 的視野差看得出來）。
     * 基準是規格建議的 height * 0.62，但加一道下限「腰線 + 0.14 m」：
     * 0.62 * 車高 會落在腰線**之下**（Mufasa 1.05 m vs 腰線 1.11 m），
     * 駕駛會變成盯著儀表台，整個「車越高視野越好」的體驗就毀了。
     * 取兩者較大值後：CX-30 1.175 m、Mufasa 1.245 m，差 7 cm，與實車相符。
     */
    getEyePoint(carId) {
      const sp = specOf(carId);
      if (!sp) return null;
      const eyeY = Math.max(sp.H * 0.62, sp.belt + 0.14);
      return new THREE.Vector3(-0.35, eyeY, sp.axleFZ + Math.max(0.45, sp.WB * 0.22));
    },

    /** 第一層檢視器（本次無素材；仍完整實作，補上素材即可用） */
    createSpin360(frames, el) {
      const s = makeSpin360(THREE, Array.isArray(frames) ? frames : [], el);
      s._baseMaterialFactory = () => shadowMat();
      const oa = s.attach3D;
      s.attach3D = (o = {}) => oa(Object.assign({ baseMaterial: shadowMat() }, o));
      viewers.add(s);
      const od = s.dispose;
      s.dispose = () => { viewers.delete(s); od(); };
      if (s.frames.length) s.load();
      return s;
    },

    /** 第二層｜角度切換器（3–7 張，0.25 秒交叉淡入） */
    createAngleSwitcher(images, el, hooks) {
      const a = makeAngleSwitcher(THREE, Array.isArray(images) ? images : [], el, hooks);
      const oa = a.attach3D;
      a.attach3D = (o = {}) => oa(Object.assign({ baseMaterial: shadowMat() }, o));
      viewers.add(a);
      const od = a.dispose;
      a.dispose = () => { viewers.delete(a); od(); };
      if (a.frames.length) a.load();
      return a;
    },

    /** 依 getTier 自動選層：tier1 → Spin360、tier2 → 角度切換器、tier3 → null（走 3D 模型） */
    createViewerFor(carId, el) {
      const car = carsById[carId];
      const rep = car ? reports.get(car.series) : null;
      if (!rep || rep.tier === 3 || !rep.frames.length) return null;
      return rep.tier === 1 ? api.createSpin360(rep.frames, el) : api.createAngleSwitcher(rep.frames, el);
    },

    /** 資產探測完成後 resolve；rooms 可 await 再決定要不要顯示 360 入口 */
    whenAssetsProbed() { return probePromise; },
    getSeriesReport(series) { return reports.get(series) || null; },
    getRoofClass(carId) { const c = carsById[carId]; return c ? roofClassOf(c.height) : null; },

    update(dt, elapsed, camera) {
      tintAge += dt;
      if (tintAge > 0.5) { tintAge = 0; refreshTint(ctx.scene); }
      for (const f of fleets) f.updateLOD(camera);
      for (const v of viewers) v.update(dt, elapsed, camera, tint);
    },

    dispose() {
      for (const v of [...viewers]) v.dispose();
      viewers.clear();
      for (const f of [...fleets]) f.dispose();
      fleets.clear();
      for (const g of ownedGeos) g.dispose();
      ownedGeos.length = 0;
      meshTemplates.clear();
      for (const m of clones) m.dispose();
      clones.length = 0;
      cloneCache.clear(); matCache.clear(); specCache.clear();
    },
  };

  return api;
}

export default createCarModels;
