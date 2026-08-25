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
    let f1 = 1e18, f2 = 1e18, id = 0;
    const cxm = ((cx % C) + C) % C, cym = ((cy % C) + C) % C;
    for (let dy = -1; dy <= 1; dy++) {
      let gy = cym + dy; if (gy < 0) gy += C; else if (gy >= C) gy -= C;
      const row = gy * C;
      const sy0 = cy + dy;
      for (let dx = -1; dx <= 1; dx++) {
        let gx = cxm + dx; if (gx < 0) gx += C; else if (gx >= C) gx -= C;
        const k = row + gx;
        const ddx = x - (cx + dx + px[k]), ddy = y - (sy0 + py[k]);
        const d2 = ddx * ddx + ddy * ddy;          // 只比平方，最後才 sqrt
        if (d2 < f1) { f2 = f1; f1 = d2; id = pid[k]; }
        else if (d2 < f2) { f2 = d2; }
      }
    }
    out.f1 = Math.sqrt(f1); out.f2 = Math.sqrt(f2); out.id = id;
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
    const ym = (y === 0) ? S - 1 : y - 1, yp = (y === S - 1) ? 0 : y + 1;
    const rm = ym * S, r0 = y * S, rp = yp * S;
    for (let x = 0; x < S; x++) {
      const xm = (x === 0) ? S - 1 : x - 1, xp = (x === S - 1) ? 0 : x + 1;
      const h00 = H[rm + xm], h10 = H[rm + x], h20 = H[rm + xp];
      const h01 = H[r0 + xm], h21 = H[r0 + xp];
      const h02 = H[rp + xm], h12 = H[rp + x], h22 = H[rp + xp];
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

/**
 * 把噪聲預先算在 Q×Q 格點上，主迴圈改用雙線性內插取樣（仍然無縫）。
 * 1024×1024 的貼圖若每個 texel 都跑 3–4 階 fbm 會慢到卡畫面，這是關鍵優化。
 */
function bakeField(fn, Q) {
  const F = new Float32Array(Q * Q);
  for (let y = 0; y < Q; y++) {
    for (let x = 0; x < Q; x++) F[y * Q + x] = fn(x / Q, y / Q);
  }
  return F;
}
function sampleField(F, Q, u, v) {
  const x = u * Q, y = v * Q;
  let x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  x0 = ((x0 % Q) + Q) % Q; y0 = ((y0 % Q) + Q) % Q;
  const x1 = (x0 + 1) % Q, y1 = (y0 + 1) % Q;
  const a = F[y0 * Q + x0], b = F[y0 * Q + x1], c = F[y1 * Q + x0], d = F[y1 * Q + x1];
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
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

/* ══════════════════════════════════════════════════════════════════════════
   注入用的 GLSL（世界座標尺度的髒污／磨損）
   ══════════════════════════════════════════════════════════════════════════ */
const GLSL_WORLDPOS = [
  'vec3 mlWorldPos() {',
  '  vec3 vp = - vViewPosition;',
  '  return cameraPosition + ( vec4( vp, 0.0 ) * viewMatrix ).xyz;',
  '}',
].join('\n');

/* ══════════════════════════════════════════════════════════════════════════
   主工廠
   ══════════════════════════════════════════════════════════════════════════ */
export function createMaterialLibrary(ctx) {
  const T = ctx && ctx.THREE;
  if (!T) throw new Error('materials.js: createMaterialLibrary(ctx) 需要 ctx.THREE');

  let aniso = 4;
  try {
    if (ctx.renderer && ctx.renderer.capabilities && ctx.renderer.capabilities.getMaxAnisotropy) {
      aniso = Math.max(1, Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy()));
    }
  } catch (e) { aniso = 4; }

  const mats = new Map();        // name -> THREE.Material
  const texRec = new Map();      // name -> { map, roughnessMap, normalMap, aoMap }
  const allTex = [];             // 所有貼圖（dispose / stats）
  const grayBak = new Map();     // name -> 灰階前的 albedo 狀態
  const injected = [];           // 所有注入 shader 的 uniform 物件
  let gray = false;
  let dustAmt = 0;
  let disposed = false;

  /* ---------- 貼圖包裝 ---------- */
  function toTex(canvas, srgb, repeat) {
    const t = new T.CanvasTexture(canvas);
    t.wrapS = T.RepeatWrapping;
    t.wrapT = T.RepeatWrapping;
    if (repeat) t.repeat.set(repeat[0], repeat[1]);
    t.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace;
    t.anisotropy = aniso;
    t.generateMipmaps = true;
    t.minFilter = T.LinearMipmapLinearFilter;
    t.magFilter = T.LinearFilter;
    t.needsUpdate = true;
    t.userData.bytes = canvas.width * canvas.height * 4 * 1.34; // 含 mipmap 估計
    allTex.push(t);
    return t;
  }

  /**
   * 把烘好的場組成材質。
   * o = { size, tile:[x,y]公尺, A:RGBA, R:rough場, H:height場, heightMM,
   *       AL:alpha場, repeat:[rx,ry], physical:bool, params:{} }
   */
  function make(name, o) {
    const S = o.size;
    const rec = { map: null, roughnessMap: null, normalMap: null, aoMap: null };
    const p = Object.assign({}, o.params);
    if (o.A) { rec.map = toTex(rgbaToCanvas(o.A, S), true, o.repeat); p.map = rec.map; }
    if (o.R) { rec.roughnessMap = toTex(fieldToCanvas(o.R, S), false, o.repeat); p.roughnessMap = rec.roughnessMap; }
    if (o.H) {
      rec.normalMap = toTex(heightToNormal(o.H, S, o.heightMM, o.tile[0], o.tile[1]), false, o.repeat);
      p.normalMap = rec.normalMap;
      if (!p.normalScale) p.normalScale = new T.Vector2(1, 1);
    }
    if (o.AL) { rec.alphaMap = toTex(fieldToCanvas(o.AL, S), false, o.repeat); p.alphaMap = rec.alphaMap; }
    const M = o.physical ? new T.MeshPhysicalMaterial(p) : new T.MeshStandardMaterial(p);
    M.name = name;
    M.userData.tileMeters = { x: o.tile[0], y: o.tile[1] };
    texRec.set(name, rec);
    return M;
  }

  /** onBeforeCompile 注入世界座標尺度的髒污／磨損 */
  function inject(mat, decl, body, uni) {
    const u = uni || {};
    if (!u.uGray) u.uGray = { value: gray ? 1 : 0 };
    mat.userData.wear = u;
    injected.push(u);
    const key = mat.name;
    mat.onBeforeCompile = function (shader) {
      for (const k in u) shader.uniforms[k] = u[k];
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + decl + '\n' + GLSL_WORLDPOS)
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n{\n  vec3 wp = mlWorldPos();\n' + body + '\n}\n'
        );
    };
    mat.customProgramCacheKey = function () { return 'ml:' + key; };
  }

  /* ══════════════════════════════════════════════════════════════════
     以下：各材質的烘焙器
     ══════════════════════════════════════════════════════════════════ */

  /* ---------- 通用：橡木（floor.oak / bench.wood 共用） ---------- */
  function bakeOak(o) {
    const S = o.size, TX = o.tile[0], TY = o.tile[1];
    const rnd = mulberry32(o.seed);
    const A = new Uint8ClampedArray(S * S * 4);
    const R = new Float32Array(S * S);
    const H = new Float32Array(S * S);
    const rows = Math.max(1, Math.round(TY / o.plankW));      // 幾塊板
    const rowPx = S / rows;
    const perPlankPx = S / Math.max(1, Math.round(TX / o.plankLen));
    const seamU = Math.max(1, 0.001 / TX * S);                // 1mm 接縫
    const seamV = Math.max(1, 0.001 / TY * S);
    const QF = 256;
    const fWarp = bakeField(fbm(o.seed + 23, 3, 3), QF);
    const fWear = bakeField(fbm(o.seed + 37, 2, 3), QF);
    const fMod = bakeField(fbm(o.seed + 71, 6, 3), QF);
    const fineN = valueNoise(o.seed + 53, 256);
    const c0 = hx(0xE8DFD0), c1 = hx(0xD4C6B0), cSeam = hx(0x9A8C78);
    const ringsPerPlank = Math.max(8, Math.round(o.plankW / 0.003)); // 約 3mm 一道木紋

    const row = [];
    for (let j = 0; j < rows; j++) {
      row.push({
        tone: rnd(), phase: rnd(), rough: (rnd() - 0.5) * 0.05,
        cup: rnd() * 0.6 + 0.4, warm: (rnd() - 0.5) * 0.05,
      });
    }
    // 節疤：每 3–4 塊板一個
    const knots = [];
    for (let j = 0; j < rows; j++) {
      for (let k = 0; k < Math.round(TX / o.plankLen); k++) {
        if (rnd() < 0.29) {
          knots.push({
            x: (k + 0.15 + rnd() * 0.7) * perPlankPx + row[j].phase * perPlankPx,
            y: (j + 0.2 + rnd() * 0.6) * rowPx,
            r: (0.10 + rnd() * 0.12) * rowPx,
            a: rnd(),
          });
        }
      }
    }

    for (let y = 0; y < S; y++) {
      const v = y / S;
      const j = Math.min(rows - 1, Math.floor(y / rowPx));
      const ri = row[j];
      const vL = (y - j * rowPx) / rowPx;                 // 板內 0..1
      const dRow = Math.min(y - j * rowPx, (j + 1) * rowPx - y);
      for (let x = 0; x < S; x++) {
        const u = x / S;
        const i = (y * S + x) * 4, p = y * S + x;
        // 板端接縫
        const up = ((x + ri.phase * perPlankPx) % S + S) % S;
        const m = up % perPlankPx;
        const dEnd = Math.min(m, perPlankPx - m);
        const seam = (dEnd < seamU || dRow < seamV) ? 1 : 0;

        // 木紋
        const warp = (sampleField(fWarp, QF, u * 0.9, j * 0.31 + 0.17) - 0.5) * 1.7;
        const mod = (sampleField(fMod, QF, u, v) - 0.5) * 0.35;
        let ring = vL * ringsPerPlank * (1 + mod) + warp * 3.0 + ri.tone * 17;
        let gr = Math.abs(frac(ring) * 2 - 1);
        gr = Math.pow(1 - gr, 3.2);                        // 尖銳暗紋
        const fine = fineN(u * 3.1, v * 3.1) - 0.5;

        // Albedo
        let t = clamp01(ri.tone + ri.warm + fine * 0.12);
        let r8 = lerp(c0[0], c1[0], t), g8 = lerp(c0[1], c1[1], t), b8 = lerp(c0[2], c1[2], t);
        const dark = 1 - gr * 0.115 - Math.abs(fine) * 0.03;
        r8 *= dark; g8 *= dark * 0.998; b8 *= dark * 0.995;

        // Roughness
        const w = sampleField(fWear, QF, u, v);
        let rough = lerp(o.wearLow, o.wearHigh, smooth01((w - 0.22) / 0.56));
        rough += ri.rough + gr * 0.05 + fine * 0.02;

        // Height（0..1，heightMM = 0.5）
        let h = 0.90 + Math.sin(vL * Math.PI) * 0.05 * ri.cup - gr * 0.30 + fine * 0.02;

        if (seam) {
          r8 = cSeam[0]; g8 = cSeam[1]; b8 = cSeam[2];
          rough = 0.62; h = 0.0;
        }
        A[i] = r8; A[i + 1] = g8; A[i + 2] = b8; A[i + 3] = 255;
        R[p] = clamp01(rough);
        H[p] = clamp01(h);
      }
    }
    // 節疤
    for (const k of knots) {
      stampCircle(S, k.x, k.y, k.r * 2.6, function (d, p) {
        const i = p * 4;
        const ringF = Math.pow(1 - Math.abs(frac(d * 5.5 + k.a) * 2 - 1), 2.5);
        const core = 1 - smooth01(d / 0.42);
        const f = clamp01(core * 0.55 + ringF * (1 - d) * 0.30);
        A[i] *= (1 - f * 0.42); A[i + 1] *= (1 - f * 0.47); A[i + 2] *= (1 - f * 0.5);
        R[p] = clamp01(R[p] + f * 0.10);
        H[p] = clamp01(H[p] - core * 0.22 + ringF * (1 - d) * 0.05);
      });
    }
    // 座面中央磨亮（bench.wood）
    if (o.centerWear) {
      for (let y = 0; y < S; y++) {
        const cy = 1 - Math.abs(y / S - 0.5) * 2;
        for (let x = 0; x < S; x++) {
          const cx = 1 - Math.abs(x / S - 0.5) * 2;
          const f = smooth01(cx * 1.25) * smooth01(cy * 1.6);
          const p = y * S + x;
          R[p] = lerp(R[p], o.centerWear, f * 0.9);
        }
      }
    }
    return { A, R, H, size: S, tile: o.tile, heightMM: 0.5 };
  }

  function fieldOf(S) { return new Float32Array(S * S); }
  function rgbaOf(S) { return new Uint8ClampedArray(S * S * 4); }

  /* ══════════════════════════════════════════════════════════════════
     廳一 · 美術館
     ══════════════════════════════════════════════════════════════════ */
  const defs = {};

  defs['floor.oak'] = function () {
    const b = bakeOak({
      size: 1024, tile: [2.4, 1.2], plankW: 0.15, plankLen: 1.2,
      seed: 1337, wearLow: 0.30, wearHigh: 0.55,
    });
    const m = make('floor.oak', {
      size: b.size, tile: b.tile, A: b.A, R: b.R, H: b.H, heightMM: b.heightMM,
      repeat: [4, 5],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff, envMapIntensity: 1.0 },
    });
    // ★ 世界座標尺度：走道中央磨亮 0.30、牆邊角落積灰 0.55
    inject(m,
      ['uniform vec2 uWearCenter;', 'uniform vec2 uWearAxis;', 'uniform float uWearInner;',
        'uniform float uWearOuter;', 'uniform float uRoomHalf;', 'uniform float uWearAmount;',
        'uniform float uGray;'].join('\n'),
      ['  vec2 rel = wp.xz - uWearCenter;',
        '  float d = abs( dot( rel, uWearAxis ) );',
        '  float walk = 1.0 - smoothstep( uWearInner, uWearOuter, d );',
        '  float edge = smoothstep( uRoomHalf - 1.7, uRoomHalf - 0.12, max( abs( rel.x ), abs( rel.y ) ) );',
        '  roughnessFactor = mix( roughnessFactor, 0.30, walk * uWearAmount * 0.9 );',
        '  roughnessFactor = mix( roughnessFactor, 0.55, edge * uWearAmount );',
        '  float dk = mix( 1.0, 0.962, edge );',
        '  dk = mix( dk, 1.0, uGray );',
        '  diffuseColor.rgb *= dk;'].join('\n'),
      {
        uWearCenter: { value: new T.Vector2(0, 0) },
        uWearAxis: { value: new T.Vector2(1, 0) },   // 走道沿 Z 軸 → 量測 X 距離
        uWearInner: { value: 0.9 },
        uWearOuter: { value: 2.6 },
        uRoomHalf: { value: 6.0 },
        uWearAmount: { value: 1.0 },
      });
    return m;
  };

  defs['wall.paint'] = function () {
    const S = 512, tile = [1.2, 1.2];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const low = fbm(4101, 3, 3), peel = fbm(4102, 26, 3), peel2 = fbm(4103, 52, 2);
    const rn = mulberry32(4104);
    const base = hx(0xFCFCFA);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, p = y * S + x, i = p * 4;
        const l = (low(u, v) - 0.5) * 2;
        const f = 1 + l * 0.02;                         // ★ ±2% 塗刷不均
        A[i] = base[0] * f; A[i + 1] = base[1] * f; A[i + 2] = base[2] * f; A[i + 3] = 255;
        const grain = rn();                             // ★ 乳膠漆顆粒（per-texel）
        const pk = peel(u, v) * 0.62 + peel2(u, v) * 0.38;
        R[p] = 0.91 + (pk - 0.5) * 0.05 + (grain - 0.5) * 0.03 + l * 0.006;
        H[p] = clamp01(0.45 + (pk - 0.5) * 1.05 + (grain - 0.5) * 0.22);
      }
    }
    const m = make('wall.paint', {
      size: S, tile, A, R, H, heightMM: 0.02, repeat: [8, 4],   // ★ 橘皮只有 0.02mm
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
    inject(m, 'uniform float uGray;\nuniform float uSkirtH;',
      ['  float f = smoothstep( 0.0, uSkirtH, wp.y );',
        '  float dk = mix( 0.955, 1.0, f );',
        '  dk = mix( dk, 1.0, uGray );',
        '  diffuseColor.rgb *= dk;'].join('\n'),
      { uSkirtH: { value: 0.30 } });
    return m;
  };

  defs['ceiling'] = function () {
    const S = 256, tile = [1.2, 1.2];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const low = fbm(4201, 3, 3), peel = fbm(4202, 20, 3);
    const rn = mulberry32(4203);
    const base = hx(0xFAFAF8);
    const seamPx = 0.002 / tile[1] * S;                 // 2mm 板縫
    for (let y = 0; y < S; y++) {
      const v = y / S;
      const sd = Math.abs(frac(v * (tile[1] / 0.6)) - 0.0);   // 每 60cm 一道
      const seam = (Math.min(sd, 1 - sd) * S / (tile[1] / 0.6)) < seamPx ? 1 : 0;
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        const f = 1 + (low(u, v) - 0.5) * 0.026;
        let r8 = base[0] * f, g8 = base[1] * f, b8 = base[2] * f;
        let rough = 0.92 + (peel(u, v) - 0.5) * 0.04 + (rn() - 0.5) * 0.025;
        let h = 0.7 + (peel(u, v) - 0.5) * 0.5;
        if (seam) { r8 *= 0.90; g8 *= 0.90; b8 *= 0.90; rough = 0.95; h = 0.05; }
        A[i] = r8; A[i + 1] = g8; A[i + 2] = b8; A[i + 3] = 255;
        R[p] = rough; H[p] = clamp01(h);
      }
    }
    return make('ceiling', {
      size: S, tile, A, R, H, heightMM: 1.2, repeat: [8, 8],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
  };

  defs['skirting'] = function () {
    const S = 256, tile = [1.2, 0.12];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const grainN = fbm(4301, 40, 3), low = fbm(4302, 4, 3), scuffN = fbm(4304, 12, 3);
    const rn = mulberry32(4303);
    const base = hx(0xF4F4F1);
    for (let y = 0; y < S; y++) {
      const v = y / S;
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        const gr = Math.pow(1 - Math.abs(frac(v * 26 + (low(u, v) - 0.5) * 2.4) * 2 - 1), 3);
        const f = 1 + (low(u, v) - 0.5) * 0.02 - gr * 0.05;
        // 底部（v→0）踢腳鞋痕
        const scuff = (1 - smooth01(v / 0.35)) * Math.pow(scuffN(u, v), 2.0);
        A[i] = base[0] * f * (1 - scuff * 0.30);
        A[i + 1] = base[1] * f * (1 - scuff * 0.32);
        A[i + 2] = base[2] * f * (1 - scuff * 0.33);
        A[i + 3] = 255;
        R[p] = 0.60 + gr * 0.05 + (rn() - 0.5) * 0.03 + scuff * 0.14;
        H[p] = clamp01(0.75 - gr * 0.45 + (low(u, v) - 0.5) * 0.15);
      }
    }
    return make('skirting', {
      size: S, tile, A, R, H, heightMM: 0.12, repeat: [10, 1],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
  };

  defs['frame.wood'] = function () {
    const S = 256, tile = [0.6, 0.6];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const low = fbm(4401, 5, 3), warp = fbm(4402, 3, 2);
    const rn = mulberry32(4403);
    const base = hx(0xF5F5F3);
    for (let y = 0; y < S; y++) {
      const v = y / S;
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        const gr = Math.pow(1 - Math.abs(frac(v * 34 + (warp(u, v) - 0.5) * 3.0) * 2 - 1), 3.4);
        const f = 1 + (low(u, v) - 0.5) * 0.018 - gr * 0.035;
        A[i] = base[0] * f; A[i + 1] = base[1] * f; A[i + 2] = base[2] * f; A[i + 3] = 255;
        // ★ 邊角（貼圖四周）被摸得比較亮 0.45
        const edge = 1 - smooth01(Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v)) / 0.10);
        R[p] = lerp(0.55, 0.45, edge) + gr * 0.03 + (rn() - 0.5) * 0.02;
        H[p] = clamp01(0.7 - gr * 0.4);
      }
    }
    return make('frame.wood', {
      size: S, tile, A, R, H, heightMM: 0.05, repeat: [1, 1],
      physical: true,
      params: {
        roughness: 1.0, metalness: 0.0, color: 0xffffff,
        clearcoat: 0.15, clearcoatRoughness: 0.35,
      },
    });
  };

  defs['frame.glass'] = function () {
    const S = 256, tile = [0.6, 0.6];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const wave = fbm(4501, 4, 3), smudge = fbm(4502, 9, 3), dustN = valueNoise(4504, 64);
    const rn = mulberry32(4503);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, p = y * S + x, i = p * 4;
        const sm = Math.pow(clamp01((smudge(u, v) - 0.56) * 3.4), 1.6);   // 指紋／擦痕
        const dust = Math.pow(clamp01((dustN(u, v) - 0.72) * 4.0), 2.0);
        const c = 253 - sm * 6 - dust * 10;
        A[i] = c; A[i + 1] = c + 1; A[i + 2] = c + 2; A[i + 3] = 255;
        R[p] = 0.05 + sm * 0.10 + dust * 0.16 + (rn() - 0.5) * 0.006;
        H[p] = clamp01(0.5 + (wave(u, v) - 0.5) * 1.0 + sm * 0.15);
      }
    }
    return make('frame.glass', {
      size: S, tile, A, R, H, heightMM: 0.012, repeat: [1, 1],
      physical: true,
      params: {
        color: 0xffffff, roughness: 1.0, metalness: 0.0,
        transmission: 0.95, ior: 1.5, thickness: 0.003,
        transparent: false, side: T.FrontSide,
        envMapIntensity: 1.2, specularIntensity: 1.0,
      },
    });
  };

  /* ---------- 軌道燈具 ---------- */
  function bakeBrushedMetal(o) {
    const S = o.size;
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(o.seed);
    const low = fbm(o.seed + 3, 4, 3);
    const dustN = fbm(o.seed + 9, 6, 3);
    const fineN = valueNoise(o.seed + 21, 256);
    const c = hx(o.color);
    const streak = new Float32Array(S);
    for (let y = 0; y < S; y++) streak[y] = rn();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, p = y * S + x, i = p * 4;
        // 沿 u 的拉絲
        const st = (streak[y] - 0.5) * 2;
        const fineStreak = (fineN(u * 0.08, v) - 0.5);
        const f = 1 + st * 0.035 + (low(u, v) - 0.5) * 0.04;
        // ★ 灰塵：局部 Roughness 升到 dustRough
        const dz = o.dust ? Math.pow(clamp01((dustN(u, v) - 0.44) * 2.3), 1.4) : 0;
        A[i] = c[0] * f * (1 - dz * 0.10) + dz * 26;
        A[i + 1] = c[1] * f * (1 - dz * 0.10) + dz * 25;
        A[i + 2] = c[2] * f * (1 - dz * 0.10) + dz * 23;
        A[i + 3] = 255;
        let rough = o.rough + st * 0.05 + fineStreak * 0.05 + (low(u, v) - 0.5) * 0.03;
        if (o.dust) rough = lerp(rough, o.dustRough, dz);
        R[p] = rough;
        H[p] = clamp01(0.5 + st * 0.35 + fineStreak * 0.5 + (low(u, v) - 0.5) * 0.3);
      }
    }
    return { A, R, H, size: S };
  }

  defs['track.rail'] = function () {
    const b = bakeBrushedMetal({ size: 256, seed: 4601, color: 0x2A2A2C, rough: 0.35 });
    return make('track.rail', {
      size: b.size, tile: [1.0, 0.05], A: b.A, R: b.R, H: b.H, heightMM: 0.06,
      repeat: [6, 1],
      params: { roughness: 1.0, metalness: 0.85, color: 0xffffff, envMapIntensity: 1.0 },
    });
  };
  defs['track.head'] = function () {
    const b = bakeBrushedMetal({
      size: 256, seed: 4602, color: 0x1E1E20, rough: 0.30, dust: true, dustRough: 0.50,
    });
    return make('track.head', {
      size: b.size, tile: [0.24, 0.24], A: b.A, R: b.R, H: b.H, heightMM: 0.05,
      repeat: [1, 1],
      params: { roughness: 1.0, metalness: 0.90, color: 0xffffff, envMapIntensity: 1.0 },
    });
  };
  defs['track.reflector'] = function () {
    const S = 256, tile = [0.14, 0.14];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(4603);
    const cell = worley(4604, 26);                    // 反射杯的多面體格
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, p = y * S + x, i = p * 4;
        const w = cell(u, v);
        const facet = clamp01((w.f2 - w.f1) * 2.2);   // 面與面之間的稜線
        const c = 236 + w.id * 12;
        A[i] = c; A[i + 1] = c; A[i + 2] = c * 0.995; A[i + 3] = 255;
        R[p] = 0.08 + (1 - facet) * 0.06 + (rn() - 0.5) * 0.01;
        H[p] = clamp01(0.25 + facet * 0.75);
      }
    }
    return make('track.reflector', {
      size: S, tile, A, R, H, heightMM: 0.35, repeat: [1, 1],
      params: { roughness: 1.0, metalness: 0.95, color: 0xffffff, envMapIntensity: 1.4 },
    });
  };

  defs['bench.wood'] = function () {
    const b = bakeOak({
      size: 512, tile: [1.6, 0.45], plankW: 0.15, plankLen: 1.6,
      seed: 4701, wearLow: 0.33, wearHigh: 0.45, centerWear: 0.32,
    });
    return make('bench.wood', {
      size: b.size, tile: b.tile, A: b.A, R: b.R, H: b.H, heightMM: b.heightMM,
      repeat: [1, 1],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
  };

  defs['plinth'] = function () {
    const S = 256, tile = [1.0, 1.0];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const low = fbm(4801, 4, 3), micro = fbm(4802, 30, 2);
    const rn = mulberry32(4803);
    const base = hx(0xFAFAF7);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, p = y * S + x, i = p * 4;
        const f = 1 + (low(u, v) - 0.5) * 0.022;
        A[i] = base[0] * f; A[i + 1] = base[1] * f; A[i + 2] = base[2] * f; A[i + 3] = 255;
        R[p] = 0.75 + (micro(u, v) - 0.5) * 0.05 + (rn() - 0.5) * 0.03;
        H[p] = clamp01(0.6 + (micro(u, v) - 0.5) * 0.5);
      }
    }
    // ★ 邊角碰撞痕跡（貼圖四周 = 展台的稜線）
    const rk = mulberry32(4804);
    for (let k = 0; k < 26; k++) {
      const onX = rk() < 0.5;
      const t = rk();
      const nearStart = rk() < 0.5;
      const cx = onX ? t * S : (nearStart ? rk() * 6 : S - rk() * 6);
      const cy = onX ? (nearStart ? rk() * 6 : S - rk() * 6) : t * S;
      const r = 2 + rk() * 6;
      stampCircle(S, cx, cy, r, function (d, p) {
        const f = Math.pow(1 - d, 1.5);
        const i = p * 4;
        A[i] *= (1 - f * 0.10); A[i + 1] *= (1 - f * 0.11); A[i + 2] *= (1 - f * 0.12);
        R[p] = clamp01(R[p] + f * 0.14);
        H[p] = clamp01(H[p] - f * 0.55);
      });
    }
    return make('plinth', {
      size: S, tile, A, R, H, heightMM: 1.4, repeat: [1, 1],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
  };

  defs['label.card'] = function () {
    const S = 256, tile = [0.15, 0.10];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const fiber = fbm(4901, 60, 2), low = fbm(4902, 4, 2);
    const rn = mulberry32(4903);
    const base = hx(0xFAFAF8);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, p = y * S + x, i = p * 4;
        const fb = fiber(u, v) - 0.5;
        const f = 1 + (low(u, v) - 0.5) * 0.015 + fb * 0.012;
        A[i] = base[0] * f; A[i + 1] = base[1] * f; A[i + 2] = base[2] * f * 0.999; A[i + 3] = 255;
        R[p] = 0.90 + fb * 0.05 + (rn() - 0.5) * 0.03;
        H[p] = clamp01(0.5 + fb * 1.1 + (low(u, v) - 0.5) * 0.4);
      }
    }
    return make('label.card', {
      size: S, tile, A, R, H, heightMM: 0.06, repeat: [1, 1],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff, side: T.DoubleSide },
    });
  };

  /* ══════════════════════════════════════════════════════════════════
     廳二／三／五 · 戶外路面
     ══════════════════════════════════════════════════════════════════ */
  defs['asphalt'] = function () {
    const S = 1024, tile = [2.0, 2.0];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(5001);
    const QM = 512, QL = 256;
    const fMottle = bakeField(fbm(5002, 3, 4), QM);
    const fMid = bakeField(fbm(5003, 12, 3), QM);
    const fOil = bakeField(fbm(5004, 2, 3), QL);
    const fEdge = bakeField(fbm(5008, 2, 2), QL);
    const patchCell = worley(5005, 3);          // 修補區塊
    const agg = worley(5006, 256);              // ★ 骨材顆粒
    const aggFine = worley(5007, 420);
    const cLo = hx(0x4A4A4C), cHi = hx(0x6B6B6E);

    for (let y = 0; y < S; y++) {
      const v = y / S;
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        const mo = sampleField(fMottle, QM, u, v) * 0.6 + sampleField(fMid, QM, u, v) * 0.4;
        let t = clamp01((mo - 0.28) / 0.46);
        let r8 = lerp(cLo[0], cHi[0], t), g8 = lerp(cLo[1], cHi[1], t), b8 = lerp(cLo[2], cHi[2], t);

        // ★ 骨材：Worley 顆粒，顏色 #3A3A3C–#8A8A8C 隨機
        const w = agg(u, v);
        const grainShape = clamp01(1 - w.f1 / 0.62);
        const w2 = aggFine(u, v);
        const fineShape = clamp01(1 - w2.f1 / 0.55) * 0.55;
        const gShape = Math.max(grainShape, fineShape);
        const gTone = w.id;
        if (gShape > 0.02) {
          const gc = lerp(58, 138, gTone);
          const k = Math.pow(gShape, 0.7) * 0.82;
          r8 = lerp(r8, gc, k); g8 = lerp(g8, gc, k); b8 = lerp(b8, gc * 1.01, k);
        }

        // ★ 修補痕：不規則多邊形區塊 + 黑色接縫
        const pw = patchCell(u, v);
        const patchIn = pw.id > 0.62 ? 1 : 0;
        const patchEdge = clamp01(1 - (pw.f2 - pw.f1) * 9.0);
        if (patchIn) { r8 *= 0.86; g8 *= 0.86; b8 *= 0.87; }
        if (patchEdge > 0.001) {
          const k = Math.pow(patchEdge, 2.2) * 0.85;
          r8 = lerp(r8, 30, k); g8 = lerp(g8, 30, k); b8 = lerp(b8, 32, k);
        }

        // ★ 輪胎痕：沿 u（行車方向）兩條略深長條
        const lane1 = Math.exp(-Math.pow((v - 0.30) / 0.085, 2));
        const lane2 = Math.exp(-Math.pow((v - 0.72) / 0.085, 2));
        const tire = clamp01((lane1 + lane2) * (0.6 + 0.4 * sampleField(fMid, QM, u * 0.3, v)));

        // ★ 油漬：深色不規則斑塊
        const oil = Math.pow(clamp01((sampleField(fOil, QL, u, v) - 0.615) * 4.6), 1.5);
        if (oil > 0.001) {
          const k = oil * 0.9;
          r8 = lerp(r8, 42, k); g8 = lerp(g8, 42, k); b8 = lerp(b8, 44, k);
        }
        if (tire > 0.001) { const k = tire * 0.16; r8 *= (1 - k); g8 *= (1 - k); b8 *= (1 - k); }

        A[i] = r8; A[i + 1] = g8; A[i + 2] = b8; A[i + 3] = 255;

        // Roughness：基準 0.88 / 輪胎 0.72 / 油漬 0.55 / 邊緣 0.93
        let rough = 0.88 + (rn() - 0.5) * 0.03 - gShape * 0.02;
        rough = lerp(rough, 0.72, tire * 0.85);
        rough = lerp(rough, 0.55, oil);
        rough = lerp(rough, 0.93, Math.pow(clamp01((sampleField(fEdge, QL, u, v) - 0.6) * 3.0), 1.5) * 0.7);
        R[p] = rough;

        // Height：base 0.45（heightMM=4）→ 骨材凸起最多 2mm
        H[p] = clamp01(0.45 + Math.pow(gShape, 0.75) * 0.50 - patchEdge * 0.30 * Math.pow(patchEdge, 1.5));
      }
    }
    // ★ 裂縫（深 4mm → 打到 0）
    const rk = mulberry32(5009);
    for (let c = 0; c < 22; c++) {
      let x = rk() * S, y = rk() * S;
      let ang = rk() * Math.PI * 2;
      const segs = 5 + Math.floor(rk() * 8);
      for (let s = 0; s < segs; s++) {
        const len = 12 + rk() * 46;
        const nx = x + Math.cos(ang) * len, ny = y + Math.sin(ang) * len;
        const rad = 1.0 + rk() * 1.6;
        stampLine(S, x, y, nx, ny, rad, function (d, p) {
          const f = Math.pow(1 - d, 1.2);
          const i = p * 4;
          A[i] = lerp(A[i], 26, f * 0.9); A[i + 1] = lerp(A[i + 1], 26, f * 0.9); A[i + 2] = lerp(A[i + 2], 28, f * 0.9);
          R[p] = clamp01(lerp(R[p], 0.95, f));
          H[p] = clamp01(H[p] - f * 0.45);
        });
        x = nx; y = ny; ang += (rk() - 0.5) * 1.1;
      }
    }
    return make('asphalt', {
      size: S, tile, A, R, H, heightMM: 4.0, repeat: [10, 10],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
  };

  defs['roadline'] = function () {
    const S = 512, tile = [1.0, 0.14];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(5101);
    const edgeN = fbm(5102, 24, 3);       // 邊緣不整齊
    const chipN = fbm(5103, 14, 3);       // 剝落
    const wearN = fbm(5104, 6, 3);
    const grainN = fbm(5105, 40, 2);
    const cPaint = hx(0xE8E6E0), cWorn = hx(0xB8B6B0), cAsp = hx(0x4A4A4C);
    for (let y = 0; y < S; y++) {
      const v = y / S;
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        // 邊緣 2–5mm 的不規則（tile v = 0.14m）
        const e0 = 0.014 + (edgeN(u, 0.12) - 0.5) * 0.05;
        const e1 = 1 - (0.014 + (edgeN(u, 0.88) - 0.5) * 0.05);
        const inPaint = (v > e0 && v < e1) ? 1 : 0;
        const chip = Math.pow(clamp01((chipN(u, v) - 0.60) * 4.2), 1.3);
        const worn = clamp01((1 - Math.abs(v - 0.5) * 2.6) * (0.45 + 0.55 * wearN(u, v)));
        const gr = grainN(u, v) - 0.5;
        if (inPaint && chip < 0.55) {
          const k = worn * 0.85;
          A[i] = lerp(cPaint[0], cWorn[0], k) * (1 + gr * 0.03);
          A[i + 1] = lerp(cPaint[1], cWorn[1], k) * (1 + gr * 0.03);
          A[i + 2] = lerp(cPaint[2], cWorn[2], k) * (1 + gr * 0.03);
          R[p] = lerp(0.75, 0.88, chip / 0.55 * 0.6 + worn * 0.25) + (rn() - 0.5) * 0.03;
          H[p] = clamp01(1.0 - chip * 0.7 - Math.abs(gr) * 0.15);
        } else {
          A[i] = cAsp[0] * (1 + gr * 0.10); A[i + 1] = cAsp[1] * (1 + gr * 0.10); A[i + 2] = cAsp[2] * (1 + gr * 0.10);
          R[p] = 0.88 + (rn() - 0.5) * 0.04;
          H[p] = clamp01(0.06 + gr * 0.12);
        }
        A[i + 3] = 255;
      }
    }
    return make('roadline', {
      size: S, tile, A, R, H, heightMM: 0.8, repeat: [6, 1],   // ★ 白線是凸起的
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 },
    });
  };

  defs['concrete.wall'] = function () {
    const S = 512, tile = [1.2, 1.2];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(5201);
    const low = fbm(5202, 3, 4), mid = fbm(5203, 14, 3), fine = fbm(5204, 48, 2);
    const cLo = hx(0x9A968E), cHi = hx(0xB8B5AE);
    const seamEvery = tile[1] / 0.6;                    // 每 60cm 一道模板痕
    const seamPx = 0.004 / tile[1] * S;
    for (let y = 0; y < S; y++) {
      const v = y / S;
      const sPos = frac(v * seamEvery);
      const dSeam = Math.min(sPos, 1 - sPos) * S / seamEvery;
      const seam = clamp01(1 - dSeam / seamPx);
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        const t = clamp01((low(u, v) * 0.65 + mid(u, v) * 0.35 - 0.25) / 0.5);
        let r8 = lerp(cLo[0], cHi[0], t), g8 = lerp(cLo[1], cHi[1], t), b8 = lerp(cLo[2], cHi[2], t);
        const f = 1 + (fine(u, v) - 0.5) * 0.04;
        r8 *= f; g8 *= f; b8 *= f;
        if (seam > 0) { const k = seam * 0.72; r8 *= (1 - k * 0.22); g8 *= (1 - k * 0.22); b8 *= (1 - k * 0.23); }
        A[i] = r8; A[i + 1] = g8; A[i + 2] = b8; A[i + 3] = 255;
        R[p] = 0.92 + (fine(u, v) - 0.5) * 0.05 + (rn() - 0.5) * 0.03;
        H[p] = clamp01(0.85 + (low(u, v) - 0.5) * 0.20 + (fine(u, v) - 0.5) * 0.10 - seam * 0.60);
      }
    }
    // ★ 水漬流痕：模板痕下方由上而下的深色垂直條紋
    const rw = mulberry32(5205);
    const nSeams = Math.round(seamEvery);
    for (let s = 0; s < nSeams; s++) {
      const y0 = (s / seamEvery) * S;
      const count = 6 + Math.floor(rw() * 7);
      for (let k = 0; k < count; k++) {
        const cx = rw() * S;
        const wpx = 2 + rw() * 9;
        const len = (0.15 + rw() * 0.55) * S / seamEvery;
        const strength = 0.20 + rw() * 0.35;
        for (let dy = 0; dy < len; dy++) {
          const yy = Math.floor((y0 + dy) % S);
          const fade = (1 - dy / len) * strength;
          for (let dx = -Math.ceil(wpx); dx <= Math.ceil(wpx); dx++) {
            const xx = ((Math.floor(cx + dx) % S) + S) % S;
            const fx = 1 - Math.abs(dx) / wpx;
            if (fx <= 0) continue;
            const pp = yy * S + xx, ii = pp * 4;
            const kk = fade * fx * fx;
            A[ii] *= (1 - kk * 0.30); A[ii + 1] *= (1 - kk * 0.29); A[ii + 2] *= (1 - kk * 0.27);
            R[pp] = lerp(R[pp], 0.78, kk);          // 水漬處 0.78
          }
        }
      }
    }
    // ★ 氣泡孔：直徑 4–12mm，密度 ~55 / m²
    const rb = mulberry32(5206);
    const areaM2 = tile[0] * tile[1];
    const nB = Math.round(55 * areaM2);
    for (let k = 0; k < nB; k++) {
      const cx = rb() * S, cy = rb() * S;
      const dmm = 4 + rb() * 8;
      const r = (dmm * 0.001) / tile[0] * S * 0.5;
      stampCircle(S, cx, cy, Math.max(1.2, r), function (d, p) {
        const f = Math.pow(1 - d, 0.6);
        const i = p * 4;
        A[i] *= (1 - f * 0.34); A[i + 1] *= (1 - f * 0.34); A[i + 2] *= (1 - f * 0.33);
        R[p] = clamp01(R[p] + f * 0.05);
        H[p] = clamp01(H[p] - f * 0.72);
      });
    }
    const m = make('concrete.wall', {
      size: S, tile, A, R, H, heightMM: 5.0, repeat: [6, 3],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
    // ★ 世界座標：底部 40cm 積污泛黑、80–140cm 高度 0.85
    inject(m, 'uniform float uGray;\nuniform float uGrimeH;',
      ['  float g = 1.0 - smoothstep( 0.06, uGrimeH, wp.y );',
        '  float dk = mix( 1.0, 0.60, g );',
        '  dk = mix( dk, 1.0, uGray );',
        '  diffuseColor.rgb *= dk;',
        '  roughnessFactor = mix( roughnessFactor, 0.95, g * 0.8 );',
        '  float band = exp( - pow( ( wp.y - 1.10 ) / 0.42, 2.0 ) );',
        '  roughnessFactor = mix( roughnessFactor, 0.85, band * 0.55 );'].join('\n'),
      { uGrimeH: { value: 0.40 } });
    return m;
  };

  defs['curb'] = function () {
    const S = 256, tile = [1.0, 0.30];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(5301);
    const low = fbm(5302, 4, 3);
    const grain = worley(5303, 96);              // 石材顆粒 ~1mm 級
    const base = hx(0xC8C4BC);
    for (let y = 0; y < S; y++) {
      const v = y / S;
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        const w = grain(u, v);
        const gs = clamp01(1 - w.f1 / 0.7);
        const f = 1 + (low(u, v) - 0.5) * 0.06 + (w.id - 0.5) * 0.07 - gs * 0.03;
        A[i] = base[0] * f; A[i + 1] = base[1] * f; A[i + 2] = base[2] * f; A[i + 3] = 255;
        // 頂面（v > 0.72）比較光、比較常被輾
        const top = smooth01((v - 0.72) / 0.18);
        R[p] = lerp(0.85, 0.70, top) + (rn() - 0.5) * 0.04 - gs * 0.02;
        H[p] = clamp01(0.55 + gs * 0.45 + (low(u, v) - 0.5) * 0.2);
      }
    }
    // 擦撞露白色新斷面
    const rs = mulberry32(5304);
    for (let k = 0; k < 14; k++) {
      const cx = rs() * S, cy = (0.55 + rs() * 0.45) * S;
      stampCircle(S, cx, cy, 4 + rs() * 12, function (d, p) {
        const f = Math.pow(1 - d, 1.1);
        const i = p * 4;
        A[i] = lerp(A[i], 236, f * 0.8); A[i + 1] = lerp(A[i + 1], 233, f * 0.8); A[i + 2] = lerp(A[i + 2], 226, f * 0.8);
        R[p] = clamp01(R[p] + f * 0.06);
        H[p] = clamp01(H[p] - f * 0.35);
      });
    }
    // 頂面黑色橡膠殘留
    for (let k = 0; k < 18; k++) {
      const x0 = rs() * S, y0 = (0.74 + rs() * 0.24) * S;
      stampLine(S, x0, y0, x0 + 8 + rs() * 40, y0 + (rs() - 0.5) * 6, 2 + rs() * 4, function (d, p) {
        const f = Math.pow(1 - d, 1.6) * 0.8;
        const i = p * 4;
        A[i] = lerp(A[i], 34, f); A[i + 1] = lerp(A[i + 1], 33, f); A[i + 2] = lerp(A[i + 2], 34, f);
        R[p] = lerp(R[p], 0.62, f);
      });
    }
    return make('curb', {
      size: S, tile, A, R, H, heightMM: 1.0, repeat: [8, 1],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
  };

  /* ---------- 隧道磁磚（tunnel.tile / tunnel.grime 共用） ---------- */
  function bakeTunnelTile(o) {
    const S = o.size, tile = o.tile;
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(o.seed);
    const nTile = Math.round(tile[0] / 0.20);            // 20×20cm
    const cellPx = S / nTile;
    const groutPx = Math.max(1.0, 0.003 / tile[0] * S);  // 3mm 縫
    const bevelPx = Math.max(1.0, 0.0015 / tile[0] * S);
    const grimeN = fbm(o.seed + 5, 5, 4);
    const stainN = fbm(o.seed + 11, 3, 3);
    const fineN = fbm(o.seed + 17, 40, 2);
    const base = hx(o.base), grout = hx(o.grout);
    const tone = [];
    for (let k = 0; k < nTile * nTile; k++) tone.push((rn() - 0.5) * 0.06);   // ★ 每片 ±3%
    for (let y = 0; y < S; y++) {
      const v = y / S;
      const ty = Math.floor(y / cellPx);
      const dy = Math.min(y - ty * cellPx, (ty + 1) * cellPx - y);
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        const tx = Math.floor(x / cellPx);
        const dx = Math.min(x - tx * cellPx, (tx + 1) * cellPx - x);
        const d = Math.min(dx, dy);
        const isGrout = d < groutPx;
        const bevel = clamp01((d - groutPx) / bevelPx);
        const tf = 1 + tone[(ty % nTile) * nTile + (tx % nTile)];
        const grime = Math.pow(clamp01((grimeN(u, v) - 0.42) * 1.9), 1.3) * o.grime;
        // 燈具正下方的黃褐色長期光照漬
        const stain = Math.pow(clamp01((stainN(u, v) - 0.60) * 3.4), 1.4) * o.stain;
        let r8, g8, b8, rough, h;
        if (isGrout) {
          const gk = 1 - clamp01(d / groutPx) * 0.35;
          r8 = grout[0] * gk; g8 = grout[1] * gk; b8 = grout[2] * gk;
          // ★ 縫隙積黑污
          const dirt = clamp01(0.35 + grime * 1.1);
          r8 = lerp(r8, 26, dirt); g8 = lerp(g8, 25, dirt); b8 = lerp(b8, 24, dirt);
          rough = 0.90 + (rn() - 0.5) * 0.04;
          h = 0.0;
        } else {
          r8 = base[0] * tf; g8 = base[1] * tf; b8 = base[2] * tf;
          r8 = lerp(r8, 196, stain * 0.55); g8 = lerp(g8, 166, stain * 0.55); b8 = lerp(b8, 112, stain * 0.55);
          r8 = lerp(r8, 74, grime * 0.55); g8 = lerp(g8, 73, grime * 0.55); b8 = lerp(b8, 70, grime * 0.55);
          const f = 1 + (fineN(u, v) - 0.5) * 0.03;
          r8 *= f; g8 *= f; b8 *= f;
          rough = lerp(o.roughTile, 0.86, grime * 0.85) + (fineN(u, v) - 0.5) * 0.04 + (rn() - 0.5) * 0.02;
          rough = lerp(rough, 0.55, stain * 0.4);
          h = 0.35 + bevel * 0.65 + (fineN(u, v) - 0.5) * 0.03;
        }
        A[i] = r8; A[i + 1] = g8; A[i + 2] = b8; A[i + 3] = 255;
        R[p] = rough; H[p] = clamp01(h);
      }
    }
    return { A, R, H, size: S, tile };
  }

  defs['tunnel.tile'] = function () {
    const b = bakeTunnelTile({
      size: 512, tile: [1.2, 1.2], seed: 5401,
      base: 0xDCD8D0, grout: 0x8A867E, roughTile: 0.35, grime: 0.55, stain: 0.85,
    });
    const m = make('tunnel.tile', {
      size: b.size, tile: b.tile, A: b.A, R: b.R, H: b.H, heightMM: 2.0, repeat: [8, 3],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
    // ★ 世界座標：底部 60cm 車輛廢氣灰黑漬
    inject(m, 'uniform float uGray;\nuniform float uExhaustH;',
      ['  float g = 1.0 - smoothstep( 0.05, uExhaustH, wp.y );',
        '  float dk = mix( 1.0, 0.46, g );',
        '  dk = mix( dk, 1.0, uGray );',
        '  diffuseColor.rgb *= dk;',
        '  roughnessFactor = mix( roughnessFactor, 0.82, g * 0.9 );'].join('\n'),
      { uExhaustH: { value: 0.60 } });
    return m;
  };

  defs['tunnel.grime'] = function () {
    const b = bakeTunnelTile({
      size: 512, tile: [1.2, 1.2], seed: 5402,
      base: 0x8F8A82, grout: 0x4E4B46, roughTile: 0.48, grime: 1.0, stain: 0.35,
    });
    const m = make('tunnel.grime', {
      size: b.size, tile: b.tile, A: b.A, R: b.R, H: b.H, heightMM: 2.0, repeat: [8, 1.4],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
    inject(m, 'uniform float uGray;\nuniform float uExhaustH;',
      ['  float g = 1.0 - smoothstep( 0.05, uExhaustH, wp.y );',
        '  float dk = mix( 1.0, 0.40, g );',
        '  dk = mix( dk, 1.0, uGray );',
        '  diffuseColor.rgb *= dk;',
        '  roughnessFactor = mix( roughnessFactor, 0.88, g * 0.9 );'].join('\n'),
      { uExhaustH: { value: 0.75 } });
    return m;
  };

  defs['kerb.redwhite'] = function () {
    const S = 512, tile = [1.0, 0.50];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(5501);
    const low = fbm(5502, 5, 3), blur = fbm(5503, 12, 3), rub = fbm(5504, 4, 3);
    const cR = hx(0xC4413A), cW = hx(0xE8E4DC), cC = hx(0xB9B5AC);   // 磨到露出水泥
    const steps = 4;                                                  // ★ 階梯狀凸起
    for (let y = 0; y < S; y++) {
      const v = y / S;
      const sPos = v * steps;
      const si = Math.floor(sPos);
      const sf = sPos - si;
      const riser = smooth01(sf / 0.14);                              // 8px 左右的斜面
      const stepH = (si + riser) / steps;
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        // 紅白各 0.5m（tile u = 1.0m）
        const band = frac(u + (blur(u, v) - 0.5) * 0.04);
        const isRed = band < 0.5;
        const edgeSoft = 1 - smooth01(Math.abs(Math.abs(band - 0.5) - 0.25) / 0.03);
        let c = isRed ? cR : cW;
        let r8 = c[0], g8 = c[1], b8 = c[2];
        if (edgeSoft > 0) {                                           // ★ 條紋邊緣模糊
          const o = isRed ? cW : cR;
          r8 = lerp(r8, (r8 + o[0]) * 0.5, edgeSoft * 0.8);
          g8 = lerp(g8, (g8 + o[1]) * 0.5, edgeSoft * 0.8);
          b8 = lerp(b8, (b8 + o[2]) * 0.5, edgeSoft * 0.8);
        }
        // ★ 階梯頂端（sf 大）被磨到露出水泥
        const worn = clamp01(Math.pow(sf, 2.0) * (0.4 + 0.6 * low(u, v)));
        r8 = lerp(r8, cC[0], worn * 0.75); g8 = lerp(g8, cC[1], worn * 0.75); b8 = lerp(b8, cC[2], worn * 0.75);
        // ★ 彎道內側橡膠殘留
        const rubber = Math.pow(clamp01((rub(u, v) - 0.5) * 2.6), 1.4);
        r8 = lerp(r8, 38, rubber * 0.6); g8 = lerp(g8, 37, rubber * 0.6); b8 = lerp(b8, 38, rubber * 0.6);
        const f = 1 + (low(u, v) - 0.5) * 0.05;
        A[i] = r8 * f; A[i + 1] = g8 * f; A[i + 2] = b8 * f; A[i + 3] = 255;
        R[p] = lerp(0.72, 0.88, worn) + (rn() - 0.5) * 0.035 - rubber * 0.06;
        H[p] = clamp01(stepH * 0.92 + (low(u, v) - 0.5) * 0.03);
      }
    }
    return make('kerb.redwhite', {
      size: S, tile, A, R, H, heightMM: 40.0, repeat: [6, 1],   // ★ 每階 3–5cm
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
  };

  /* ---------- 護欄（水泥 / 金屬） ---------- */
  function bakeBarrier(o) {
    const S = o.size, tile = o.tile;
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(o.seed);
    const low = fbm(o.seed + 3, 4, 3), mid = fbm(o.seed + 7, 16, 3), mud = fbm(o.seed + 13, 5, 3);
    const base = hx(o.color);
    for (let y = 0; y < S; y++) {
      const v = y / S;
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        const f = 1 + (low(u, v) - 0.5) * o.mottle + (mid(u, v) - 0.5) * o.mottle * 0.5;
        let r8 = base[0] * f, g8 = base[1] * f, b8 = base[2] * f;
        // ★ 底部泥污（v→0）
        const m = (1 - smooth01(v / 0.30)) * Math.pow(clamp01(mud(u, v) + 0.15), 1.3);
        r8 = lerp(r8, 104, m * 0.62); g8 = lerp(g8, 92, m * 0.62); b8 = lerp(b8, 74, m * 0.62);
        A[i] = r8; A[i + 1] = g8; A[i + 2] = b8; A[i + 3] = 255;
        R[p] = o.rough + (mid(u, v) - 0.5) * 0.06 + (rn() - 0.5) * 0.03 + m * 0.10;
        H[p] = clamp01(0.6 + (mid(u, v) - 0.5) * o.relief + (low(u, v) - 0.5) * 0.25);
      }
    }
    // ★ 輪胎擦撞的黑色痕跡（集中在中段高度）
    const rs = mulberry32(o.seed + 91);
    for (let k = 0; k < o.scuffs; k++) {
      const y0 = (0.30 + rs() * 0.45) * S;
      const x0 = rs() * S;
      const len = 20 + rs() * 0.35 * S;
      stampLine(S, x0, y0, x0 + len, y0 + (rs() - 0.5) * 0.06 * S, 2 + rs() * 7, function (d, p, t) {
        const f = Math.pow(1 - d, 1.5) * (0.35 + 0.65 * Math.sin(Math.PI * t)) * 0.9;
        const i = p * 4;
        A[i] = lerp(A[i], 32, f); A[i + 1] = lerp(A[i + 1], 31, f); A[i + 2] = lerp(A[i + 2], 32, f);
        R[p] = lerp(R[p], 0.58, f);
      });
    }
    return { A, R, H, size: S, tile };
  }

  defs['barrier.concrete'] = function () {
    const b = bakeBarrier({
      size: 512, tile: [2.0, 1.0], seed: 5601, color: 0xE4E2DC,
      rough: 0.90, mottle: 0.07, relief: 0.5, scuffs: 16,
    });
    return make('barrier.concrete', {
      size: b.size, tile: b.tile, A: b.A, R: b.R, H: b.H, heightMM: 2.5, repeat: [4, 1],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
  };
  defs['barrier.metal'] = function () {
    const b = bakeBarrier({
      size: 256, tile: [2.0, 0.5], seed: 5602, color: 0xC8C8CA,
      rough: 0.45, mottle: 0.05, relief: 0.35, scuffs: 14,
    });
    return make('barrier.metal', {
      size: b.size, tile: b.tile, A: b.A, R: b.R, H: b.H, heightMM: 0.8, repeat: [4, 1],
      params: { roughness: 1.0, metalness: 0.70, color: 0xffffff, envMapIntensity: 1.0 },
    });
  };

  defs['grass.blade'] = function () {
    const S = 256, tile = [0.05, 0.20];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(5701);
    const colN = fbm(5702, 8, 3), ribN = fbm(5703, 30, 2);
    const cLo = hx(0x6B8A4A), cHi = hx(0x8AA55C);
    for (let y = 0; y < S; y++) {
      const v = y / S;                                   // 0 = 根、1 = 尖
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        const t = clamp01(colN(u, v) * 0.55 + v * 0.5);
        const shade = lerp(0.72, 1.06, smooth01(v * 1.15));   // 根部較暗
        let r8 = lerp(cLo[0], cHi[0], t) * shade;
        let g8 = lerp(cLo[1], cHi[1], t) * shade;
        let b8 = lerp(cLo[2], cHi[2], t) * shade;
        const rib = Math.pow(1 - Math.abs(u * 2 - 1), 2.0);   // 中脈
        r8 *= (1 - rib * 0.05); g8 *= (1 + rib * 0.03); b8 *= (1 - rib * 0.04);
        A[i] = r8; A[i + 1] = g8; A[i + 2] = b8; A[i + 3] = 255;
        R[p] = 0.74 - rib * 0.10 + (ribN(u, v) - 0.5) * 0.06 + (rn() - 0.5) * 0.03;
        H[p] = clamp01(0.35 + rib * 0.55 + (ribN(u, v) - 0.5) * 0.10);
      }
    }
    return make('grass.blade', {
      size: S, tile, A, R, H, heightMM: 0.4, repeat: [1, 1],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff, side: T.DoubleSide },
    });
  };

  defs['soil'] = function () {
    const S = 256, tile = [1.0, 1.0];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(5801);
    const low = fbm(5802, 4, 4), clod = worley(5803, 40), grit = worley(5804, 130);
    const base = hx(0x6A5A4A);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, p = y * S + x, i = p * 4;
        const c = clod(u, v);
        const cs = clamp01(1 - c.f1 / 0.72);
        const g = grit(u, v);
        const gs = clamp01(1 - g.f1 / 0.6);
        const f = 1 + (low(u, v) - 0.5) * 0.16 + (c.id - 0.5) * 0.14 + gs * 0.10;
        A[i] = base[0] * f; A[i + 1] = base[1] * f; A[i + 2] = base[2] * f; A[i + 3] = 255;
        R[p] = 0.95 + (rn() - 0.5) * 0.04 - gs * 0.03;
        H[p] = clamp01(0.35 + cs * 0.45 + gs * 0.20 + (low(u, v) - 0.5) * 0.25);
      }
    }
    return make('soil', {
      size: S, tile, A, R, H, heightMM: 6.0, repeat: [8, 8],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
  };

  /* ---------- 天空（ShaderMaterial，雲會動） ---------- */
  defs['sky'] = function () {
    const S = 256;
    const F = fieldOf(S);
    const n = fbm(6001, 4, 6, 0.55);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) F[y * S + x] = n(x / S, y / S);
    }
    const cloudTex = toTex(fieldToCanvas(F, S), false, [1, 1]);
    const uni = {
      uTop: { value: new T.Color(0x7FB2E0) },
      uHorizon: { value: new T.Color(0xD8E8F5) },
      uHaze: { value: new T.Color(0xE9EFF3) },
      uClouds: { value: cloudTex },
      uTime: { value: 0 },
      uGray: { value: gray ? 1 : 0 },
    };
    const vs = [
      'varying vec3 vDir;',
      'void main() {',
      '  vDir = normalize( position );',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );',
      '}',
    ].join('\n');
    const fs = [
      'uniform vec3 uTop;', 'uniform vec3 uHorizon;', 'uniform vec3 uHaze;',
      'uniform sampler2D uClouds;', 'uniform float uTime;', 'uniform float uGray;',
      'varying vec3 vDir;',
      'void main() {',
      '  vec3 d = normalize( vDir );',
      '  float h = clamp( d.y, -1.0, 1.0 );',
      // ★ 地平線一定比天頂淺
      '  vec3 col = mix( uHorizon, uTop, pow( clamp( h, 0.0, 1.0 ), 0.55 ) );',
      // ★ 地平線附近極輕微霧霾
      '  col = mix( col, uHaze, exp( - max( h, 0.0 ) * 8.5 ) * 0.5 );',
      '  float hh = max( h, 0.05 );',
      '  vec2 uv = d.xz / hh * 0.14;',
      // ★ 兩層緩慢移動的雲（週期 > 280 秒）
      '  float c1 = texture2D( uClouds, uv * 0.5 + vec2( uTime * 0.0032, uTime * 0.0011 ) ).r;',
      '  float c2 = texture2D( uClouds, uv * 1.17 + vec2( - uTime * 0.0017, uTime * 0.0026 ) ).r;',
      '  float cl = clamp( ( c1 * 0.66 + c2 * 0.44 - 0.44 ) * 2.7, 0.0, 1.0 );',
      '  cl *= smoothstep( 0.0, 0.17, h );',
      '  vec3 cloudCol = mix( vec3( 0.70, 0.72, 0.77 ), vec3( 1.0, 0.99, 0.97 ), cl );',
      '  col = mix( col, cloudCol, cl * 0.86 );',
      '  col = mix( col, vec3( 0.5 ), uGray );',
      '  gl_FragColor = vec4( col, 1.0 );',
      '  #include <tonemapping_fragment>',
      '  #include <colorspace_fragment>',
      '}',
    ].join('\n');
    const m = new T.ShaderMaterial({
      uniforms: uni, vertexShader: vs, fragmentShader: fs,
      side: T.BackSide, depthWrite: false, fog: false,
    });
    m.name = 'sky';
    m.userData.tileMeters = { x: 1, y: 1 };
    m.userData.update = function (t) { uni.uTime.value = t; };
    m.userData.wear = uni;
    injected.push(uni);
    texRec.set('sky', { map: cloudTex, roughnessMap: null, normalMap: null, aoMap: null });
    return m;
  };

  /* ══════════════════════════════════════════════════════════════════
     廳六 · 法庭 ／ 其他道具
     ══════════════════════════════════════════════════════════════════ */
  function bakeTerrazzo(o) {
    const S = o.size, tile = o.tile;
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(o.seed);
    const chips = worley(o.seed + 3, o.chipCells);
    const fineChips = worley(o.seed + 5, o.chipCells * 2.2);
    const low = fbm(o.seed + 9, 3, 3);
    const base = hx(o.base);
    for (let y = 0; y < S; y++) {
      const v = y / S;
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        const w = chips(u, v);
        const cs = clamp01(1 - w.f1 / 0.66);
        const w2 = fineChips(u, v);
        const cs2 = clamp01(1 - w2.f1 / 0.55) * 0.6;
        const f = 1 + (low(u, v) - 0.5) * o.mottle;
        let r8 = base[0] * f, g8 = base[1] * f, b8 = base[2] * f;
        if (cs > 0.02) {
          const tone = w.id;
          const cc = lerp(o.chipLo, o.chipHi, tone);
          const k = Math.pow(cs, 0.6) * 0.8;
          r8 = lerp(r8, cc, k); g8 = lerp(g8, cc * 0.995, k); b8 = lerp(b8, cc * 0.985, k);
        }
        if (cs2 > 0.02) {
          const cc2 = lerp(o.chipLo, o.chipHi, w2.id);
          r8 = lerp(r8, cc2, cs2 * 0.5); g8 = lerp(g8, cc2, cs2 * 0.5); b8 = lerp(b8, cc2, cs2 * 0.5);
        }
        A[i] = r8; A[i + 1] = g8; A[i + 2] = b8; A[i + 3] = 255;
        // ★ 邊緣被踩踏處更亮（貼圖四周）
        const edge = 1 - smooth01(Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v)) / 0.12);
        R[p] = lerp(o.rough, o.roughEdge, edge) + (low(u, v) - 0.5) * 0.05 + (rn() - 0.5) * 0.03 - cs * 0.03;
        H[p] = clamp01(0.55 + cs * 0.30 + cs2 * 0.18 + (low(u, v) - 0.5) * 0.20);
      }
    }
    return { A, R, H, size: S, tile };
  }

  defs['court.platform'] = function () {
    const b = bakeTerrazzo({
      size: 512, tile: [2.0, 2.0], seed: 6101, base: 0xFAFAF7,
      chipCells: 70, chipLo: 196, chipHi: 246, mottle: 0.03, rough: 0.68, roughEdge: 0.50,
    });
    return make('court.platform', {
      size: b.size, tile: b.tile, A: b.A, R: b.R, H: b.H, heightMM: 1.0, repeat: [1, 1],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
  };
  defs['court.stone'] = function () {
    const b = bakeTerrazzo({
      size: 512, tile: [1.2, 1.2], seed: 6102, base: 0xE6E4DE,
      chipCells: 55, chipLo: 150, chipHi: 226, mottle: 0.06, rough: 0.70, roughEdge: 0.54,
    });
    return make('court.stone', {
      size: b.size, tile: b.tile, A: b.A, R: b.R, H: b.H, heightMM: 1.2, repeat: [5, 5],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
  };

  defs['chainlink'] = function () {
    const S = 256, tile = [0.30, 0.30];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S), AL = fieldOf(S);
    const rn = mulberry32(6201);
    const spangle = worley(6202, 26);
    const rust = fbm(6203, 6, 3);
    const N = tile[0] / 0.05;                 // 5cm 網目
    const wpx = 0.055;                        // 線徑（相對格距）
    for (let y = 0; y < S; y++) {
      const v = y / S;
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        const a = frac((u + v) * N), b2 = frac((u - v) * N);
        const da = Math.min(a, 1 - a), db = Math.min(b2, 1 - b2);
        const d = Math.min(da, db);
        const wire = clamp01(1 - d / wpx);
        AL[p] = wire > 0.06 ? 1 : 0;
        const round = Math.pow(wire, 0.5);           // 圓線的明暗
        const sp = spangle(u, v);
        const sk = 0.9 + (sp.id - 0.5) * 0.22 + clamp01(1 - sp.f1 / 0.7) * 0.10;
        const rs = Math.pow(clamp01((rust(u, v) - 0.66) * 3.2), 1.6);
        let c = 172 * sk * (0.72 + 0.32 * round);
        A[i] = lerp(c, 128, rs); A[i + 1] = lerp(c * 0.99, 92, rs); A[i + 2] = lerp(c * 0.97, 66, rs); A[i + 3] = 255;
        R[p] = 0.50 + (sp.id - 0.5) * 0.10 + rs * 0.35 + (rn() - 0.5) * 0.03 - round * 0.05;
        H[p] = clamp01(round);
      }
    }
    return make('chainlink', {
      size: S, tile, A, R, H, AL, heightMM: 3.0, repeat: [8, 4],
      params: {
        roughness: 1.0, metalness: 0.65, color: 0xffffff,
        transparent: false, alphaTest: 0.45, side: T.DoubleSide, depthWrite: true,
      },
    });
  };

  defs['lightpole'] = function () {
    const S = 256, tile = [0.40, 2.0];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(6301);
    const spangle = worley(6302, 18);          // 鍍鋅結晶
    const drip = fbm(6303, 5, 3);
    const low = fbm(6304, 3, 2);
    const base = hx(0xB9BCBE);
    for (let y = 0; y < S; y++) {
      const v = y / S;
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        const sp = spangle(u, v);
        const cr = clamp01(1 - sp.f1 / 0.75);
        const f = 0.94 + (sp.id - 0.5) * 0.14 + cr * 0.08 + (low(u, v) - 0.5) * 0.05;
        const dz = (1 - smooth01(v / 0.22)) * Math.pow(clamp01(drip(u, v) + 0.1), 1.4);
        let r8 = base[0] * f, g8 = base[1] * f, b8 = base[2] * f;
        r8 = lerp(r8, 118, dz * 0.45); g8 = lerp(g8, 110, dz * 0.45); b8 = lerp(b8, 98, dz * 0.45);
        A[i] = r8; A[i + 1] = g8; A[i + 2] = b8; A[i + 3] = 255;
        R[p] = 0.50 + (sp.id - 0.5) * 0.12 - cr * 0.06 + dz * 0.20 + (rn() - 0.5) * 0.03;
        H[p] = clamp01(0.45 + cr * 0.40 + (sp.id - 0.5) * 0.15 + (low(u, v) - 0.5) * 0.2);
      }
    }
    return make('lightpole', {
      size: S, tile, A, R, H, heightMM: 0.5, repeat: [1, 3],
      params: { roughness: 1.0, metalness: 0.60, color: 0xffffff, envMapIntensity: 1.0 },
    });
  };

  function bakeDayCell(o) {
    const S = 128, tile = [0.10, 0.10];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(o.seed);
    const fiber = fbm(o.seed + 3, 40, 2), low = fbm(o.seed + 7, 4, 2);
    const base = hx(o.color);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, p = y * S + x, i = p * 4;
        const fb = fiber(u, v) - 0.5;
        const edge = 1 - smooth01(Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v)) / 0.08);
        const f = 1 + (low(u, v) - 0.5) * o.mottle + fb * 0.02 - edge * o.edgeDark;
        A[i] = base[0] * f; A[i + 1] = base[1] * f; A[i + 2] = base[2] * f; A[i + 3] = 255;
        R[p] = o.rough + fb * 0.06 + (rn() - 0.5) * 0.03 + edge * 0.06;
        H[p] = clamp01(0.55 + fb * 0.8 - edge * 0.45);
      }
    }
    return { A, R, H, size: S, tile };
  }
  defs['daycell'] = function () {
    const b = bakeDayCell({ seed: 6401, color: 0xF2F4F6, mottle: 0.02, rough: 0.55, edgeDark: 0.05 });
    return make('daycell', {
      size: b.size, tile: b.tile, A: b.A, R: b.R, H: b.H, heightMM: 0.15, repeat: [1, 1],
      params: {
        roughness: 1.0, metalness: 0.0, color: 0xffffff,
        emissive: 0xF2F4F6, emissiveIntensity: 0.22,
      },
    });
  };
  defs['daycell.dim'] = function () {
    const b = bakeDayCell({ seed: 6402, color: 0xA8A5A0, mottle: 0.05, rough: 0.80, edgeDark: 0.10 });
    return make('daycell.dim', {
      size: b.size, tile: b.tile, A: b.A, R: b.R, H: b.H, heightMM: 0.15, repeat: [1, 1],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
  };

  /* ══════════════════════════════════════════════════════════════════
     車輛材質
     ══════════════════════════════════════════════════════════════════ */
  let dustTex = null;
  function getDustTex() {
    if (dustTex) return dustTex;
    const S = 256, F = fieldOf(S);
    const n = fbm(7001, 6, 4), n2 = fbm(7002, 40, 2);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        F[y * S + x] = clamp01(n(u, v) * 0.65 + n2(u, v) * 0.35);
      }
    }
    dustTex = toTex(fieldToCanvas(F, S), false, [1, 1]);
    return dustTex;
  }

  /** ★ setDust：依世界法線 Y 加權，灰塵優先積在水平面 */
  function injectDust(mat) {
    const u = {
      uDust: { value: dustAmt },
      uDustColor: { value: new T.Color(0x9A968E) },
      uDustMap: { value: getDustTex() },
      uGray: { value: gray ? 1 : 0 },
    };
    mat.userData.dust = u;
    injected.push(u);
    const key = mat.name;
    const decl = ['uniform float uDust;', 'uniform vec3 uDustColor;',
      'uniform sampler2D uDustMap;', 'uniform float uGray;'].join('\n');
    const body = [
      '{',
      '  vec2 mlDustUv = vec2( 0.5 );',
      '  #ifdef USE_NORMALMAP',
      '    mlDustUv = vNormalMapUv;',
      '  #elif defined( USE_MAP )',
      '    mlDustUv = vMapUv;',
      '  #endif',
      '  vec3 mlWN = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );',
      '  float mlUp = clamp( mlWN.y, 0.0, 1.0 );',
      '  float mlW = mix( 0.16, 1.0, pow( mlUp, 1.6 ) );',   // ★ 垂直面較少
      '  float mlG = texture2D( uDustMap, mlDustUv * 5.0 ).r;',
      '  float mlAmt = clamp( uDust * mlW * ( 0.55 + 0.9 * mlG ), 0.0, 1.0 ) * 0.28;',
      '  vec3 mlDC = mix( uDustColor, vec3( 0.5 ), uGray );',
      '  diffuseColor.rgb = mix( diffuseColor.rgb, mlDC, mlAmt );',
      '  roughnessFactor = mix( roughnessFactor, 0.86, clamp( mlAmt * 2.6, 0.0, 1.0 ) );',
      '}',
    ].join('\n');
    mat.onBeforeCompile = function (shader) {
      for (const k in u) shader.uniforms[k] = u[k];
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + decl)
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + body);
    };
    mat.customProgramCacheKey = function () { return 'ml:' + key; };
  }

  defs['car.paint'] = function () {
    const S = 256, tile = [1.0, 1.0];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(7101);
    const peel = fbm(7102, 14, 3), flake = valueNoise(7103, 256), low = fbm(7104, 3, 2);
    const base = hx(0xF2F4F8);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, p = y * S + x, i = p * 4;
        const pk = peel(u, v) - 0.5;
        const fl = flake(u, v) - 0.5;
        const f = 1 + (low(u, v) - 0.5) * 0.012 + fl * 0.018;
        A[i] = base[0] * f; A[i + 1] = base[1] * f; A[i + 2] = base[2] * f; A[i + 3] = 255;
        // roughnessMap 以 1.0 為中心 → material.roughness 才能被 setDust 直接控制
        R[p] = 1.0 + pk * 0.12 + fl * 0.06 + (rn() - 0.5) * 0.02;
        H[p] = clamp01(0.5 + pk * 1.1 + fl * 0.25);
      }
    }
    const m = make('car.paint', {
      size: S, tile, A, R, H, heightMM: 0.015, repeat: [2, 2],
      physical: true,
      params: {
        color: 0xffffff, roughness: 0.28, metalness: 0.0,
        clearcoat: 0.7, clearcoatRoughness: 0.06,
        envMapIntensity: 1.15,
      },
    });
    m.normalScale = new T.Vector2(0.6, 0.6);
    injectDust(m);
    return m;
  };

  defs['car.glass'] = function () {
    const S = 256, tile = [1.0, 1.0];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(7201);
    const wave = fbm(7202, 4, 3), smudge = fbm(7203, 8, 3);
    const base = hx(0x2A3140);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, p = y * S + x, i = p * 4;
        const sm = Math.pow(clamp01((smudge(u, v) - 0.58) * 3.2), 1.5);
        const f = 1 + (wave(u, v) - 0.5) * 0.08;
        A[i] = lerp(base[0] * f, 92, sm * 0.35);
        A[i + 1] = lerp(base[1] * f, 96, sm * 0.35);
        A[i + 2] = lerp(base[2] * f, 102, sm * 0.35);
        A[i + 3] = 255;
        R[p] = 0.05 + sm * 0.13 + (rn() - 0.5) * 0.008;
        H[p] = clamp01(0.5 + (wave(u, v) - 0.5) * 1.0 + sm * 0.2);
      }
    }
    return make('car.glass', {
      size: S, tile, A, R, H, heightMM: 0.02, repeat: [1, 1],
      physical: true,
      params: {
        color: 0xffffff, roughness: 1.0, metalness: 0.0,
        transmission: 0.7, ior: 1.5, thickness: 0.006,
        transparent: false, side: T.FrontSide, envMapIntensity: 1.2,
      },
    });
  };

  defs['car.tire'] = function () {
    const S = 512, tile = [0.90, 0.25];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(7301);
    const low = fbm(7302, 5, 3), micro = fbm(7303, 60, 2);
    const base = hx(0x1A1F2A);
    for (let y = 0; y < S; y++) {
      const v = y / S;
      // v: 0–0.22 側壁 / 0.22–0.78 胎面 / 0.78–1 側壁
      const sideT = 1 - smooth01((Math.min(v, 1 - v) - 0.10) / 0.14);
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        let h, rough;
        if (sideT > 0.5) {
          // ★ 側面胎紋：環向細肋 + 字樣凸起帶
          const rib = Math.pow(1 - Math.abs(frac(v * 44) * 2 - 1), 2.2);
          const letters = Math.pow(clamp01(Math.sin(u * Math.PI * 26) * 0.5 + 0.5), 6.0)
            * (1 - smooth01(Math.abs(Math.min(v, 1 - v) - 0.055) / 0.028));
          h = 0.42 + rib * 0.10 + letters * 0.30 + (low(u, v) - 0.5) * 0.08;
          rough = 0.88 + (micro(u, v) - 0.5) * 0.06;
        } else {
          // 胎面：縱向溝 + 橫向刀槽
          const groove = Math.pow(clamp01(Math.abs(frac(v * 5.0) * 2 - 1) * 1.5 - 0.32), 0.7);
          const sipe = 1 - Math.pow(clamp01(Math.abs(frac(u * 34 + v * 2.4) * 2 - 1) * 3.2), 0.8);
          h = clamp01(0.30 + groove * 0.70 - sipe * 0.42);
          rough = 0.86 + (micro(u, v) - 0.5) * 0.07 + (1 - groove) * 0.04;
        }
        const f = 1 + (low(u, v) - 0.5) * 0.10 + (micro(u, v) - 0.5) * 0.05 + (h - 0.5) * 0.12;
        A[i] = base[0] * f; A[i + 1] = base[1] * f; A[i + 2] = base[2] * f; A[i + 3] = 255;
        R[p] = rough + (rn() - 0.5) * 0.03;
        H[p] = clamp01(h);
      }
    }
    return make('car.tire', {
      size: S, tile, A, R, H, heightMM: 8.0, repeat: [1, 1],
      params: { roughness: 1.0, metalness: 0.0, color: 0x1A1F2A },
    });
  };

  defs['car.wheel'] = function () {
    const S = 256, tile = [0.6, 0.6];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(7401);
    const low = fbm(7402, 4, 3), dustN = fbm(7403, 7, 3);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, p = y * S + x, i = p * 4;
        // 車床紋（同心細紋）
        const cx = u - 0.5, cy = v - 0.5;
        const r = Math.sqrt(cx * cx + cy * cy);
        const lathe = Math.pow(1 - Math.abs(frac(r * 130) * 2 - 1), 2.0);
        const bd = Math.pow(clamp01((dustN(u, v) - 0.45) * 2.2), 1.4);   // 煞車粉塵
        const f = (0.90 + (low(u, v) - 0.5) * 0.06 - lathe * 0.05);
        let c = 214 * f;
        A[i] = lerp(c, 96, bd * 0.55); A[i + 1] = lerp(c * 0.995, 82, bd * 0.55); A[i + 2] = lerp(c * 0.99, 72, bd * 0.55);
        A[i + 3] = 255;
        R[p] = 0.25 + lathe * 0.06 + bd * 0.34 + (rn() - 0.5) * 0.02;
        H[p] = clamp01(0.5 + lathe * 0.4 + (low(u, v) - 0.5) * 0.3);
      }
    }
    return make('car.wheel', {
      size: S, tile, A, R, H, heightMM: 0.10, repeat: [1, 1],
      params: { roughness: 1.0, metalness: 0.80, color: 0xffffff, envMapIntensity: 1.2 },
    });
  };

  defs['car.lamp'] = function () {
    const S = 256, tile = [0.4, 0.15];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(7501);
    const low = fbm(7502, 5, 2);
    for (let y = 0; y < S; y++) {
      const v = y / S;
      for (let x = 0; x < S; x++) {
        const u = x / S, p = y * S + x, i = p * 4;
        // 燈殼稜鏡（縱向柱狀） + 內部反射面的細格
        const prism = 1 - Math.abs(frac(u * 30) * 2 - 1);
        const inner = Math.pow(1 - Math.abs(frac(u * 30 + 0.5) * 2 - 1), 0.6)
          * Math.pow(1 - Math.abs(frac(v * 12) * 2 - 1), 0.6);
        const f = 0.95 + (low(u, v) - 0.5) * 0.05 + inner * 0.06;
        const c = 236 * f;
        A[i] = c; A[i + 1] = c * 0.995; A[i + 2] = c * 0.985; A[i + 3] = 255;
        R[p] = 0.12 + (1 - prism) * 0.05 + inner * 0.05 + (rn() - 0.5) * 0.01;
        H[p] = clamp01(0.35 + prism * 0.55 + inner * 0.12);
      }
    }
    return make('car.lamp', {
      size: S, tile, A, R, H, heightMM: 1.2, repeat: [1, 1],
      physical: true,
      params: {
        color: 0xffffff, roughness: 1.0, metalness: 0.0,
        transmission: 0.35, ior: 1.45, thickness: 0.02,
        clearcoat: 0.6, clearcoatRoughness: 0.08,
        transparent: false, side: T.FrontSide, envMapIntensity: 1.3,
      },
    });
  };

  defs['car.trim'] = function () {
    const S = 256, tile = [0.4, 0.4];
    const A = rgbaOf(S), R = fieldOf(S), H = fieldOf(S);
    const rn = mulberry32(7601);
    const grain = worley(7602, 90), low = fbm(7603, 5, 3);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, p = y * S + x, i = p * 4;
        const g = grain(u, v);
        const gs = clamp01(1 - g.f1 / 0.7);
        const f = 0.92 + (low(u, v) - 0.5) * 0.08 + (g.id - 0.5) * 0.10 + gs * 0.08;
        const c = 30 * f + 4;
        A[i] = c; A[i + 1] = c * 1.02; A[i + 2] = c * 1.06; A[i + 3] = 255;
        R[p] = 0.75 + (g.id - 0.5) * 0.08 - gs * 0.05 + (rn() - 0.5) * 0.03;
        H[p] = clamp01(0.45 + gs * 0.45 + (low(u, v) - 0.5) * 0.2);
      }
    }
    return make('car.trim', {
      size: S, tile, A, R, H, heightMM: 0.25, repeat: [2, 2],
      params: { roughness: 1.0, metalness: 0.0, color: 0xffffff },
    });
  };

  defs['car.shadow'] = function () {
    const S = 256;
    const A = rgbaOf(S);
    const soft = fbm(7701, 4, 3);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, i = (y * S + x) * 4;
        const dx = (u - 0.5) / 0.46, dy = (v - 0.5) / 0.30;   // 橢圓
        const d = Math.sqrt(dx * dx + dy * dy);
        let a = Math.pow(1 - smooth01(d), 1.7);
        a *= 0.82 + 0.18 * soft(u, v);
        A[i] = 12; A[i + 1] = 12; A[i + 2] = 14;
        A[i + 3] = Math.round(clamp01(a) * 255);
      }
    }
    const t = toTex(rgbaToCanvas(A, S), true, [1, 1]);
    t.wrapS = T.ClampToEdgeWrapping;
    t.wrapT = T.ClampToEdgeWrapping;
    const m = new T.MeshBasicMaterial({
      map: t, transparent: true, opacity: 0.55, depthWrite: false,
      side: T.DoubleSide, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    m.name = 'car.shadow';
    m.userData.tileMeters = { x: 1, y: 1 };
    texRec.set('car.shadow', { map: t, roughnessMap: null, normalMap: null, aoMap: null });
    return m;
  };

  /* ══════════════════════════════════════════════════════════════════
     公開 API
     ══════════════════════════════════════════════════════════════════ */
  const NAME_SET = new Set(MATERIAL_NAMES);
  const NO_GRAY = new Set(['car.shadow']);   // map 是 alpha 資料，不是 albedo

  // 建立時就檢查：37 個名稱一定要都有 builder（缺一個就當場爆，不留到執行期）
  for (const n of MATERIAL_NAMES) {
    if (typeof defs[n] !== 'function') {
      throw new Error('materials.js: 缺少材質 builder「' + n + '」');
    }
  }

  function applyGray(name, m, on) {
    if (NO_GRAY.has(name)) return;
    if (on) {
      if (grayBak.has(name)) return;
      const bak = {
        color: m.color ? m.color.getHex() : null,
        map: ('map' in m) ? (m.map || null) : undefined,
        emissive: m.emissive ? m.emissive.getHex() : null,
      };
      grayBak.set(name, bak);
      if (m.color) m.color.setHex(0x808080);
      if (bak.map !== undefined) m.map = null;
      // 只有本來就會發光的（daycell）才轉成中性灰，其餘保持全黑不點亮
      if (m.emissive && bak.emissive !== 0x000000) m.emissive.setHex(0x808080);
      m.needsUpdate = true;
    } else {
      const bak = grayBak.get(name);
      if (!bak) return;
      if (bak.color !== null && m.color) m.color.setHex(bak.color);
      if (bak.map !== undefined) m.map = bak.map;
      if (bak.emissive !== null && m.emissive) m.emissive.setHex(bak.emissive);
      grayBak.delete(name);
      m.needsUpdate = true;
    }
  }

  /** ★ 廳四五年隧道：0 → 1 連續積灰 */
  function applyDust(name, m) {
    const a = clamp01(dustAmt);
    if (name === 'car.paint') {
      m.clearcoat = lerp(0.85, 0.35, a);
      m.clearcoatRoughness = lerp(0.05, 0.35, a);
      m.roughness = lerp(0.25, 0.48, a);
      if (m.userData.dust) m.userData.dust.uDust.value = a;
    } else if (name === 'car.tire') {
      const c = new T.Color(0x1A1F2A).lerp(new T.Color(0x3A3F45), a);
      const bak = grayBak.get('car.tire');
      if (gray && bak) bak.color = c.getHex();      // 灰階中：只改「還原用」的顏色
      else m.color.copy(c);
    }
  }

  function build(name) {
    const m = defs[name]();
    mats.set(name, m);
    if (name === 'car.paint' || name === 'car.tire') applyDust(name, m);
    if (gray) applyGray(name, m, true);
    return m;
  }

  function get(name) {
    if (disposed) throw new Error('materials.js: MaterialLibrary 已 dispose，不可再 get('
      + name + ')');
    if (!NAME_SET.has(name) || typeof defs[name] !== 'function') {
      throw new Error('materials.js: 找不到材質「' + name + '」。可用名稱見 MATERIAL_NAMES（共 '
        + MATERIAL_NAMES.length + ' 個）');
    }
    return mats.get(name) || build(name);
  }

  const lib = {
    get: get,
    has: function (name) { return NAME_SET.has(name); },
    /** { map, roughnessMap, normalMap, aoMap }（aoMap 一律 null，見檔頭說明） */
    texture: function (name) {
      get(name);
      return texRec.get(name) || { map: null, roughnessMap: null, normalMap: null, aoMap: null };
    },
    /** ★ 灰階檢驗：Albedo 全換 #808080，保留 Roughness / Normal */
    setGrayscale: function (on) {
      on = !!on;
      if (on === gray) return;
      gray = on;
      for (const e of mats) applyGray(e[0], e[1], on);
      for (let i = 0; i < injected.length; i++) {
        if (injected[i].uGray) injected[i].uGray.value = on ? 1 : 0;
      }
    },
    isGrayscale: function () { return gray; },
    /** ★ 廳四積灰 0→1，只影響 car.paint / car.tire */
    setDust: function (amount01) {
      dustAmt = clamp01(Number(amount01) || 0);
      if (mats.has('car.paint')) applyDust('car.paint', mats.get('car.paint'));
      if (mats.has('car.tire')) applyDust('car.tire', mats.get('car.tire'));
    },
    getDust: function () { return dustAmt; },
    /** sky 的雲會動：每幀呼叫，或直接用 material.userData.update(t) */
    update: function (elapsed) {
      const sky = mats.get('sky');
      if (sky && sky.userData.update) sky.userData.update(elapsed);
    },
    /**
     * 依實際表面尺寸（公尺）設定 repeat。
     * 例：fitRepeat('floor.oak', 12.0, 9.0)
     * 注意：材質是共用的，一個名稱只能有一組 repeat。
     */
    fitRepeat: function (name, widthMeters, heightMeters) {
      const m = get(name);
      const tm = m.userData.tileMeters;
      const rec = texRec.get(name);
      if (!tm || !rec) return m;
      const rx = widthMeters / tm.x, ry = heightMeters / tm.y;
      for (const k in rec) {
        const t = rec[k];
        if (t && t.repeat) { t.repeat.set(rx, ry); t.needsUpdate = true; }
      }
      return m;
    },
    /** 已生成的貼圖記憶體估計（含 mipmap）。預算 120 MB。 */
    stats: function () {
      let bytes = 0;
      for (let i = 0; i < allTex.length; i++) {
        bytes += (allTex[i].userData && allTex[i].userData.bytes) || 0;
      }
      return {
        materialsBuilt: mats.size,
        materialsTotal: MATERIAL_NAMES.length,
        textures: allTex.length,
        estimatedTextureMB: Math.round(bytes / 1048576 * 100) / 100,
        budgetMB: 120,
        grayscale: gray,
        dust: dustAmt,
      };
    },
    /** 一次生成全部（測試 / 灰階檢驗用；正式流程請維持 lazy） */
    warmAll: function () {
      for (let i = 0; i < MATERIAL_NAMES.length; i++) get(MATERIAL_NAMES[i]);
      return lib.stats();
    },
    names: MATERIAL_NAMES.slice(),
    dispose: function () {
      for (let i = 0; i < allTex.length; i++) { try { allTex[i].dispose(); } catch (e) { /* noop */ } }
      for (const e of mats) { try { e[1].dispose(); } catch (e2) { /* noop */ } }
      allTex.length = 0;
      injected.length = 0;
      mats.clear();
      texRec.clear();
      grayBak.clear();
      dustTex = null;
      disposed = true;
    },
  };

  return lib;
}

export default createMaterialLibrary;
