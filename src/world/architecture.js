/**
 * architecture.js — B1 美術館與五個場景的建築（第 2 階段子代理產出）
 *
 * 假設：
 *   1. three.js 由 ctx.THREE 注入（本檔頂層**不** import 'three'，以便在 node 下純語法載入）。
 *   2. ctx.materials.get(name) 對 MODULE_API.md §5 的全部名稱都可用；找不到會 throw。
 *      本檔只用到 §5 清單上的名稱，**沒有自創材質**。以下為「以最接近的既有名稱代用」的紀錄：
 *        - 展廳灑水頭 / 通風格柵 / 隧道燈具外殼 → 用 `track.rail`、`track.head`（金屬件）
 *        - 巷弄冷氣室外機 / 電表箱 / 鐵窗 / 隧道緊急箱 → 用 `barrier.metal`
 *        - 巷弄水管、停車場燈桿與車擋柱 → 用 `lightpole`
 *        - 賽道輪胎牆 → 用 `car.tire`（真的是輪胎）
 *        - 賽道 / 停車場的裸土與碎石緩衝區 → 用 `soil`
 *        - 展籤與廣告板板面 → 用 `label.card`
 *        - 地面警戒線（深色細線）→ 用 `skirting`（深色收邊材）
 *      沒有任何 `new THREE.*Material`、沒有任何 `new THREE.*Light`。
 *   3. 光源全部來自 B3 的 ctx.lighting.makeRig()，本檔只做燈具**外殼**幾何。
 *   4. 單位 = 公尺，Y 軸向上，地面 y = 0（賽道除外：賽道路面 y 由中心線曲線決定）。
 *   5. 倒角一律 2 mm（bevelBox / bevelPlate），細小或大量 instancing 的零件夾到邊長的 24%。
 *   6. 賽道 `kerb.redwhite` 貼圖假設「1 個 UV tile = 1 段紅白」，故路肩 uv.x = 里程 / 0.5 m。
 *   7. 展廳畫作內容（畫布貼圖、展籤文字）由 B5 依 userData.artSlots 自行替換材質。
 *
 * 依賴：ctx.materials（B2）、ctx.lighting（B3）。不 import 任何專案模組。
 *
 * 未做到的項目（誠實記錄）：
 *   - 隧道「緊急電話箱凹槽」不是真正的布林挖洞（無 CSG 可用）：做成嵌在襯砌面上、
 *     門面內凹 12 cm 的箱體＋外框，視覺上讀作凹槽，但襯砌本身沒有真的被挖穿。
 *   - 展廳地板的「模糊反射」靠 B2 的 floor.oak roughness/normal 達成，本檔不做 mirror/SSR。
 *   - 賽道草葉為單面 InstancedMesh；若 B2 的 grass.blade 是 FrontSide，背面會被剔除。
 *   - 賽道長直線的頭尾兩端因 CatmullRom 會被相鄰控制點輕微帶彎，中段 ~460 m 為真直線。
 *   - 隧道 240 m 是 6 段 × 40 m 的循環，非 400 m。
 */

/* ==========================================================================
 * 0. 尺寸常數（DIMENSIONS 直接引用這些值 —— 程式碼與尺寸表永遠同一份來源）
 * ========================================================================== */

const BEVEL = 0.002;                    // 2 mm 倒角

// 廳一 美術館
const G = {
  W: 15.0, D: 16.0, H: 5.4,             // 展廳 15(X) × 16(Z)，天花板 5.4 m
  WALL_T: 0.30,
  ART_CENTER: 1.48,                     // ★ 畫心離地 148 cm（鐵律 145–152）
  ART_W: 1.00, ART_H: 1.30,
  ART_PITCH: 2.40,                      // 畫間距 = 2.40 - 1.00 = 1.40 m ≥ 1.2 ✓
  FRAME_T: 0.035,                       // 畫框厚 3.5 cm（側面看得見）
  STANDOFF: 0.035,                      // 畫離牆 3.5 cm
  GLASS_GAP: 0.002,                     // 紙與玻璃間 2 mm 空氣層
  SKIRT_H: 0.10, SKIRT_T: 0.020,        // 踢腳板 10 cm 高、突出 2 cm
  DOOR_W: 1.60, DOOR_H: 2.70,
  BENCH_SEAT: 0.45,
  VIEW_DIST: 2.60,                      // 觀看距離 2.6 m（規格 2–3 m）
  LINE_DIST: 0.70,                      // 警戒線離牆 70 cm（規格 60–80 cm）
  PLANK_W: 0.15, PLANK_L: 1.05, PLANK_T: 0.018,
};

// 廳二 窄巷
const A = {
  W: 3.60, H: 7.50, L: 32.0,            // 巷寬 3.6 / 牆高 7.5（三層樓）/ 巷長 32
  WALL_T: 0.40,
  CURB_H: 0.14, CURB_W: 0.15,
  CROWN: 0.033,                         // 中央拱起 3.3 cm ≈ 2% 橫向坡
  PARK_Z: -11.0, PARK_LEN: 10.0,        // 留給 B5 的平整停車區中心與長度
};

// 廳三 空無停車場
const L = {
  W: 44.0, D: 34.0,                     // 場地 44 × 34 m（≥ 40×30）
  STALL_W: 2.50, STALL_L: 5.50, LINE_W: 0.10,
  FENCE_H: 2.00,                        // 周界圍籬 2.0 m
  POLE_H: 7.00,                         // 照明燈桿 7 m
  SLOPE: 0.015,                         // 排水坡 1.5%
  CELL: { x: 0, z: 0, size: 12 },       // 留給 B6 的 12×12 m 平整鋪面
};

// 廳四 五年隧道
const T = {
  IW: 9.00,                             // 內徑寬 9 m
  CROWN: 6.20,                          // 拱頂高 6.2 m
  SPRING: 1.70,                         // 起拱線 1.7 m（以下為微弧側牆）
  R: 4.50,                              // 拱半徑
  LINER_T: 0.35,
  LANE: 3.50, LANES: 2,                 // 單向雙線，每線 3.5 m
  WALK_W: 0.90, WALK_H: 0.15,           // 人行道 0.9 m 寬、高 15 cm
  GRIME_H: 1.20,                        // 側壁下方 1.2 m 防污帶
  LAMP_SPACING: 10.0,                   // 隧道燈間距 10 m
  NICHE_SPACING: 50.0,                  // 每 50 m 一個緊急箱
  SEG: 40.0, SEGS: 6,                   // 6 × 40 = 240 m 循環
  CROWNSLOPE: 0.035,                    // 路面橫向拱高 3.5 cm ≈ 1% 
};

// 廳五 賽道
const R5 = {
  WIDTH: 14.0,                          // 賽道寬 14 m
  KERB_W: 2.00, KERB_STEPS: 3, KERB_STEP_H: 0.04,   // 路肩 2 m、3 階、每階 4 cm
  KERB_TILE: 0.50,                      // 紅白每段 50 cm
  BARRIER_OFF: 5.00, BARRIER_H: 1.15,   // 護欄距路緣 5 m、高 1.15 m
  RUNOFF: 12.0,                         // 緩衝區 12 m（規格 5–15 m）
  GRASS_COUNT: 6000,
  STRAIGHT: 500.0,                      // 長直線 500 m
  PRE_START: 460.0,                     // 起跑線前直線 460 m
  BANK_MIN: 2.0, BANK_MAX: 8.0,         // 傾斜 2–8 度
  SAMPLES: 1400,
};

// 廳六 法庭
const C6 = {
  W: 12.0, D: 16.0, H: 5.00,            // 12 × 16 m，天花板 5.0 m
  WALL_T: 0.35,
  DOCK_R: 2.30, DOCK_H: 0.25, DOCK_TOE: 0.06,   // 被告席 直徑 4.6 m、高 25 cm、踢面 6 cm
  DOCK_Z: 2.0,
  PROS_Z: -7.0, PROS_H: 0.70,           // 檢方席 z=-7（距被告席 9 m）、高 70 cm
  PLAYER_Z: 7.5,                        // 玩家距被告席 5.5 m
  SKY_W: 3.00,                          // 天光開口 3 × 3 m
  SHADOW_W: 4.50,                       // 兩側陰影區各 4.5 m
  COLS: 6,                              // 每側 6 根列柱
  NICHES: 5,                            // 每側 5 個壁龕
  SKIRT_H: 0.10,
};

/* ==========================================================================
 * 1. 幾何小工具（全部把 THREE 當參數傳入）
 * ========================================================================== */

const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
// 決定性偽亂數（同樣的種子永遠得到同一個場景）
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 12 條邊全部倒角的方塊。真實世界沒有絕對銳利的邊。 */
function bevelBox(THREE, w, h, d, bev) {
  const b = Math.max(0.0004, Math.min(bev === undefined ? BEVEL : bev, Math.min(w, h, d) * 0.24));
  const sw = w - 2 * b, sh = h - 2 * b, sd = d - 2 * b;
  const s = new THREE.Shape();
  s.moveTo(-sw / 2, -sh / 2); s.lineTo(sw / 2, -sh / 2);
  s.lineTo(sw / 2, sh / 2); s.lineTo(-sw / 2, sh / 2); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: sd, bevelEnabled: true, bevelThickness: b, bevelSize: b,
    bevelOffset: 0, bevelSegments: 1, curveSegments: 1, steps: 1,
  });
  g.translate(0, 0, -sd / 2);
  return g;
}

/** 就地擺放一份 geometry（先轉再位移）。 */
function place(g, x, y, z, rx, ry, rz) {
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x || 0, y || 0, z || 0);
  return g;
}

/** 自寫的 geometry 合併（不 import three/addons，維持零專案相依）。 */
function mergeGeos(THREE, geos) {
  if (geos.length === 1) return geos[0];
  let vCount = 0, iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uvs = new Float32Array(vCount * 2);
  const idx = (vCount > 65535 ? new Uint32Array(iCount) : new Uint32Array(iCount));
  let vo = 0, io = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = g.attributes.normal, t = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos[(vo + i) * 3] = p.getX(i); pos[(vo + i) * 3 + 1] = p.getY(i); pos[(vo + i) * 3 + 2] = p.getZ(i);
      if (n) { nor[(vo + i) * 3] = n.getX(i); nor[(vo + i) * 3 + 1] = n.getY(i); nor[(vo + i) * 3 + 2] = n.getZ(i); }
      if (t) { uvs[(vo + i) * 2] = t.getX(i); uvs[(vo + i) * 2 + 1] = t.getY(i); }
    }
    if (g.index) { const gi = g.index; for (let i = 0; i < gi.count; i++) idx[io + i] = gi.getX(i) + vo; io += gi.count; }
    else { for (let i = 0; i < p.count; i++) idx[io + i] = i + vo; io += p.count; }
    vo += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** 依材質名分箱收集 geometry，最後每個材質只送出「一個」draw call。 */
function GeoBag(ctx) {
  const THREE = ctx.THREE;
  const bags = new Map();
  return {
    add(matName, geo) {
      let arr = bags.get(matName);
      if (!arr) { arr = []; bags.set(matName, arr); }
      arr.push(geo);
      return geo;
    },
    /** flags: { 'floor.oak': {cast:false} } */
    flush(parent, flags) {
      let n = 0;
      for (const [name, gs] of bags) {
        const m = new THREE.Mesh(mergeGeos(THREE, gs), ctx.materials.get(name));
        const f = (flags && flags[name]) || {};
        m.castShadow = f.cast !== false;
        m.receiveShadow = f.receive !== false;
        m.name = 'merged:' + name;
        parent.add(m); n++;
      }
      bags.clear();
      return n;
    },
    count() { return bags.size; },
  };
}

/** 一組 instance 矩陣 → InstancedMesh（材質一律向 ctx 取）。 */
function instanced(ctx, geo, matName, list, flags) {
  const THREE = ctx.THREE;
  const im = new THREE.InstancedMesh(geo, ctx.materials.get(matName), list.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const p = new THREE.Vector3(), s = new THREE.Vector3();
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    p.set(it.p[0], it.p[1], it.p[2]);
    e.set(it.r ? it.r[0] : 0, it.r ? it.r[1] : 0, it.r ? it.r[2] : 0);
    q.setFromEuler(e);
    s.set(it.s ? it.s[0] : 1, it.s ? it.s[1] : 1, it.s ? it.s[2] : 1);
    m.compose(p, q, s);
    im.setMatrixAt(i, m);
  }
  im.instanceMatrix.needsUpdate = true;
  const f = flags || {};
  im.castShadow = f.cast !== false;
  im.receiveShadow = f.receive !== false;
  im.name = 'inst:' + matName;
  return im;
}

/** 由高度函式產生的地面網格（保證「地面不可完全水平」）。 */
function groundMesh(ctx, matName, w, d, segW, segD, hFn, uvScale) {
  const THREE = ctx.THREE;
  const g = new THREE.PlaneGeometry(w, d, segW, segD);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    p.setY(i, hFn(x, z));
    uv.setXY(i, (x / (uvScale || 4)), (z / (uvScale || 4)));
  }
  p.needsUpdate = true; uv.needsUpdate = true;
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, ctx.materials.get(matName));
  m.receiveShadow = true; m.castShadow = false;
  m.name = 'ground:' + matName;
  return m;
}

/** 天空半球（不用改材質的 side：直接把幾何翻面）。 */
function skyDome(ctx, radius) {
  const THREE = ctx.THREE;
  const g = new THREE.SphereGeometry(radius, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.52);
  g.scale(-1, 1, 1);
  const m = new THREE.Mesh(g, ctx.materials.get('sky'));
  m.castShadow = false; m.receiveShadow = false;
  m.name = 'sky';
  return m;
}

/* ==========================================================================
 * 2. 廳一 · 美術館
 * ========================================================================== */

export function buildGallery(ctx) {
  const THREE = ctx.THREE;
  const root = new THREE.Group();
  root.name = 'arch.gallery';
  const bag = GeoBag(ctx);
  const rnd = mulberry(0x9E3779B1);

  const hw = G.W / 2, hd = G.D / 2;

  /* ---- 2.1 拼花木地板（幾何上真的分塊：板寬 15 cm、長 90–120 cm、交錯排列）---- */
  // 地板不完全水平：極輕微的沉陷（±3 mm），是老建築的樣子，也讓高光不死板。
  const settle = (x, z) => -0.003 * (0.5 + 0.5 * Math.cos(x * 0.42)) * (0.5 + 0.5 * Math.cos(z * 0.33));
  const plankGeo = bevelBox(THREE, G.PLANK_W - 0.002, G.PLANK_T, G.PLANK_L, 0.0012);
  const planks = [];
  const rows = Math.floor(G.W / G.PLANK_W);
  for (let r = 0; r < rows; r++) {
    const x = -hw + G.PLANK_W * (r + 0.5);
    let z = -hd - rnd() * G.PLANK_L;              // 每列錯開起點 → 交錯排列
    while (z < hd) {
      const len = 0.90 + rnd() * 0.30;            // 90–120 cm
      const cz = z + len / 2;
      if (cz > -hd - 0.2 && cz < hd + 0.2) {
        planks.push({
          p: [x, -G.PLANK_T / 2 + settle(x, cz), cz],
          s: [1, 1, len / G.PLANK_L],
        });
      }
      z += len + 0.004;                            // 4 mm 板縫，杜絕 z-fighting
    }
  }
  const floor = instanced(ctx, plankGeo, 'floor.oak', planks, { cast: false });
  root.add(floor);
  // 板下墊層，避免從縫隙看穿
  bag.add('plinth', place(bevelBox(THREE, G.W, 0.06, G.D), 0, -G.PLANK_T - 0.03, 0));

  /* ---- 2.2 四面牆 + 門洞 ---- */
  const wallH = G.H;
  // 背牆 z = -hd（展牆），左右牆 x = ±hw，前牆 z = +hd 開一個 1.6 × 2.7 的門
  bag.add('wall.paint', place(bevelBox(THREE, G.W + G.WALL_T * 2, wallH, G.WALL_T), 0, wallH / 2, -hd - G.WALL_T / 2));
  bag.add('wall.paint', place(bevelBox(THREE, G.WALL_T, wallH, G.D), -hw - G.WALL_T / 2, wallH / 2, 0));
  bag.add('wall.paint', place(bevelBox(THREE, G.WALL_T, wallH, G.D), hw + G.WALL_T / 2, wallH / 2, 0));
  const sideW = (G.W - G.DOOR_W) / 2;
  bag.add('wall.paint', place(bevelBox(THREE, sideW, wallH, G.WALL_T), -(G.DOOR_W / 2 + sideW / 2), wallH / 2, hd + G.WALL_T / 2));
  bag.add('wall.paint', place(bevelBox(THREE, sideW, wallH, G.WALL_T), (G.DOOR_W / 2 + sideW / 2), wallH / 2, hd + G.WALL_T / 2));
  bag.add('wall.paint', place(bevelBox(THREE, G.DOOR_W, wallH - G.DOOR_H, G.WALL_T), 0, G.DOOR_H + (wallH - G.DOOR_H) / 2, hd + G.WALL_T / 2));
  // 門套（實木收邊，門高 2.7 m）
  bag.add('frame.wood', place(bevelBox(THREE, 0.08, G.DOOR_H + 0.08, G.WALL_T + 0.03), -G.DOOR_W / 2 - 0.04, (G.DOOR_H + 0.08) / 2, hd + G.WALL_T / 2));
  bag.add('frame.wood', place(bevelBox(THREE, 0.08, G.DOOR_H + 0.08, G.WALL_T + 0.03), G.DOOR_W / 2 + 0.04, (G.DOOR_H + 0.08) / 2, hd + G.WALL_T / 2));
  bag.add('frame.wood', place(bevelBox(THREE, G.DOOR_W + 0.16, 0.08, G.WALL_T + 0.03), 0, G.DOOR_H + 0.04, hd + G.WALL_T / 2));

  /* ---- 2.3 踢腳板（牆與地交界 10 cm，顏色略深）—— 地板與牆絕不直接相交 ---- */
  const sk = (w, x, z, ry) => bag.add('skirting',
    place(bevelBox(THREE, w, G.SKIRT_H + 0.02, G.SKIRT_T), x, (G.SKIRT_H - 0.02) / 2, z, 0, ry || 0, 0));
  sk(G.W, 0, -hd + G.SKIRT_T / 2);
  sk(G.D, -hw + G.SKIRT_T / 2, 0, Math.PI / 2);
  sk(G.D, hw - G.SKIRT_T / 2, 0, Math.PI / 2);
  sk(sideW, -(G.DOOR_W / 2 + sideW / 2), hd - G.SKIRT_T / 2);
  sk(sideW, (G.DOOR_W / 2 + sideW / 2), hd - G.SKIRT_T / 2);

  /* ---- 2.4 天花板：不是一片平板，是格梁 + 通風格柵 + 灑水頭 ---- */
  bag.add('ceiling', place(bevelBox(THREE, G.W, 0.12, G.D), 0, G.H + 0.06, 0));
  for (let i = -3; i <= 3; i++) {                                   // 橫向主梁（每 2.2 m）
    bag.add('ceiling', place(bevelBox(THREE, G.W, 0.22, 0.30), 0, G.H - 0.11, i * 2.2));
  }
  bag.add('ceiling', place(bevelBox(THREE, 0.28, 0.16, G.D), -3.4, G.H - 0.08, 0));
  bag.add('ceiling', place(bevelBox(THREE, 0.28, 0.16, G.D), 3.4, G.H - 0.08, 0));
  // 通風口格柵（6 個，金屬葉片真的一片一片）
  const ventAt = [[-4.6, -4.4], [4.6, -4.4], [-4.6, 0], [4.6, 0], [-4.6, 4.4], [4.6, 4.4]];
  for (const [vx, vz] of ventAt) {
    bag.add('track.rail', place(bevelBox(THREE, 0.62, 0.05, 0.44), vx, G.H - 0.025, vz));
    for (let b = 0; b < 7; b++) {
      bag.add('track.rail', place(bevelBox(THREE, 0.54, 0.030, 0.035, 0.0008),
        vx, G.H - 0.062, vz - 0.18 + b * 0.06, 0.42, 0, 0));
    }
  }
  // 消防灑水頭（8 顆：下垂管 + 集熱盤）
  for (let i = 0; i < 8; i++) {
    const sx = -5.6 + (i % 4) * 3.73, sz = (i < 4) ? -3.3 : 3.3;
    bag.add('track.rail', place(new THREE.CylinderGeometry(0.016, 0.016, 0.16, 8), sx, G.H - 0.08, sz));
    bag.add('track.rail', place(new THREE.CylinderGeometry(0.048, 0.030, 0.018, 10), sx, G.H - 0.17, sz));
  }

  /* ---- 2.5 十八個畫位：畫框（側面看得見）+ 保護玻璃 + 展籤 + 地面警戒線 ---- */
  const slots = [];
  const wallDefs = [
    { n: [0, 0, 1], base: [0, 0, -hd], axis: [1, 0, 0], count: 6 },   // 背牆
    { n: [1, 0, 0], base: [-hw, 0, 0], axis: [0, 0, 1], count: 6 },   // 左牆
    { n: [-1, 0, 0], base: [hw, 0, 0], axis: [0, 0, 1], count: 6 },   // 右牆
  ];
  const canvasGeoSrc = new THREE.PlaneGeometry(G.ART_W - 0.11, G.ART_H - 0.11);
  const glassGeoSrc = new THREE.PlaneGeometry(G.ART_W - 0.09, G.ART_H - 0.09);
  const canvasMat = ctx.materials.get('label.card');     // 空白畫布佔位，B5 會換掉
  const glassMat = ctx.materials.get('frame.glass');
  const labelGeoSrc = new THREE.PlaneGeometry(0.12, 0.08);   // ★ 展籤 12 × 8 cm
  const labelMat = ctx.materials.get('label.card');

  for (const wd of wallDefs) {
    const n = new THREE.Vector3().fromArray(wd.n);
    const ax = new THREE.Vector3().fromArray(wd.axis);
    const yaw = Math.atan2(n.x, n.z);
    for (let i = 0; i < wd.count; i++) {
      const t = (i - (wd.count - 1) / 2) * G.ART_PITCH;
      const c = new THREE.Vector3().fromArray(wd.base).addScaledVector(ax, t);
      const px = c.x + n.x * G.STANDOFF, pz = c.z + n.z * G.STANDOFF;

      // 畫框：四條邊框，厚 3.5 cm，側面朝向觀眾看得見
      const fD = G.FRAME_T, fB = 0.055;                     // 框寬 5.5 cm
      const cx = c.x + n.x * (G.STANDOFF + fD / 2), cz = c.z + n.z * (G.STANDOFF + fD / 2);
      const mk = (w, h, oy, ot) => {
        const g = bevelBox(THREE, w, h, fD);
        g.rotateY(yaw);
        g.translate(cx + ax.x * ot, G.ART_CENTER + oy, cz + ax.z * ot);
        bag.add('frame.wood', g);
      };
      mk(G.ART_W, fB, (G.ART_H - fB) / 2, 0);
      mk(G.ART_W, fB, -(G.ART_H - fB) / 2, 0);
      mk(fB, G.ART_H - fB * 2, 0, -(G.ART_W - fB) / 2);
      mk(fB, G.ART_H - fB * 2, 0, (G.ART_W - fB) / 2);
      // 背板（畫離牆 3.5 cm，才會有接觸陰影）
      const back = bevelBox(THREE, G.ART_W - 0.02, G.ART_H - 0.02, 0.016);
      back.rotateY(yaw); back.translate(px + n.x * 0.008, G.ART_CENTER, pz + n.z * 0.008);
      bag.add('frame.wood', back);

      // 畫紙（B5 換材質）— 位於背板前 2 mm
      const cvs = new THREE.Mesh(canvasGeoSrc, canvasMat);
      cvs.position.set(px + n.x * 0.018, G.ART_CENTER, pz + n.z * 0.018);
      cvs.rotation.y = yaw; cvs.name = 'art.canvas.' + slots.length;
      cvs.castShadow = false; cvs.receiveShadow = true;
      root.add(cvs);
      // 保護玻璃 — 與畫紙留 2 mm 空氣層
      const gl = new THREE.Mesh(glassGeoSrc, glassMat);
      gl.position.set(px + n.x * (0.018 + G.GLASS_GAP), G.ART_CENTER, pz + n.z * (0.018 + G.GLASS_GAP));
      gl.rotation.y = yaw; gl.name = 'art.glass.' + slots.length;
      gl.castShadow = false; gl.receiveShadow = false;
      root.add(gl);
      // 展籤：畫的右下方
      const lo = G.ART_W / 2 + 0.10, ly = G.ART_CENTER - G.ART_H / 2 + 0.05;
      const lab = new THREE.Mesh(labelGeoSrc, labelMat);
      lab.position.set(px + ax.x * lo + n.x * 0.004, ly, pz + ax.z * lo + n.z * 0.004);
      lab.rotation.y = yaw; lab.name = 'art.label.' + slots.length;
      lab.castShadow = false; lab.receiveShadow = true;
      root.add(lab);

      slots.push({
        index: slots.length,
        position: new THREE.Vector3(px, G.ART_CENTER, pz),
        normal: n.clone(),
        yaw, size: [G.ART_W, G.ART_H],
        viewPoint: new THREE.Vector3(c.x + n.x * G.VIEW_DIST, 1.60, c.z + n.z * G.VIEW_DIST),
        canvas: cvs, glass: gl, label: lab,
      });

      // 地面警戒線：畫前 70 cm 的一道極細深色線（每個畫位一段）
      const lg = bevelBox(THREE, G.ART_W + 0.9, 0.004, 0.012, 0.0008);
      lg.rotateY(yaw);
      lg.translate(c.x + n.x * G.LINE_DIST, 0.003, c.z + n.z * G.LINE_DIST);
      bag.add('skirting', lg);
    }
  }
  root.userData.artSlots = slots;

  /* ---- 2.6 長椅（展廳中央，坐面高 45 cm）---- */
  for (const bz of [-3.6, 3.6]) {
    const seat = bevelBox(THREE, 1.90, 0.055, 0.44);
    bag.add('bench.wood', place(seat, 0, G.BENCH_SEAT - 0.028, bz));
    for (const s of [-1, 1]) {
      bag.add('bench.wood', place(bevelBox(THREE, 0.07, G.BENCH_SEAT - 0.055, 0.38), s * 0.80, (G.BENCH_SEAT - 0.055) / 2, bz));
    }
    bag.add('bench.wood', place(bevelBox(THREE, 1.50, 0.06, 0.06), 0, 0.16, bz));
  }

  /* ---- 2.7 只有真實世界才有的雜物：展廳編號牌、地面銅製指示釘、滅火器、拖鞋防護欄立柱 ---- */
  // 展廳編號標示（門左側 1.55 m 高）
  bag.add('plinth', place(bevelBox(THREE, 0.24, 0.30, 0.012), -G.DOOR_W / 2 - 0.32, 1.55, hd - 0.006));
  const num = new THREE.Mesh(new THREE.PlaneGeometry(0.20, 0.26), labelMat);
  num.position.set(-G.DOOR_W / 2 - 0.32, 1.55, hd - 0.014);
  num.rotation.y = Math.PI; num.name = 'gallery.roomNumber';
  root.add(num);
  // 銅製地釘（動線指示）
  for (let i = 0; i < 10; i++) {
    bag.add('track.rail', place(new THREE.CylinderGeometry(0.022, 0.022, 0.006, 10), -5.0 + i * 1.1, 0.002, 5.2));
  }
  // 滅火器（角落）＋ 壁掛托架
  bag.add('barrier.metal', place(new THREE.CylinderGeometry(0.075, 0.075, 0.44, 14), hw - 0.30, 0.42, hd - 0.55));
  bag.add('barrier.metal', place(new THREE.CylinderGeometry(0.030, 0.030, 0.10, 8), hw - 0.30, 0.69, hd - 0.55));
  bag.add('track.rail', place(bevelBox(THREE, 0.10, 0.03, 0.16), hw - 0.30, 0.62, hd - 0.44));
  // 展台（畫廊裡永遠會有的立方展台）
  bag.add('plinth', place(bevelBox(THREE, 0.55, 1.05, 0.55), -hw + 1.1, 0.525, -hd + 1.1));
  bag.add('plinth', place(bevelBox(THREE, 0.55, 1.05, 0.55), hw - 1.1, 0.525, -hd + 1.1));
  // 觀眾隔離柱（可拆式立柱，畫前 70 cm 那條線上）
  for (const px of [-5.5, 0, 5.5]) {
    bag.add('track.rail', place(new THREE.CylinderGeometry(0.030, 0.045, 0.95, 12), px, 0.475, -hd + G.LINE_DIST));
  }

  const dc = bag.flush(root, { 'plinth': { cast: true }, 'skirting': { cast: false } });
  DIMENSIONS.gallery.drawCallEstimate = dc + 1 + slots.length * 3;
  root.userData.dimensions = DIMENSIONS.gallery;
  return root;
}

/* ==========================================================================
 * 3. 廳二 · 窄巷（台灣巷弄）
 * ========================================================================== */

export function buildAlley(ctx) {
  const THREE = ctx.THREE;
  const root = new THREE.Group();
  root.name = 'arch.alley';
  const bag = GeoBag(ctx);
  const rnd = mulberry(0x51ED270B);

  const hw = A.W / 2;                       // ±1.8
  const roadHalf = hw - A.CURB_W;           // ±1.65 柏油
  const z0 = 0, z1 = -A.L;                  // 巷口 z=0，死路 z=-32

  /* ---- 3.1 柏油路面：中央拱起（排水坡 ~2%）＋ 縱向 0.8% 微降 ---- */
  const roadH = (x, z) => A.CROWN * (1 - Math.pow(clamp(x / roadHalf, -1, 1), 2)) - 0.008 * (-z) * 0.1
    + 0.006 * Math.sin(z * 0.7) * Math.cos(x * 1.9);
  const road = groundMesh(ctx, 'asphalt', roadHalf * 2, A.L, 24, 128,
    (x, z) => roadH(x, z - A.L / 2), 3.0);
  road.position.z = -A.L / 2;
  root.add(road);
  // 兩側集水明溝（真實巷弄一定有）
  for (const s of [-1, 1]) {
    bag.add('concrete.wall', place(bevelBox(THREE, 0.10, 0.05, A.L - 0.2), s * (roadHalf - 0.06), 0.012, -A.L / 2));
  }

  /* ---- 3.2 路緣石（高 14 cm、寬 15 cm）---- */
  for (const s of [-1, 1]) {
    bag.add('curb', place(bevelBox(THREE, A.CURB_W, A.CURB_H + 0.06, A.L), s * (hw - A.CURB_W / 2), (A.CURB_H - 0.06) / 2, -A.L / 2));
  }
  // 死路端的路緣收頭
  bag.add('curb', place(bevelBox(THREE, A.W, A.CURB_H + 0.06, A.CURB_W), 0, (A.CURB_H - 0.06) / 2, z1 + A.CURB_W / 2));

  /* ---- 3.3 兩側牆（三層樓 7.5 m）＋ 盡頭死路轉角 ---- */
  for (const s of [-1, 1]) {
    bag.add('concrete.wall', place(bevelBox(THREE, A.WALL_T, A.H, A.L + A.WALL_T), s * (hw + A.WALL_T / 2), A.H / 2, -A.L / 2));
    // 樓層分隔線（每 2.5 m 一道 6 cm 突出的水平飾帶 → 打光時才有層次）
    for (let f = 1; f <= 2; f++) {
      bag.add('concrete.wall', place(bevelBox(THREE, 0.06, 0.14, A.L), s * (hw - 0.03), f * 2.5, -A.L / 2));
    }
  }
  // 盡頭：橫牆（死路）＋ 一段向左折的轉角短牆，讓巷子不會無限延伸
  bag.add('concrete.wall', place(bevelBox(THREE, A.W + A.WALL_T * 2, A.H, A.WALL_T), 0, A.H / 2, z1 - A.WALL_T / 2));
  bag.add('concrete.wall', place(bevelBox(THREE, 2.6, A.H, A.WALL_T), -hw - 1.3, A.H / 2, z1 - A.WALL_T / 2));
  // 巷口：對街建物量體（擋住視線，形成明確邊界）
  bag.add('concrete.wall', place(bevelBox(THREE, 22.0, A.H + 2.0, 0.5), 0, (A.H + 2.0) / 2, z0 + 8.0));

  /* ---- 3.4 台灣巷弄的識別：冷氣室外機 / 水管 / 電表箱 / 鐵窗（每種至少各 3 個）---- */
  const acZ = [-4.2, -9.6, -14.8, -20.4, -26.2, -30.0];
  for (let i = 0; i < acZ.length; i++) {
    const s = (i % 2 === 0) ? -1 : 1;
    const y = 2.55 + (i % 3) * 1.85;
    const x = s * (hw - 0.02);
    // 壁掛支架（角鋼）
    for (const o of [-0.30, 0.30]) {
      bag.add('barrier.metal', place(bevelBox(THREE, 0.44, 0.035, 0.035), x - s * 0.22, y - 0.24, acZ[i] + o));
      bag.add('barrier.metal', place(bevelBox(THREE, 0.035, 0.30, 0.035), x - s * 0.02, y - 0.09, acZ[i] + o));
    }
    // 機殼 + 風扇護罩
    bag.add('barrier.metal', place(bevelBox(THREE, 0.34, 0.62, 0.86), x - s * 0.19, y, acZ[i]));
    bag.add('chainlink', place(new THREE.CylinderGeometry(0.24, 0.24, 0.012, 20), x - s * 0.365, y + 0.03, acZ[i], 0, 0, Math.PI / 2));
    // 冷氣排水管（真實世界一定會滴水的那條）
    bag.add('lightpole', place(new THREE.CylinderGeometry(0.012, 0.012, y - 0.4, 6), x - s * 0.06, (y - 0.4) / 2 + 0.1, acZ[i] + 0.42));
  }
  // 垂直管線（水管 / 落水管）—— 6 條，含彎頭
  const pipeZ = [-2.6, -7.4, -12.2, -17.0, -23.4, -29.2];
  for (let i = 0; i < pipeZ.length; i++) {
    const s = (i % 2 === 0) ? 1 : -1;
    const x = s * (hw - 0.09), rad = 0.045 + (i % 3) * 0.018;
    bag.add('lightpole', place(new THREE.CylinderGeometry(rad, rad, A.H - 0.35, 10), x, (A.H - 0.35) / 2 + 0.20, pipeZ[i]));
    for (let k = 0; k < 4; k++) {   // 固定環
      bag.add('barrier.metal', place(new THREE.TorusGeometry(rad + 0.018, 0.012, 5, 12), x, 0.9 + k * 1.9, pipeZ[i], 0, Math.PI / 2, 0));
    }
    bag.add('lightpole', place(new THREE.CylinderGeometry(rad, rad, 0.22, 10), x - s * 0.11, 0.22, pipeZ[i], 0, 0, Math.PI / 2));
  }
  // 電表箱（4 個，含表玻璃與線槽）
  const meterZ = [-1.8, -11.4, -19.6, -27.8];
  for (let i = 0; i < meterZ.length; i++) {
    const s = (i % 2 === 0) ? -1 : 1, x = s * (hw - 0.02);
    bag.add('barrier.metal', place(bevelBox(THREE, 0.14, 0.52, 0.38), x - s * 0.07, 1.62, meterZ[i]));
    bag.add('frame.glass', place(new THREE.PlaneGeometry(0.16, 0.16), x - s * 0.142, 1.68, meterZ[i], 0, s * Math.PI / 2, 0));
    bag.add('lightpole', place(bevelBox(THREE, 0.07, 1.30, 0.07), x - s * 0.035, 0.70, meterZ[i] + 0.24));
  }
  // 鐵窗（4 個，含窗框與直向鐵條）
  const winZ = [-5.8, -13.6, -21.8, -28.6];
  for (let i = 0; i < winZ.length; i++) {
    const s = (i % 2 === 0) ? 1 : -1, x = s * (hw - 0.01), y = 3.0 + (i % 2) * 2.4;
    bag.add('concrete.wall', place(bevelBox(THREE, 0.10, 1.32, 1.02), x - s * 0.05, y, winZ[i]));   // 窗洞收邊
    bag.add('frame.glass', place(new THREE.PlaneGeometry(1.00, 1.30), x - s * 0.055, y, winZ[i], 0, s * Math.PI / 2, 0));
    bag.add('barrier.metal', place(bevelBox(THREE, 0.05, 1.36, 0.06), x - s * 0.10, y, winZ[i] - 0.52));
    bag.add('barrier.metal', place(bevelBox(THREE, 0.05, 1.36, 0.06), x - s * 0.10, y, winZ[i] + 0.52));
    bag.add('barrier.metal', place(bevelBox(THREE, 0.05, 0.06, 1.10), x - s * 0.10, y + 0.65, winZ[i]));
    bag.add('barrier.metal', place(bevelBox(THREE, 0.05, 0.06, 1.10), x - s * 0.10, y - 0.65, winZ[i]));
    for (let b = 0; b < 7; b++) {
      bag.add('chainlink', place(bevelBox(THREE, 0.035, 1.30, 0.022, 0.0008), x - s * 0.10, y, winZ[i] - 0.45 + b * 0.15));
    }
  }
  // 其它「只有真實世界才有」：鐵捲門、電線、機車擋、消防栓、盆栽台
  bag.add('barrier.metal', place(bevelBox(THREE, 2.20, 2.30, 0.09), -0.4, 1.15, z1 + 0.05));
  for (let k = 0; k < 8; k++) {                                     // 頭頂電線（微垂）
    const y = 5.8 + 0.22 * k * 0.1;
    for (const s of [-1, 1]) {
      bag.add('lightpole', place(new THREE.CylinderGeometry(0.008, 0.008, A.L, 4),
        s * (hw - 0.25) + (k % 3) * 0.05, y + 0.10 * Math.sin(k), -A.L / 2, Math.PI / 2, 0, 0));
    }
  }
  bag.add('lightpole', place(new THREE.CylinderGeometry(0.05, 0.06, 0.72, 10), hw - 0.30, 0.36 + A.CURB_H, -3.4));
  bag.add('lightpole', place(new THREE.CylinderGeometry(0.05, 0.06, 0.72, 10), hw - 0.30, 0.36 + A.CURB_H, -5.2));
  bag.add('barrier.metal', place(new THREE.CylinderGeometry(0.10, 0.10, 0.78, 12), -hw + 0.28, 0.39 + A.CURB_H, -16.5));
  bag.add('barrier.metal', place(new THREE.CylinderGeometry(0.055, 0.055, 0.26, 10), -hw + 0.28, 0.62 + A.CURB_H, -16.5, 0, 0, Math.PI / 2));
  bag.add('concrete.wall', place(bevelBox(THREE, 0.46, 0.34, 1.30), -hw + 0.23, 0.17 + A.CURB_H, -24.0));
  bag.add('soil', place(bevelBox(THREE, 0.40, 0.06, 1.24), -hw + 0.23, 0.36 + A.CURB_H, -24.0));
  // 巷內標線（禁停紅線的白色端點 / 門牌板）
  bag.add('roadline', place(bevelBox(THREE, 0.10, 0.006, 5.0, 0.001), hw - A.CURB_W - 0.10, A.CROWN * 0.15 + 0.004, -8.0));
  bag.add('label.card', place(new THREE.PlaneGeometry(0.22, 0.14), -hw + 0.005, 2.05, -18.0, 0, Math.PI / 2, 0));

  root.add(skyDome(ctx, 180));

  const dc = bag.flush(root, { 'roadline': { cast: false } });
  DIMENSIONS.alley.drawCallEstimate = dc + 2;
  root.userData.dimensions = DIMENSIONS.alley;
  root.userData.parkingArea = DIMENSIONS.alley.parkingArea;
  return root;
}

/* ==========================================================================
 * 4. 廳三 · 空無停車場
 * ========================================================================== */

export function buildLot(ctx) {
  const THREE = ctx.THREE;
  const root = new THREE.Group();
  root.name = 'arch.lot';
  const bag = GeoBag(ctx);

  const hw = L.W / 2, hd = L.D / 2;

  /* ---- 4.1 地面：向 -X 的 1.5% 排水坡，但 12×12 m 的日格區保持平整 ---- */
  const flatR = L.CELL.size / 2;
  function lotH(x, z) {
    const base = -L.SLOPE * (x + hw) + L.SLOPE * hw;                 // 中心 = 0
    const d = Math.max(Math.abs(x - L.CELL.x), Math.abs(z - L.CELL.z));
    const w = smooth01(flatR, flatR + 3.0, d);                       // 場內圈完全平整
    const ripple = 0.012 * Math.sin(x * 0.23) * Math.sin(z * 0.31);
    return base * w + ripple * w;
  }
  root.add(groundMesh(ctx, 'asphalt', L.W, L.D, 88, 68, lotH, 4.0));
  root.userData.heightAt = lotH;

  /* ---- 4.2 停車格 250 × 550 cm、白線寬 10 cm ---- */
  const sideGeo = bevelBox(THREE, L.LINE_W, 0.008, L.STALL_L, 0.0015);
  const endGeo = bevelBox(THREE, L.STALL_W, 0.008, L.LINE_W, 0.0015);
  const sideI = [], endI = [];
  const bays = [-19.0, -13.0, 9.0, 15.0];        // 4 排停車帶（避開中央日格區）
  for (const bx of bays) {
    const cx = bx + L.STALL_L / 2;
    for (let k = -6; k <= 5; k++) {
      const cz = k * L.STALL_W + L.STALL_W / 2;
      if (Math.abs(cz) < flatR + 3.2 && Math.abs(cx) < flatR + 3.2) continue;
      sideI.push({ p: [cx, lotH(cx, cz - L.STALL_W / 2) + 0.006, cz - L.STALL_W / 2], r: [0, Math.PI / 2, 0] });
      endI.push({ p: [bx + (bx < 0 ? 0 : L.STALL_L), lotH(bx, cz) + 0.006, cz], r: [0, Math.PI / 2, 0] });
    }
    const czEnd = 6 * L.STALL_W - L.STALL_W / 2;
    sideI.push({ p: [cx, lotH(cx, czEnd) + 0.006, czEnd], r: [0, Math.PI / 2, 0] });
  }
  root.add(instanced(ctx, sideGeo, 'roadline', sideI, { cast: false }));
  root.add(instanced(ctx, endGeo, 'roadline', endI, { cast: false }));
  // 車道方向箭頭（真實停車場的地面導引）
  for (const az of [-12, -4, 4, 12]) {
    bag.add('roadline', place(bevelBox(THREE, 2.2, 0.007, 0.16, 0.0015), 0.5, lotH(0.5, az) + 0.006, az));
    bag.add('roadline', place(bevelBox(THREE, 0.7, 0.007, 0.16, 0.0015), 1.35, lotH(1.35, az) + 0.006, az + 0.30, 0, 0.7, 0));
    bag.add('roadline', place(bevelBox(THREE, 0.7, 0.007, 0.16, 0.0015), 1.35, lotH(1.35, az) + 0.006, az - 0.30, 0, -0.7, 0));
  }

  /* ---- 4.3 周界：矮牆 + 鐵網圍籬，高 2.0 m（明確邊界）---- */
  const wallSegs = [
    { w: L.W + 0.6, d: 0.25, x: 0, z: -hd - 0.12 },
    { w: L.W + 0.6, d: 0.25, x: 0, z: hd + 0.12 },
    { w: 0.25, d: L.D, x: -hw - 0.12, z: 0 },
    { w: 0.25, d: L.D, x: hw + 0.12, z: 0 },
  ];
  for (const s of wallSegs) {
    bag.add('concrete.wall', place(bevelBox(THREE, s.w, 0.62, s.d), s.x, lotH(s.x, s.z) + 0.29, s.z));
  }
  // 上方鐵網（0.60 → 2.00 m），每 2.5 m 一根立柱
  const meshPanel = bevelBox(THREE, 2.46, 1.36, 0.012, 0.001);
  const postGeo = bevelBox(THREE, 0.06, 1.55, 0.06);
  const panels = [], posts = [];
  const addFence = (x0, z0x, x1, z1x) => {
    const dx = x1 - x0, dz = z1x - z0x, len = Math.hypot(dx, dz);
    const n = Math.floor(len / 2.5), yaw = Math.atan2(dx, dz) + Math.PI / 2;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, px = x0 + dx * t, pz = z0x + dz * t;
      panels.push({ p: [px, lotH(px, pz) + 1.30, pz], r: [0, yaw, 0] });
    }
    for (let i = 0; i <= n; i++) {
      const t = i / n, px = x0 + dx * t, pz = z0x + dz * t;
      posts.push({ p: [px, lotH(px, pz) + 1.32, pz], r: [0, yaw, 0] });
    }
  };
  addFence(-hw, -hd - 0.12, hw, -hd - 0.12);
  addFence(-hw, hd + 0.12, hw, hd + 0.12);
  addFence(-hw - 0.12, -hd, -hw - 0.12, hd);
  addFence(hw + 0.12, -hd, hw + 0.12, hd);
  root.add(instanced(ctx, meshPanel, 'chainlink', panels, { cast: false }));
  root.add(instanced(ctx, postGeo, 'lightpole', posts));

  /* ---- 4.4 照明燈桿 7 m（4 根，只做外殼，光源由 B3 給）---- */
  const poleParts = [];
  poleParts.push(place(new THREE.CylinderGeometry(0.075, 0.115, L.POLE_H, 14), 0, L.POLE_H / 2, 0));
  poleParts.push(place(bevelBox(THREE, 0.42, 0.10, 0.42), 0, 0.05, 0));                 // 底座
  poleParts.push(place(bevelBox(THREE, 0.30, 0.28, 0.06), 0, 0.75, 0.19));              // 檢修孔蓋
  poleParts.push(place(new THREE.CylinderGeometry(0.055, 0.055, 1.30, 10), 0, L.POLE_H - 0.10, 0.60, Math.PI / 2 - 0.22, 0, 0)); // 燈臂
  const poleGeo = mergeGeos(THREE, poleParts);
  const headParts = [];
  headParts.push(place(bevelBox(THREE, 0.46, 0.14, 0.72), 0, L.POLE_H + 0.10, 1.22));
  headParts.push(place(bevelBox(THREE, 0.40, 0.05, 0.62), 0, L.POLE_H + 0.005, 1.22));
  const headGeo = mergeGeos(THREE, headParts);
  const poleAt = [[-16, -12], [16, -12], [-16, 12], [16, 12]];
  const poleInst = poleAt.map((p, i) => ({ p: [p[0], lotH(p[0], p[1]), p[1]], r: [0, (i % 2 ? 1 : -1) * Math.PI / 2, 0] }));
  root.add(instanced(ctx, poleGeo, 'lightpole', poleInst));
  root.add(instanced(ctx, headGeo, 'track.head', poleInst));

  /* ---- 4.5 只有真實世界才有的雜物：排水溝、輪擋、繳費機、車阻柱、緣石收邊 ---- */
  // 排水明溝（坡度最低的 -X 側）＋ 鑄鐵格柵
  bag.add('concrete.wall', place(bevelBox(THREE, 0.44, 0.30, L.D - 1.0), -hw + 0.55, lotH(-hw + 0.55, 0) - 0.14, 0));
  const grate = bevelBox(THREE, 0.36, 0.035, 0.90, 0.0015);
  const grateI = [];
  for (let i = -17; i <= 17; i++) grateI.push({ p: [-hw + 0.55, lotH(-hw + 0.55, i) + 0.002, i] });
  root.add(instanced(ctx, grate, 'barrier.metal', grateI, { cast: false }));
  // 輪擋（每個停車格前緣一根）
  const stopGeo = bevelBox(THREE, 0.16, 0.11, 1.60, 0.003);
  const stopI = [];
  for (const bx of bays) {
    for (let k = -6; k <= 5; k++) {
      const cz = k * L.STALL_W + L.STALL_W / 2;
      const px = bx + (bx < 0 ? 0.9 : L.STALL_L - 0.9);
      if (Math.abs(cz) < flatR + 3.2 && Math.abs(px) < flatR + 3.2) continue;
      stopI.push({ p: [px, lotH(px, cz) + 0.055, cz] });
    }
  }
  root.add(instanced(ctx, stopGeo, 'barrier.concrete', stopI));
  // 自動繳費機
  bag.add('barrier.metal', place(bevelBox(THREE, 0.46, 1.42, 0.36), 3.2, lotH(3.2, -hd + 2.2) + 0.71, -hd + 2.2));
  bag.add('label.card', place(new THREE.PlaneGeometry(0.30, 0.22), 3.2, lotH(3.2, -hd + 2.2) + 1.10, -hd + 2.0));
  bag.add('lightpole', place(bevelBox(THREE, 0.52, 0.06, 0.42), 3.2, lotH(3.2, -hd + 2.2) + 1.45, -hd + 2.2));
  // 車阻柱（出入口）
  for (let i = 0; i < 5; i++) {
    const px = -2.4 + i * 1.2;
    bag.add('lightpole', place(new THREE.CylinderGeometry(0.055, 0.065, 0.90, 12), px, lotH(px, hd - 0.9) + 0.45, hd - 0.9));
  }
  // 場地緣石收邊（地面與圍牆之間不直接相交）
  for (const s of wallSegs) {
    const cw = s.w > s.d ? s.w - 0.4 : 0.16, cd = s.w > s.d ? 0.16 : s.d - 0.4;
    const ox = s.x === 0 ? 0 : (s.x > 0 ? -0.22 : 0.22);
    const oz = s.z === 0 ? 0 : (s.z > 0 ? -0.22 : 0.22);
    bag.add('curb', place(bevelBox(THREE, cw, 0.20, cd), s.x + ox, lotH(s.x + ox, s.z + oz) + 0.06, s.z + oz));
  }
  // 日格區的鋪面收邊（B6 的 12×12 m 區域邊界，讓玩家看得出來這塊是平的）
  for (const e of [[0, -flatR - 0.2, L.CELL.size + 0.4, 0.14], [0, flatR + 0.2, L.CELL.size + 0.4, 0.14],
                   [-flatR - 0.2, 0, 0.14, L.CELL.size + 0.4], [flatR + 0.2, 0, 0.14, L.CELL.size + 0.4]]) {
    bag.add('curb', place(bevelBox(THREE, e[2], 0.09, e[3]), L.CELL.x + e[0], 0.038, L.CELL.z + e[1]));
  }
  // 荒廢感：裂縫旁的一叢雜草（InstancedMesh）
  const weed = new THREE.PlaneGeometry(0.05, 0.16);
  weed.translate(0, 0.08, 0);
  const weedI = []; const wr = mulberry(0x2C1A77);
  for (let i = 0; i < 900; i++) {
    const px = -hw + wr() * L.W, pz = -hd + wr() * L.D;
    if (Math.max(Math.abs(px - L.CELL.x), Math.abs(pz - L.CELL.z)) < flatR + 1.0) continue;
    weedI.push({ p: [px, lotH(px, pz), pz], r: [0, wr() * Math.PI, 0], s: [1, 0.6 + wr() * 0.9, 1] });
  }
  root.add(instanced(ctx, weed, 'grass.blade', weedI, { cast: false }));

  root.add(skyDome(ctx, 300));

  const dc = bag.flush(root, { 'roadline': { cast: false }, 'curb': { cast: true } });
  DIMENSIONS.lot.drawCallEstimate = dc + 9;
  root.userData.dimensions = DIMENSIONS.lot;
  root.userData.cellField = DIMENSIONS.lot.cellField;
  return root;
}

/* ==========================================================================
 * 5. 廳四 · 五年隧道（弧形拱頂，不是方盒）
 * ========================================================================== */

/** 隧道內壁輪廓：y → 半寬。起拱線以下是微弧側牆，以上是 R=4.5 的圓拱。 */
function tunHalf(y) {
  if (y <= T.SPRING) {
    const k = 1 - y / T.SPRING;
    return T.R - 0.12 * k * k;                       // 下方微微內收 → 是彎曲管壁，不是平牆
  }
  const dy = y - T.SPRING;
  if (dy >= T.R) return 0;
  return Math.sqrt(Math.max(T.R * T.R - dy * dy, 0));
}
function tunHalfOuter(y) {
  const t = T.LINER_T;
  if (y <= T.SPRING) return tunHalf(y) + t;
  const dy = y - T.SPRING, RO = T.R + t;
  if (dy >= RO) return 0;
  return Math.sqrt(Math.max(RO * RO - dy * dy, 0));
}

export function buildTunnel(ctx) {
  const THREE = ctx.THREE;
  const root = new THREE.Group();
  root.name = 'arch.tunnel';
  const bag = GeoBag(ctx);

  const total = T.SEG * T.SEGS;                       // 240 m
  const roadHalf = (T.LANE * T.LANES) / 2;            // 3.5
  const walkOuter = roadHalf + T.WALK_W;              // 4.4

  /* ---- 5.1 襯砌：一段 40 m 的環形斷面 ExtrudeGeometry，用 InstancedMesh 循環 6 段 ---- */
  const NP = 40;
  const inner = [], outer = [];
  for (let i = 0; i <= NP; i++) {
    const y = (i / NP) * T.CROWN;
    inner.push([tunHalf(y), y]);
  }
  const yOuterTop = T.SPRING + T.R + T.LINER_T;
  for (let i = 0; i <= NP; i++) {
    const y = -0.45 + (i / NP) * (yOuterTop + 0.45);
    outer.push([tunHalfOuter(Math.max(y, 0)), y]);
  }
  const shape = new THREE.Shape();
  shape.moveTo(outer[0][0], outer[0][1]);
  for (let i = 1; i <= NP; i++) shape.lineTo(outer[i][0], outer[i][1]);
  for (let i = NP - 1; i >= 0; i--) shape.lineTo(-outer[i][0], outer[i][1]);
  shape.lineTo(-outer[0][0], outer[0][1]);
  shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-inner[0][0], inner[0][1]);
  for (let i = 1; i <= NP; i++) hole.lineTo(-inner[i][0], inner[i][1]);
  for (let i = NP - 1; i >= 0; i--) hole.lineTo(inner[i][0], inner[i][1]);
  hole.lineTo(inner[0][0], inner[0][1]);
  hole.closePath();
  shape.holes.push(hole);
  const liner = new THREE.ExtrudeGeometry(shape, {
    depth: T.SEG, bevelEnabled: false, steps: 1, curveSegments: 1, UVGenerator: undefined,
  });
  liner.translate(0, 0, -T.SEG);                       // 一段從 -40 → 0
  const linerInst = [];
  for (let s = 0; s < T.SEGS; s++) linerInst.push({ p: [0, 0, -s * T.SEG] });
  root.add(instanced(ctx, liner, 'tunnel.tile', linerInst));

  /* ---- 5.2 側壁下方 1.2 m 的深色防污帶（跟著弧度走，內縮 6 mm 防 z-fighting）---- */
  const bandRows = 8;
  const grimeGeo = new THREE.BufferGeometry();
  {
    const pos = [], nor = [], uvv = [], idx = [];
    const zSteps = 24;
    for (const side of [-1, 1]) {
      const base = pos.length / 3;
      for (let r = 0; r <= bandRows; r++) {
        const y = T.WALK_H + (r / bandRows) * T.GRIME_H;
        const x = side * (tunHalf(y) - 0.006);
        const y2 = T.WALK_H + ((r + 0.001) / bandRows) * T.GRIME_H;
        const nx = -side, ny = (tunHalf(y2) - tunHalf(y)) * 0.0;
        for (let k = 0; k <= zSteps; k++) {
          const z = -total * (k / zSteps);
          pos.push(x, y, z); nor.push(nx, ny, 0); uvv.push(-z / 2.0, r / bandRows);
        }
      }
      for (let r = 0; r < bandRows; r++) {
        for (let k = 0; k < zSteps; k++) {
          const a = base + r * (zSteps + 1) + k, b = a + 1, c = a + zSteps + 1, d = c + 1;
          if (side < 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
        }
      }
    }
    grimeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    grimeGeo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    grimeGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvv, 2));
    grimeGeo.setIndex(idx);
  }
  const grime = new THREE.Mesh(grimeGeo, ctx.materials.get('tunnel.grime'));
  grime.receiveShadow = true; grime.castShadow = false; grime.name = 'tunnel.grimeBand';
  root.add(grime);

  /* ---- 5.3 路面（雙線 3.5 m，橫向拱起排水）＋ 兩側高 15 cm 的人行通道 ---- */
  const tunRoad = groundMesh(ctx, 'asphalt', roadHalf * 2, total, 16, 240,
    (x, z) => T.CROWNSLOPE * (1 - Math.pow(clamp(x / roadHalf, -1, 1), 2)) + 0.004 * Math.sin(z * 0.5),
    3.0);
  tunRoad.position.z = -total / 2;
  root.add(tunRoad);
  for (const s of [-1, 1]) {
    bag.add('concrete.wall', place(bevelBox(THREE, T.WALK_W, T.WALK_H + 0.10, total),
      s * (roadHalf + T.WALK_W / 2), (T.WALK_H - 0.10) / 2, -total / 2));
    bag.add('curb', place(bevelBox(THREE, 0.12, T.WALK_H + 0.10, total),
      s * (roadHalf + 0.06), (T.WALK_H - 0.10) / 2 + 0.004, -total / 2));
  }
  // 車道線：中央雙黃線 + 兩側邊線（分段虛線，用 InstancedMesh）
  const dash = bevelBox(THREE, 0.12, 0.006, 3.0, 0.0012);
  const dashI = [];
  for (let z = -2; z > -total; z -= 9) {
    dashI.push({ p: [0, T.CROWNSLOPE + 0.005, z] });
  }
  root.add(instanced(ctx, dash, 'roadline', dashI, { cast: false }));
  for (const s of [-1, 1]) {
    bag.add('roadline', place(bevelBox(THREE, 0.15, 0.006, total - 1.0, 0.0012),
      s * (roadHalf - 0.30), 0.006, -total / 2));
  }

  /* ---- 5.4 隧道燈具外殼（每 10 m 一組，只有外形，光源由 B3 提供）---- */
  const lampParts = [
    place(bevelBox(THREE, 0.30, 0.10, 1.40), 0, 0, 0),                       // 燈體
    place(bevelBox(THREE, 0.26, 0.03, 1.30), 0, -0.062, 0),                  // 燈罩
  ];
  const lampGeo = mergeGeos(THREE, lampParts);
  const braceGeo = mergeGeos(THREE, [
    place(bevelBox(THREE, 0.05, 0.34, 0.05), 0, 0.22, -0.55),
    place(bevelBox(THREE, 0.05, 0.34, 0.05), 0, 0.22, 0.55),
    place(bevelBox(THREE, 0.06, 0.05, 1.30), 0, 0.40, 0),
  ]);
  const lampI = [], braceI = [];
  const lampCount = Math.floor(total / T.LAMP_SPACING);
  for (let i = 0; i < lampCount; i++) {
    const z = -(i + 0.5) * T.LAMP_SPACING;
    for (const s of [-1, 1]) {
      const y = 4.55, x = s * (tunHalf(y) - 0.55);
      lampI.push({ p: [x, y, z], r: [0, 0, -s * 0.55] });
      braceI.push({ p: [x, y, z], r: [0, 0, -s * 0.55] });
    }
  }
  root.add(instanced(ctx, lampGeo, 'track.head', lampI));
  root.add(instanced(ctx, braceGeo, 'track.rail', braceI));
  // 拱頂的排煙風機（真實隧道的識別物）
  for (let i = 0; i < 4; i++) {
    const z = -30 - i * 60;
    bag.add('barrier.metal', place(new THREE.CylinderGeometry(0.55, 0.55, 2.20, 16), 0, T.CROWN - 0.95, z, 0, 0, Math.PI / 2));
    for (const o of [-0.80, 0.80]) {
      bag.add('track.rail', place(bevelBox(THREE, 0.06, 0.55, 0.06), 0, T.CROWN - 0.42, z + o));
    }
  }

  /* ---- 5.5 每 50 m 的緊急電話 / 滅火器箱（門面內凹 12 cm，讀作凹槽）---- */
  const nicheCount = Math.floor(total / T.NICHE_SPACING);
  for (let i = 1; i <= nicheCount; i++) {
    const z = -i * T.NICHE_SPACING;
    const s = (i % 2 === 0) ? 1 : -1;
    const y = 1.05, x = s * (tunHalf(y) - 0.02);
    // 外框（凸出 4 cm）
    bag.add('barrier.metal', place(bevelBox(THREE, 0.10, 1.28, 1.02), x - s * 0.03, y, z));
    // 內凹的箱體門面（往牆內退 12 cm）
    bag.add('tunnel.grime', place(bevelBox(THREE, 0.02, 1.10, 0.84), x - s * 0.14, y, z));
    bag.add('barrier.metal', place(bevelBox(THREE, 0.06, 0.98, 0.72), x - s * 0.10, y, z));
    bag.add('label.card', place(new THREE.PlaneGeometry(0.34, 0.24), x - s * 0.135, y + 0.42, z, 0, s * Math.PI / 2, 0));
    bag.add('track.rail', place(new THREE.CylinderGeometry(0.018, 0.018, 0.12, 8), x - s * 0.12, y, z + 0.30, 0, 0, Math.PI / 2));
    // 里程樁（人行道上）
    bag.add('concrete.wall', place(bevelBox(THREE, 0.16, 0.55, 0.16), s * (roadHalf + 0.55), T.WALK_H + 0.275, z + 3.0));
    bag.add('label.card', place(new THREE.PlaneGeometry(0.13, 0.16), s * (roadHalf + 0.55) - s * 0.082, T.WALK_H + 0.36, z + 3.0, 0, s * Math.PI / 2, 0));
  }

  /* ---- 5.6 洞口門架與兩端封口（明確邊界，不無限延伸）---- */
  for (const [pz, sgn] of [[0.05, 1], [-total - 0.05, -1]]) {
    bag.add('concrete.wall', place(bevelBox(THREE, T.IW + 3.0, T.CROWN + 1.4, 0.30), 0, (T.CROWN + 1.4) / 2 - 0.5, pz + sgn * 0.15));
  }
  // 反光導標（每 25 m，人行道側面）
  const refl = bevelBox(THREE, 0.03, 0.09, 0.05, 0.0008);
  const reflI = [];
  for (let z = -5; z > -total; z -= 25) {
    for (const s of [-1, 1]) reflI.push({ p: [s * (roadHalf + 0.10), 0.10, z] });
  }
  root.add(instanced(ctx, refl, 'track.reflector', reflI, { cast: false }));

  const dc = bag.flush(root, { 'roadline': { cast: false } });
  DIMENSIONS.tunnel.drawCallEstimate = dc + 7;
  root.userData.dimensions = DIMENSIONS.tunnel;
  root.userData.profileHalfWidthAt = tunHalf;
  return root;
}

/* ==========================================================================
 * 6. 廳五 · 賽道
 * ========================================================================== */

/**
 * 中心線控制點 [x, y, z]。y = 路面高度。
 * 佈局：長直線（-480 → +20，共 500 m，起跑線在 x = -20 → 起跑線前 460 m 直線）、
 *       T1–T3、S1、東側髮夾、中段連續彎、S2、西側髮夾、回歸長直線的三個彎。
 * 高低差：0 → 19.5 m。
 */
const CIRCUIT_POINTS = [
  [-480,  0.0, -300],  // P0 起點（長直線頭）
  [-380,  0.9, -300],
  [-280,  2.0, -300],
  [-180,  3.2, -300],
  [ -80,  4.3, -300],
  [  20,  5.2, -300],  // P5 長直線尾（起跑線在 x = -20）
  [ 110,  5.9, -292],  // T1 右
  [ 200,  7.4, -252],
  [ 240,  9.0, -180],  // T2 右
  [ 225, 11.0, -110],  // T3 左
  [ 260, 13.0,  -50],  // T4 右
  [ 330, 15.0,  -20],  // S1-a
  [ 400, 16.2,  -45],  // S1-b（右）
  [ 470, 17.0,  -20],  // S1-c（左）
  [ 540, 18.0,   20],
  [ 590, 19.0,   70],  // 髮夾 1 入
  [ 585, 19.5,  130],
  [ 530, 19.2,  155],  // 髮夾 1 頂點
  [ 470, 18.2,  130],
  [ 440, 16.6,   70],  // 髮夾 1 出
  [ 370, 15.0,   40],
  [ 290, 13.4,   55],  // T7 左
  [ 215, 12.0,   95],
  [ 140, 10.4,   90],  // S2-a
  [  75,  9.0,  130],  // S2-b（左）
  [   5,  8.0,  130],
  [ -60,  7.0,   90],  // S2-c（右）
  [-130,  6.0,   95],
  [-215,  5.0,  140],  // 髮夾 2 入
  [-285,  4.5,  150],
  [-330,  4.0,  105],  // 髮夾 2 頂點
  [-300,  3.5,   50],
  [-235,  3.0,   20],  // 髮夾 2 出
  [-330,  2.5,  -30],  // T10 左
  [-430,  2.0,  -60],
  [-520,  1.4, -120],  // T11
  [-560,  0.8, -210],
  [-545,  0.2, -275],  // T12 最後彎，回到長直線
];

function buildCircuitCurve(THREE) {
  const pts = CIRCUIT_POINTS.map(p => new THREE.Vector3(p[0], p[1], p[2]));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
  curve.arcLengthDivisions = 4000;
  return curve;
}

/** 由曲率推 bank 角（2–8 度），並平滑成一張表。 */
function buildBankTable(THREE, curve, N) {
  const raw = new Float32Array(N);
  const du = 1 / N, eps = 0.5 / N;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3(), dt = new THREE.Vector3();
  const total = curve.getLength();
  for (let i = 0; i < N; i++) {
    const u = i * du;
    curve.getPointAt((u - eps + 1) % 1, a);
    curve.getPointAt(u, b);
    curve.getPointAt((u + eps) % 1, c);
    t1.subVectors(b, a).normalize();
    t2.subVectors(c, b).normalize();
    const ds = total * eps * 2;
    dt.subVectors(t2, t1);
    const kappa = dt.length() / Math.max(ds, 1e-6);
    right.copy(t1).cross(up).normalize();
    const sgn = Math.sign(dt.dot(right)) || 0;
    const k01 = clamp((kappa - 0.0015) / (0.030 - 0.0015), 0, 1);
    raw[i] = k01 <= 0 ? 0 : sgn * (R5.BANK_MIN + (R5.BANK_MAX - R5.BANK_MIN) * k01) * Math.PI / 180;
  }
  // 三次箱型平滑（±14 取樣 ≈ ±30 m）→ 進出彎的傾斜是漸變的，不會突然折起來
  let cur = raw;
  for (let pass = 0; pass < 3; pass++) {
    const out = new Float32Array(N);
    const rad = 14;
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -rad; k <= rad; k++) s += cur[(i + k + N * 2) % N];
      out[i] = s / (rad * 2 + 1);
    }
    cur = out;
  }
  return cur;
}

export function buildCircuit(ctx) {
  const THREE = ctx.THREE;
  const root = new THREE.Group();
  root.name = 'arch.circuit';
  const bag = GeoBag(ctx);
  const rnd = mulberry(0x1F0B2D55);

  const curve = buildCircuitCurve(THREE);
  const lengthM = curve.getLength();
  const BN = 720;
  const bankTable = buildBankTable(THREE, curve, BN);

  const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _u = new THREE.Vector3();

  /** ★ B7 唯一的定位來源。u ∈ [0,1)，pos 即路面中心點。 */
  function sampleAt(u) {
    const uu = ((u % 1) + 1) % 1;
    const pos = curve.getPointAt(uu);
    const tangent = curve.getTangentAt(uu).normalize();
    const f = uu * BN, i0 = Math.floor(f) % BN, i1 = (i0 + 1) % BN, fr = f - Math.floor(f);
    const bank = bankTable[i0] * (1 - fr) + bankTable[i1] * fr;
    const up = new THREE.Vector3(0, 1, 0).applyAxisAngle(tangent, bank);
    return { pos, tangent, up, bank };
  }

  /* ---- 6.1 沿中心線取樣，建立路面框架 ---- */
  const N = R5.SAMPLES;
  const F = [];   // {pos, t, up, right, dist, bank}
  let acc = 0;
  for (let i = 0; i <= N; i++) {
    const u = (i % N) / N;
    const s = sampleAt(u);
    const right = new THREE.Vector3().copy(s.tangent).cross(s.up).normalize();
    if (i > 0) acc += s.pos.distanceTo(F[i - 1].pos);
    F.push({ pos: s.pos, t: s.tangent, up: s.up, right, dist: acc, bank: s.bank });
  }

  /* ---- 6.2 路面（沿 curve 生成，寬 14 m，含 bank）---- */
  function ribbon(matName, latFn, yFn, uvFn, filter) {
    const pos = [], nor = [], uvv = [], idx = [];
    const cols = latFn.length;
    const tmp = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      const f = F[i];
      for (let c = 0; c < cols; c++) {
        tmp.copy(f.pos).addScaledVector(f.right, latFn[c]).addScaledVector(f.up, yFn[c]);
        pos.push(tmp.x, tmp.y, tmp.z);
        nor.push(f.up.x, f.up.y, f.up.z);
        const uvp = uvFn(c, f);
        uvv.push(uvp[0], uvp[1]);
      }
    }
    for (let i = 0; i < N; i++) {
      if (filter && !filter(F[i], F[i + 1])) continue;
      for (let c = 0; c < cols - 1; c++) {
        const a = i * cols + c, b = a + 1, d = a + cols, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    if (idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, ctx.materials.get(matName));
    m.receiveShadow = true; m.castShadow = false; m.name = 'ribbon:' + matName;
    return m;
  }

  const HW = R5.WIDTH / 2;
  const roadLat = [-HW, -HW * 0.5, 0, HW * 0.5, HW];
  root.add(ribbon('asphalt', roadLat, [0, 0, 0, 0, 0],
    (c, f) => [c / (roadLat.length - 1), f.dist / 8.0]));

  /* ---- 6.3 路肩：階梯狀凸起，3 階每階 4 cm，紅白每段 50 cm ---- */
  const stepW = R5.KERB_W / R5.KERB_STEPS;
  const isCorner = (f) => Math.abs(f.bank) > 0.028;      // > 1.6 度才鋪路肩
  for (const side of [-1, 1]) {
    const lat = [], hgt = [];
    for (let s = 0; s < R5.KERB_STEPS; s++) {
      lat.push(side * (HW + s * stepW)); hgt.push(s * R5.KERB_STEP_H);            // 立面下緣
      lat.push(side * (HW + s * stepW)); hgt.push((s + 1) * R5.KERB_STEP_H);      // 立面上緣
      lat.push(side * (HW + (s + 1) * stepW)); hgt.push((s + 1) * R5.KERB_STEP_H);// 踏面
    }
    const km = ribbon('kerb.redwhite', lat, hgt,
      (c, f) => [f.dist / R5.KERB_TILE, c / (lat.length - 1)],
      (a, b) => isCorner(a) || isCorner(b));
    if (km) { km.castShadow = true; root.add(km); }
  }

  /* ---- 6.4 緩衝區 / 草地地形（路肩外 12 m 為緩衝，再外側落到 -4 m 接大地）---- */
  const apronLat = [], apronH = [];
  const OUT = HW + R5.KERB_W;
  const apronSteps = [0, 3, R5.RUNOFF, 26, 70];
  const apronDrop = (L2) => 0.12 - 0.34 * (1 - Math.exp(-L2 / 3.2)) - 0.018 * L2;
  for (const side of [-1, 1]) {
    const lat = [], hgt = [];
    const seq = side < 0 ? apronSteps.slice().reverse() : apronSteps;
    for (const L2 of seq) { lat.push(side * (OUT + L2)); hgt.push(L2 >= 70 ? -0.1 : apronDrop(L2)); }
    if (side < 0) { lat.reverse(); hgt.reverse(); }
    const am = ribbon('soil', lat, hgt, (c, f) => [(OUT + apronSteps[c]) / 6, f.dist / 6]);
    if (am) root.add(am);
  }
  // 遠景大地（填掉緩衝區以外的空洞，並提供明確的視覺底）
  const far = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400, 1, 1), ctx.materials.get('soil'));
  far.geometry.rotateX(-Math.PI / 2);
  far.position.set(60, -4.6, -60);
  far.receiveShadow = true; far.castShadow = false; far.name = 'circuit.farGround';
  root.add(far);

  /* ---- 6.5 草：InstancedMesh 6000 根，onBeforeCompile 注入風的 vertex shader ---- */
  const bladeH = 1.0;
  const blade = new THREE.PlaneGeometry(0.028, bladeH, 1, 4);
  blade.translate(0, bladeH / 2, 0);
  {   // 每根草天生就微彎（不是直挺挺的紙片）
    const p = blade.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const h = p.getY(i) / bladeH;
      p.setZ(i, p.getZ(i) + 0.055 * h * h);
      p.setX(i, p.getX(i) * (1 - 0.65 * h));      // 往上收尖
    }
    p.needsUpdate = true; blade.computeVertexNormals();
  }
  const grassI = [];
  for (let i = 0; i < R5.GRASS_COUNT; i++) {
    const f = F[Math.floor(rnd() * N)];
    const side = rnd() < 0.5 ? -1 : 1;
    const L2 = 4 + rnd() * 18;                    // 距路肩外緣 4–22 m
    const p2 = new THREE.Vector3().copy(f.pos)
      .addScaledVector(f.right, side * (OUT + L2))
      .addScaledVector(f.up, apronDrop(L2));
    const h = 0.05 + rnd() * 0.07;                // 每根高 5–12 cm
    grassI.push({ p: [p2.x, p2.y, p2.z], r: [0, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.25], s: [1, h, 1] });
  }
  const grassMesh = instanced(ctx, blade, 'grass.blade', grassI, { cast: false, receive: false });
  {
    const gm = grassMesh.material;
    if (!gm.userData.__b1Wind) {
      const uT = { value: 0 };
      gm.userData.__b1Wind = uT;
      const prev = gm.onBeforeCompile;
      gm.onBeforeCompile = function (shader, renderer) {
        if (prev) prev.call(this, shader, renderer);
        shader.uniforms.uB1Time = uT;
        shader.vertexShader = 'uniform float uB1Time;\n' + shader.vertexShader.replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            '#ifdef USE_INSTANCING',
            '  float b1h = clamp(position.y, 0.0, 1.0);',
            '  float b1ph = instanceMatrix[3][0] * 0.61 + instanceMatrix[3][2] * 0.83;',
            // 主週期 2π/1.60 ≈ 3.9 s，副週期 ≈ 7.0 s（規格 3–5 秒）
            '  float b1w = sin(uB1Time * 1.60 + b1ph) * 0.62 + sin(uB1Time * 0.90 + b1ph * 1.7) * 0.38;',
            '  transformed.x += b1w * b1h * b1h * 0.42;',
            '  transformed.z += b1w * b1h * b1h * 0.16;',
            '#endif',
          ].join('\n'));
      };
      gm.needsUpdate = true;
    }
    const uT = gm.userData.__b1Wind;
    grassMesh.onBeforeRender = () => { uT.value = performance.now() * 0.001; };
  }
  grassMesh.name = 'circuit.grass';
  root.add(grassMesh);

  /* ---- 6.6 護欄：距賽道邊緣 5 m、高 1.15 m ---- */
  const barLat = HW + R5.BARRIER_OFF;
  const barGeo = mergeGeos(THREE, [
    place(bevelBox(THREE, 0.24, R5.BARRIER_H, 3.90), 0, R5.BARRIER_H / 2, 0),
    place(bevelBox(THREE, 0.40, 0.14, 3.90), 0, 0.07, 0),
  ]);
  const railGeo = mergeGeos(THREE, [
    place(bevelBox(THREE, 0.05, 0.34, 3.90), 0, R5.BARRIER_H + 0.30, 0),
    place(bevelBox(THREE, 0.07, 0.09, 0.09), 0, R5.BARRIER_H + 0.15, -1.9),
  ]);
  const barI = [];
  {
    let next = 0;
    for (let i = 0; i < N; i++) {
      if (F[i].dist < next) continue;
      next = F[i].dist + 4.0;
      const f = F[i];
      const yaw = Math.atan2(f.t.x, f.t.z);
      for (const side of [-1, 1]) {
        const p2 = new THREE.Vector3().copy(f.pos)
          .addScaledVector(f.right, side * barLat)
          .addScaledVector(f.up, apronDrop(R5.BARRIER_OFF - R5.KERB_W));
        barI.push({ p: [p2.x, p2.y, p2.z], r: [0, yaw, 0] });
      }
    }
  }
  root.add(instanced(ctx, barGeo, 'barrier.concrete', barI));
  root.add(instanced(ctx, railGeo, 'barrier.metal', barI));

  /* ---- 6.7 起跑線 / 計時塔 / 旗門 / 輪胎牆 / 廣告板（真實世界雜物）---- */
  // 起跑線：長直線上 x ≈ -20 的位置
  let startIdx = 0, best = 1e9;
  for (let i = 0; i < N; i++) {
    const f = F[i];
    if (f.t.x < 0.9) continue;
    const d = Math.abs(f.pos.x - (-20)) + Math.abs(f.pos.z - (-300));
    if (d < best) { best = d; startIdx = i; }
  }
  const startU = startIdx / N;
  const S0 = F[startIdx];
  {
    const yaw = Math.atan2(S0.t.x, S0.t.z);
    // 起跑線本體（0.5 m 寬白線）+ 發車格
    const line = bevelBox(THREE, R5.WIDTH, 0.010, 0.50, 0.002);
    bag.add('roadline', place(line, S0.pos.x, S0.pos.y + 0.008, S0.pos.z, 0, yaw, 0));
    for (let g = 0; g < 10; g++) {
      const f = F[(startIdx - 6 - g * 5 + N) % N];
      const sd = (g % 2 ? 1 : -1) * (HW * 0.45);
      const p2 = new THREE.Vector3().copy(f.pos).addScaledVector(f.right, sd);
      const gy = Math.atan2(f.t.x, f.t.z);
      bag.add('roadline', place(bevelBox(THREE, 2.6, 0.008, 0.12, 0.002), p2.x, p2.y + 0.007, p2.z, 0, gy, 0));
      bag.add('roadline', place(bevelBox(THREE, 0.12, 0.008, 5.2, 0.002), p2.x, p2.y + 0.007, p2.z, 0, gy, 0));
    }
    // 起跑旗門（跨越賽道的門架）
    const gPos = new THREE.Vector3().copy(S0.pos);
    const gy2 = yaw;
    for (const side of [-1, 1]) {
      const lp = new THREE.Vector3().copy(gPos).addScaledVector(S0.right, side * (HW + 1.4));
      bag.add('barrier.metal', place(new THREE.CylinderGeometry(0.22, 0.28, 8.4, 12), lp.x, lp.y + 4.2, lp.z));
      bag.add('barrier.concrete', place(bevelBox(THREE, 1.20, 0.35, 1.20), lp.x, lp.y + 0.16, lp.z));
    }
    bag.add('barrier.metal', place(bevelBox(THREE, R5.WIDTH + 3.4, 1.10, 0.55), gPos.x, gPos.y + 7.9, gPos.z, 0, gy2, 0));
    bag.add('label.card', place(new THREE.PlaneGeometry(R5.WIDTH + 2.0, 0.85),
      gPos.x - Math.sin(gy2 + Math.PI / 2) * 0.30, gPos.y + 7.9, gPos.z - Math.cos(gy2 + Math.PI / 2) * 0.30, 0, gy2 + Math.PI, 0));
    // 計時塔（旗門旁）
    const tp = new THREE.Vector3().copy(F[(startIdx + 22) % N].pos).addScaledVector(S0.right, -(HW + 12));
    for (let f2 = 0; f2 < 5; f2++) {
      bag.add('barrier.concrete', place(bevelBox(THREE, 6.2, 3.0, 4.4), tp.x, tp.y + 1.5 + f2 * 3.1, tp.z, 0, gy2, 0));
      bag.add('frame.glass', place(new THREE.PlaneGeometry(5.6, 1.9),
        tp.x + S0.right.x * 2.21, tp.y + 1.9 + f2 * 3.1, tp.z + S0.right.z * 2.21, 0, gy2 + Math.PI / 2, 0));
    }
    bag.add('barrier.metal', place(bevelBox(THREE, 6.6, 0.30, 4.8), tp.x, tp.y + 15.8, tp.z, 0, gy2, 0));
  }
  // 輪胎牆：三個危險彎的外側（真的用輪胎材質）
  const tyre = new THREE.CylinderGeometry(0.36, 0.36, 0.24, 14, 1, false);
  const tyreI = [];
  for (const uu of [0.24, 0.52, 0.80]) {
    const i0 = Math.floor(uu * N);
    for (let k = 0; k < 26; k++) {
      const f = F[(i0 + k) % N];
      const side = f.bank > 0 ? -1 : 1;
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 2; col++) {
          const p2 = new THREE.Vector3().copy(f.pos)
            .addScaledVector(f.right, side * (barLat - 0.9 - col * 0.75))
            .addScaledVector(f.up, apronDrop(R5.BARRIER_OFF - R5.KERB_W) + 0.12 + row * 0.25);
          tyreI.push({ p: [p2.x, p2.y, p2.z] });
        }
      }
    }
  }
  root.add(instanced(ctx, tyre, 'car.tire', tyreI));
  // 廣告板（護欄上方，8 面）
  for (let i = 0; i < 8; i++) {
    const f = F[Math.floor((i / 8) * N + 40) % N];
    const side = (i % 2) ? 1 : -1;
    const yaw = Math.atan2(f.t.x, f.t.z);
    const p2 = new THREE.Vector3().copy(f.pos).addScaledVector(f.right, side * (barLat + 0.4))
      .addScaledVector(f.up, apronDrop(R5.BARRIER_OFF - R5.KERB_W));
    bag.add('barrier.metal', place(bevelBox(THREE, 0.10, 1.05, 9.6), p2.x, p2.y + R5.BARRIER_H + 0.70, p2.z, 0, yaw, 0));
    bag.add('label.card', place(new THREE.PlaneGeometry(9.2, 0.88),
      p2.x - f.right.x * side * 0.06, p2.y + R5.BARRIER_H + 0.70, p2.z - f.right.z * side * 0.06,
      0, yaw + (side < 0 ? Math.PI / 2 : -Math.PI / 2), 0));
  }
  // 旗手崗哨（12 個，含遮陽棚與圍網）
  for (let i = 0; i < 12; i++) {
    const f = F[Math.floor((i / 12) * N + 90) % N];
    const side = (i % 2) ? -1 : 1;
    const yaw = Math.atan2(f.t.x, f.t.z);
    const p2 = new THREE.Vector3().copy(f.pos).addScaledVector(f.right, side * (barLat + 2.2))
      .addScaledVector(f.up, apronDrop(R5.BARRIER_OFF + 2.2 - R5.KERB_W));
    for (const o of [-1.1, 1.1]) {
      bag.add('lightpole', place(new THREE.CylinderGeometry(0.05, 0.05, 2.30, 8),
        p2.x + f.t.x * o, p2.y + 1.15, p2.z + f.t.z * o));
    }
    bag.add('barrier.metal', place(bevelBox(THREE, 1.90, 0.07, 2.60), p2.x, p2.y + 2.32, p2.z, 0, yaw, 0));
    bag.add('chainlink', place(new THREE.PlaneGeometry(2.40, 2.20), p2.x, p2.y + 1.10, p2.z, 0, yaw + Math.PI / 2, 0));
  }
  // 距離牌（100 / 200 / 300 m 煞車點）
  for (const uu of [0.20, 0.48, 0.76]) {
    for (let k = 1; k <= 3; k++) {
      const f = F[(Math.floor(uu * N) - k * Math.floor(100 / (lengthM / N)) + N * 3) % N];
      const p2 = new THREE.Vector3().copy(f.pos).addScaledVector(f.right, -(barLat + 1.0))
        .addScaledVector(f.up, apronDrop(R5.BARRIER_OFF - R5.KERB_W));
      bag.add('lightpole', place(new THREE.CylinderGeometry(0.045, 0.045, 1.70, 8), p2.x, p2.y + 0.85, p2.z));
      bag.add('label.card', place(new THREE.PlaneGeometry(0.62, 0.62), p2.x, p2.y + 1.55, p2.z, 0, Math.atan2(f.t.x, f.t.z) + Math.PI / 2, 0));
    }
  }

  root.add(skyDome(ctx, 700));

  const dc = bag.flush(root, { 'roadline': { cast: false }, 'label.card': { cast: false } });
  DIMENSIONS.circuit.lengthM = Math.round(lengthM * 10) / 10;
  DIMENSIONS.circuit.elevationRange = Math.round((19.5 - 0) * 10) / 10;
  DIMENSIONS.circuit.startU = startU;
  DIMENSIONS.circuit.drawCallEstimate = dc + 10;
  root.userData.dimensions = DIMENSIONS.circuit;

  return {
    group: root,
    curve,
    width: R5.WIDTH,
    lengthM,
    sampleAt,
    startU,
    bankTable,
  };
}
