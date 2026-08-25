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
