/**
 * materials.js — B2 PBR 材質庫（第 2 階段子代理產出）
 *
 * 假設：
 *  1. 貼圖一律 Canvas 2D 程序生成後包成 THREE.CanvasTexture。生成是 **lazy** 的：
 *     只有第一次 get(name) / texture(name) 才會烘該材質的貼圖，開場不卡。
 *  2. 執行環境有 document.createElement('canvas')（或 OffscreenCanvas）。
 *     node 下只做 `node --check` 語法檢查，不會執行到烘焙程式碼。
 *  3. ctx.THREE 是 three.js r0.185.x 命名空間；本檔**不在頂層 import three**。
 *  4. ctx.renderer 可有可無；有的話取 capabilities.getMaxAnisotropy()，沒有則 aniso = 4。
 *  5. scene.environment / environmentIntensity 由 main.js 統一設定（MODULE_API §1.4）。
 *     frame.glass / car.glass / car.lamp 的反射與折射完全靠它，本檔不碰 scene。
 *  6. UV 慣例：假設 B1 的幾何 UV 為 0..1。每個材質的 map.repeat 預設值是
 *     「假設該表面接近其典型尺寸」估出來的合理值（例如 floor.oak 預設 4×5，
 *     對應約 9.6 m × 6.0 m 的地板）。要精確請用：
 *        mat.userData.tileMeters = { x, y }   ← 一張貼圖代表的實際公尺數
 *        lib.fitRepeat(name, 寬公尺, 高公尺)  ← 直接幫你算好 repeat
 *  7. 「走道中央磨損 / 牆腳變暗 / 水泥底部積污 / 隧道底部廢氣漬 / 車漆積灰」這幾項是
 *     **世界座標尺度**的變化，不可能烘進一張會 tiling 的貼圖，因此以 onBeforeCompile
 *     注入 GLSL，依世界座標（由 vViewPosition + cameraPosition + viewMatrix 反推）計算。
 *     可調 uniform 掛在 mat.userData.wear，B1/B3 可直接改 .value。
 *
 * 依賴：ctx.THREE、ctx.renderer（僅取 anisotropy 上限）。不 import 任何專案模組。
 *
 * 未達成的規格（誠實記錄）：
 *  - 木紋「線寬 0.5–2mm」：floor.oak 貼圖 1024px 對應 2.4 m × 1.2 m，v 方向 1.17 mm/px、
 *    u 方向 2.34 mm/px，0.5 mm 已在 texel 以下。實作為 2–4 mm 的木紋帶（最細約 2 texel）。
 *    牆面「0.3 mm 乳膠漆顆粒」同理，以 per-texel 白噪聲近似。
 *  - 橡木板長度規格 90–120 cm：為了貼圖無縫接合，實作固定為 120 cm（在規格區間內），
 *    以每列隨機相位錯開，視覺上仍是不規則交丁。
 *  - 瀝青「邊緣 0.93」「白線剝落露出瀝青」是路面邊界資訊，貼圖無法知道路的邊在哪，
 *    以低頻遮罩近似（bake），未做世界座標對齊。
 *  - 磁磚「燈具正下方黃褐色光照漬」以貼圖內隨機分布的黃褐斑塊近似，未與 B3 的燈位對齊。
 *  - setDust 的 car.paint 端點採用規格中 setDust 段落的數值（clearcoat 0.85→0.35、
 *    roughness 0.25→0.48）。材質「未呼叫過 setDust」時採用 car.paint 段落的
 *    clearcoat 0.7 / roughness 0.28。兩段規格數值本身有出入，這裡兩邊都尊重。
 *  - setGrayscale 不動 car.shadow（它的 map 是 alpha 資料不是 albedo，拔掉會變成黑方塊）
 *    與各材質的 alphaMap（chainlink 的網目鏤空）。sky 以 uGray uniform 轉中性灰。
 *  - aoMap 一律不提供（three r152+ 的 aoMap 讀第二組 UV `uv1`，B1 的幾何不保證有）。
 *    texture(name).aoMap 一律為 null。
 *  - grass.blade 不附 alphaMap（怕 B1 已經用葉片形狀的幾何，再切一次會破圖）。
 */

/* ══════════════════════════════════════════════════════════════════════════
   材質名稱（37 個，一個不少）
   ══════════════════════════════════════════════════════════════════════════ */
export const MATERIAL_NAMES = [
  // 美術館 12
  'floor.oak', 'wall.paint', 'ceiling', 'skirting', 'frame.wood', 'frame.glass',
  'track.rail', 'track.head', 'track.reflector', 'bench.wood', 'plinth', 'label.card',
  // 其餘五景 18
  'asphalt', 'roadline', 'concrete.wall', 'curb', 'tunnel.tile', 'tunnel.grime',
  'kerb.redwhite', 'barrier.concrete', 'barrier.metal', 'grass.blade', 'soil', 'sky',
  'court.platform', 'court.stone', 'chainlink', 'lightpole', 'daycell', 'daycell.dim',
  // 車輛 7
  'car.paint', 'car.glass', 'car.tire', 'car.wheel', 'car.lamp', 'car.trim', 'car.shadow',
];

/* ══════════════════════════════════════════════════════════════════════════
   低階數學 / 噪聲工具
   ══════════════════════════════════════════════════════════════════════════ */
function mulberry32(a) {
  let s = a | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smooth01(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
function sstep(e0, e1, x) { return smooth01((x - e0) / ((e1 - e0) || 1e-6)); }
function hx(h) { return [(h >> 16) & 255, (h >> 8) & 255, h & 255]; }
function frac(x) { return x - Math.floor(x); }

/** 可無縫平鋪的 value noise。P 必須是整數週期。 */
function valueNoise(seed, P) {
  P = Math.max(2, Math.round(P));
  const r = mulberry32(seed);
  const g = new Float32Array(P * P);
  for (let i = 0; i < g.length; i++) g[i] = r();
  return function (u, v) {
    const x = u * P, y = v * P;
    let x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth01(x - x0), fy = smooth01(y - y0);
    x0 = ((x0 % P) + P) % P; y0 = ((y0 % P) + P) % P;
    const x1 = (x0 + 1) % P, y1 = (y0 + 1) % P;
    const a = g[y0 * P + x0], b = g[y0 * P + x1], c = g[y1 * P + x0], d = g[y1 * P + x1];
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
  };
}
/** 多階 fbm，仍然可無縫平鋪。回傳 0..1 */
function fbm(seed, P, oct, gain) {
  const ns = []; let p = Math.max(2, Math.round(P));
  for (let i = 0; i < oct; i++) { ns.push(valueNoise(seed + i * 7919, p)); p *= 2; }
  const g = gain || 0.5;
  return function (u, v) {
    let s = 0, a = 1, n = 0;
    for (let i = 0; i < ns.length; i++) { s += ns[i](u, v) * a; n += a; a *= g; }
    return s / n;
  };
}
/**
 * Worley（cellular）——瀝青骨材、磨石子石粒、鍍鋅結晶都靠它。
 * 回傳 fn(u,v) -> { f1, f2, id }，可無縫平鋪。
 */
function worley(seed, cells) {
  const C = Math.max(2, Math.round(cells));
  const r = mulberry32(seed);
  const px = new Float32Array(C * C), py = new Float32Array(C * C), pid = new Float32Array(C * C);
  for (let i = 0; i < C * C; i++) { px[i] = r(); py[i] = r(); pid[i] = r(); }
  const out = { f1: 0, f2: 0, id: 0 };
  return function (u, v) {
    const x = u * C, y = v * C;
    const cx = Math.floor(x), cy = Math.floor(y);
    let f1 = 1e9, f2 = 1e9, id = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const gy = ((cy + dy) % C + C) % C;
      for (let dx = -1; dx <= 1; dx++) {
        const gx = ((cx + dx) % C + C) % C;
        const k = gy * C + gx;
        const sx = cx + dx + px[k], sy = cy + dy + py[k];
        const ddx = x - sx, ddy = y - sy;
        const d = Math.sqrt(ddx * ddx + ddy * ddy);
        if (d < f1) { f2 = f1; f1 = d; id = pid[k]; }
        else if (d < f2) { f2 = d; }
      }
    }
    out.f1 = f1; out.f2 = f2; out.id = id;
    return out;
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Canvas / 場（Field）工具
   ══════════════════════════════════════════════════════════════════════════ */
function newCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  throw new Error('materials.js: 需要 Canvas 2D（瀏覽器環境）才能生成程序貼圖');
}
function ctx2d(cv) { return cv.getContext('2d', { willReadFrequently: true }); }

/** Uint8ClampedArray(RGBA) -> canvas */
function rgbaToCanvas(A, S) {
  const cv = newCanvas(S, S), g = ctx2d(cv);
  const img = g.createImageData(S, S);
  img.data.set(A);
  g.putImageData(img, 0, 0);
  return cv;
}
/** Float32Array(0..1) -> 灰階 canvas（Roughness / Alpha / Metalness 用） */
function fieldToCanvas(F, S) {
  const A = new Uint8ClampedArray(S * S * 4);
  for (let i = 0, n = S * S; i < n; i++) {
    const v = Math.round(clamp01(F[i]) * 255);
    A[i * 4] = v; A[i * 4 + 1] = v; A[i * 4 + 2] = v; A[i * 4 + 3] = 255;
  }
  return rgbaToCanvas(A, S);
}

/**
 * height → normal（Sobel 卷積）。
 * H     : Float32Array，0..1 的高度場（1 = 最高）
 * S     : 邊長 px
 * depthMM: 高度場 0→1 對應的實際起伏「毫米」
 * tileX/tileY: 這張貼圖代表的實際公尺數（決定 texel 的世界尺寸，兩軸可不同）
 * 回傳 tangent-space normal map canvas（OpenGL 慣例 +Y up；已考慮 three 的 flipY）
 */
function heightToNormal(H, S, depthMM, tileX, tileY) {
  const A = new Uint8ClampedArray(S * S * 4);
  const dz = depthMM * 0.001;               // mm -> m
  const psx = tileX / S, psy = tileY / S;   // 每 texel 的世界尺寸（公尺）
  for (let y = 0; y < S; y++) {
    const ym = ((y - 1) + S) % S, yp = (y + 1) % S;
    for (let x = 0; x < S; x++) {
      const xm = ((x - 1) + S) % S, xp = (x + 1) % S;
      const h00 = H[ym * S + xm], h10 = H[ym * S + x], h20 = H[ym * S + xp];
      const h01 = H[y * S + xm], h21 = H[y * S + xp];
      const h02 = H[yp * S + xm], h12 = H[yp * S + x], h22 = H[yp * S + xp];
      const gx = ((h20 + 2 * h21 + h22) - (h00 + 2 * h01 + h02)) / 8;
      const gy = ((h02 + 2 * h12 + h22) - (h00 + 2 * h10 + h20)) / 8;
      // 斜率（世界尺度）。canvas 的 +y 向下，貼圖 flipY=true 之後 v 向上，故 G 取 +gy。
      const sx = gx * dz / psx, sy = gy * dz / psy;
      const nx = -sx, ny = sy;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (y * S + x) * 4;
      A[i] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      A[i + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      A[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      A[i + 3] = 255;
    }
  }
  return rgbaToCanvas(A, S);
}

/** 在場上蓋一個圓（會 wrap），cb(dist01, idx) 回傳的值交給 apply。 */
function stampCircle(S, cx, cy, r, cb) {
  const r2 = r * r;
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
  const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  for (let y = y0; y <= y1; y++) {
    const yy = ((y % S) + S) % S;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const xx = ((x % S) + S) % S;
      cb(Math.sqrt(d2) / r, yy * S + xx, dx / r, dy / r);
    }
  }
}
/** 在場上蓋一條粗線段（會 wrap） */
function stampLine(S, ax, ay, bx, by, r, cb) {
  const minx = Math.floor(Math.min(ax, bx) - r), maxx = Math.ceil(Math.max(ax, bx) + r);
  const miny = Math.floor(Math.min(ay, by) - r), maxy = Math.ceil(Math.max(ay, by) + r);
  const vx = bx - ax, vy = by - ay;
  const L2 = vx * vx + vy * vy || 1e-6;
  for (let y = miny; y <= maxy; y++) {
    const yy = ((y % S) + S) % S;
    for (let x = minx; x <= maxx; x++) {
      let t = ((x - ax) * vx + (y - ay) * vy) / L2;
      t = clamp01(t);
      const px = ax + vx * t, py = ay + vy * t;
      const dx = x - px, dy = y - py;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r) continue;
      const xx = ((x % S) + S) % S;
      cb(d / r, yy * S + xx, t);
    }
  }
}
