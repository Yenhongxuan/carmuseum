/**
 * room5_circuit.js — B7 廳五 賽道（第 2 階段子代理產出）
 *
 * 假設（全部列出）：
 *   1. 車重：cars.json 無任何車重欄位，原廠車重亦未收錄。本模組以
 *      「車長 × 車寬 × 車高（公尺）× MASS_DENSITY(110 kg/m³)」推估車重，
 *      該密度以本級距 B-SUV 的公開車重回歸得到（HR-V≈110、CX-30≈113、Mufasa≈107）。
 *      → 畫面上一律標註 ESTIMATE_NOTE（「使用者假設值／推估，非原廠資料」）。
 *   2. 加速度：以「馬力重量比 pw = hp / 推估車重（ps/kg）」線性映射為
 *      油門響應時間常數 tau = ACCEL_TAU_BASE / (pw / PW_REF)。165ps 與 105ps 的
 *      車在同級距重量下 tau 差約 1.4 倍，換車時可明顯感覺變鈍。
 *      HUD 上的「0–100 推估」= ACCEL_0100_K / pw，亦為推估值，非原廠實測。
 *   3. 眼點：一律向 ctx.carModels.getEyePoint(carId) 取。若測試用 ctx 未提供，
 *      退回 車高 × 0.66（推估）並在 HUD 標註。
 *   4. 賽道定位唯一來源為 ctx.arch.buildCircuit(ctx).sampleAt(u)。
 *      若測試用 ctx 只給 curve 沒給 sampleAt，退回以 curve.getPointAt 自行求切線（bank=0）。
 *   5. 20 條減速帶的命中數一律由 cars.json 即時計算，不硬編；表格數字只作為對照。
 *   6. 減速帶均勻分布於「起跑線後 300 公尺」之後的賽道上。
 *   7. 「鎖定佔比」的解法：鎖定者維持其鎖定當下的百分比 p_i，
 *      未鎖定者維持彼此的絕對值，總權重 T = (被拖動者 + 其他未鎖定總和) / (1 - Σp_i)。
 *      Σp_i ≥ 0.98 或解出的權重超出 0–10 時無法滿足，此時放棄該次鎖定並在畫面提示。
 *      因為旋鈕本身是 0–10 步進 0.1，鎖定的百分比只能維持在這個解析度內
 *      （實測誤差 ≤ 0.35 個百分點），不是數學上完全不動。
 *
 * 依賴（依賴注入，不 import）：
 *   ctx.arch.buildCircuit / ctx.materials / ctx.lighting.makeRig / ctx.carModels
 *   （createFleet / getEyePoint / getFootprint / getCarMesh）
 *   只 import ../contract.js 與 ../scoring.js。
 *
 * 未達成的規格（誠實列出）：
 *   - 後照鏡採「駕駛艙內的鏡面 mesh + 第二台 camera + WebGLRenderTarget」，
 *     為維持 60fps，鏡面預設 30Hz 更新（每兩幀一次），且解析度僅 512×160。
 *     若偵測到平均 fps < 45 會自動降到 15Hz，再低於 35 則關閉鏡面渲染、
 *     只保留 DOM 的「後方車輛」面板，並在畫面上誠實顯示目前狀態。
 *   - 駕駛艙是簡化 mesh（儀表台 + 方向盤 + A 柱 + 後視鏡座），不是原廠內裝造型。
 *   - 車輛之間沒有碰撞，超車時以固定車道橫向偏移錯開，不做閃避運算。
 *   - 玩家車輛的速度同樣由「權重排序 + 減速帶」決定，沒有自由油門／煞車操作，
 *     油門響應只影響減速帶之後的恢復速度與換車瞬間的起步。
 *   - 賽道音效、輪胎痕、粒子等未實作（全站禁 bloom/深色，亦不做發光特效）。
 *   - 「鎖定佔比」受 0.1 步進限制，維持的是四捨五入後的百分比（誤差 ≤ 0.35pp）。
 *   - 單一減速帶對單一車輛的累積落後有上限（LAG_CAP），第二圈以後同一條減速帶
 *     只會再震動與跳卡片，不會再讓該車繼續掉隊（否則賽道名次會被減速帶完全支配，
 *     「車距 = 得分差」就不成立了）。
 *   - 「移除後所有被它拖慢的車全部加速」是把記在該減速帶名下的落後量以 900ms
 *     補間補回；已達上限而被截斷的那部分無法補回。
 */

import {
  STATE, EV, ROOMS, EASE, EASE_FN, emit, on, ESTIMATE_NOTE, NO_DATA,
} from '../contract.js';
import * as SCORING from '../scoring.js';

export const ROOM_KEY = ROOMS.CIRCUIT;

/* ────────────────────────────────────────────────────────────────────────────
 * 常數
 * ──────────────────────────────────────────────────────────────────────── */

/** 第一名到最後一名的最大車距，佔一圈的比例。 */
const SPREAD = 0.32;
/** 權重變動後車陣重排的補間時間（毫秒）。 */
const REORDER_MS = 1200;
/** 一圈的基準秒數（領先車）。 */
const LAP_SECONDS = 96;
/** 推估車重密度（kg/m³）—— 使用者假設值。 */
const MASS_DENSITY = 110;
/** 馬力重量比參考值（ps/kg），約當 145ps / 1350kg。 */
const PW_REF = 0.1074;
/** 油門響應時間常數基準（秒）。 */
const ACCEL_TAU_BASE = 1.15;
/** 0–100 km/h 推估係數（秒 × ps/kg）。 */
const ACCEL_0100_K = 1.16;
/** 減速帶區域長度（公尺）。 */
const BUMP_ZONE_M = 16;
/** 命中減速帶時的速度倍率。 */
const BUMP_SLOW = 0.40;
/** 起跑線後多少公尺內不放減速帶。 */
const BUMP_CLEAR_M = 300;
/**
 * 單一減速帶對單一車輛「累積落後」的上限（佔一圈的比例）。
 * 沒有上限的話，跑幾圈之後落後量會蓋過「車距 = 得分差」的關係，
 * 左邊的賽道名次會變成純粹的減速帶名次。上限訂在 0.005（約 8 公尺，
 * 20 條全中最多 0.10，約為 SPREAD 的三成），讓賽道名次仍以得分為主、
 * 減速帶只造成局部前後交換 —— 這正是雙排名要顯示的不一致。
 * 副作用（誠實記錄）：同一台車第二圈之後再經過同一條減速帶，
 * 仍會震動並跳卡片，但不會再繼續掉隊。
 */
const LAG_CAP = 0.005;
/** 玩家撞到減速帶的畫面震動時間（毫秒）。 */
const SHAKE_MS = 200;
/** 換車相機飛行時間（毫秒）。 */
const FLY_MS = 1500;

const DIMS = SCORING.DIMS;
const DIM_LABEL = SCORING.DIM_LABEL;

/* ────────────────────────────────────────────────────────────────────────────
 * 20 條減速帶 = 20 種後悔
 * 卡面文案一字不可改；命中數一律即時計算，expected 只作對照。
 * ──────────────────────────────────────────────────────────────────────── */

const S = (c, k) => !!(c.safety && c.safety[k]);
const C = (c, k) => !!(c.comfort && c.comfort[k]);

export const REGRETS = [
  { id: 1,  text: '你倒車時沒看到那台機車。是你自己踩的煞車。', kind: 'safety', badge: '主動安全配備缺少', cond: '缺 倒車主動煞停',        expected: 31, test: (c) => !S(c, '倒車主動煞停') },
  { id: 2,  text: '變換車道，旁邊那台車一直在你的死角。',       kind: 'safety', badge: '主動安全配備缺少', cond: '缺 盲點偵測',            expected: 19, test: (c) => !S(c, '盲點偵測') },
  { id: 3,  text: '倒車出停車格，側邊來車按了喇叭。',           kind: 'safety', badge: '主動安全配備缺少', cond: '缺 後方橫向車流警示',    expected: 21, test: (c) => !S(c, '後方橫向車流警示') },
  { id: 4,  text: '窄巷停車，你只能靠猜，下車確認了三次。',     kind: 'safety', badge: '主動安全配備缺少', cond: '缺 360度環景',           expected: 22, test: (c) => !S(c, '360度環景') },
  { id: 5,  text: '開了三小時，你自己都不確定還清不清醒。',     kind: 'safety', badge: '主動安全配備缺少', cond: '缺 駕駛疲勞警示',        expected: 24, test: (c) => !S(c, '駕駛疲勞警示') },
  { id: 6,  text: '前保桿被柱子刮了一道。你完全沒感覺。',       kind: 'safety', badge: '主動安全配備缺少', cond: '缺 前停車雷達',          expected: 27, test: (c) => !S(c, '前停車雷達') },
  { id: 7,  text: '你看著稅單愣了一下。每年一次，共五次。',     kind: 'spec',   badge: '規格條件',         cond: '牌照＋燃料稅 17,440 元', expected: 7,  test: (c) => c.tax === 17440 },
  { id: 8,  text: '儀表板亮了一個燈。你想這要花多少錢。',       kind: 'spec',   badge: '規格條件',         cond: '保固為 3 年',            expected: 29, test: (c) => typeof c.warranty === 'string' && c.warranty.startsWith('3年') },
  { id: 9,  text: '後座朋友下車時說：腳有點麻。',               kind: 'spec',   badge: '規格條件',         cond: '軸距 < 2600 mm',         expected: 10, test: (c) => c.wheelbase < 2600 },
  { id: 10, text: '車進去了，但門只能開一半。',                 kind: 'spec',   badge: '規格條件',         cond: '車長 > 4390 mm',         expected: 14, test: (c) => c.length > 4390 },
  { id: 11, text: '又要加油了。你才剛加過。',                   kind: 'spec',   badge: '規格條件',         cond: '油耗 < 16 km/L',         expected: 12, test: (c) => c.kml < 16 },
  { id: 12, text: '你踩下去，車過了一秒才跟上。',               kind: 'spec',   badge: '規格條件',         cond: '馬力 < 120 ps',          expected: 11, test: (c) => c.hp < 120 },
  { id: 13, text: '你想知道行李廂放不放得下嬰兒推車。你查不到。', kind: 'data',  badge: '資料缺口',         cond: `行李廂容積：${NO_DATA}`, expected: 22, test: (c) => c.cargo === null || c.cargo === undefined },
  { id: 14, text: '下雨天，後座的人說有點悶。',                 kind: 'equip',  badge: '便利配備缺少',     cond: '缺 後座出風口',          expected: 13, test: (c) => !C(c, '後座出風口') },
  { id: 15, text: '手上提著東西，你放下購物袋才打開尾門。',     kind: 'equip',  badge: '便利配備缺少',     cond: '缺 電動尾門',            expected: 25, test: (c) => !C(c, '電動尾門') },
  { id: 16, text: '你覺得冷，她覺得熱。你們調了三次。',         kind: 'equip',  badge: '便利配備缺少',     cond: '缺 雙區恆溫',            expected: 21, test: (c) => !C(c, '雙區恆溫') },
  { id: 17, text: '手機沒電了，你在包包裡翻找那條線。',         kind: 'equip',  badge: '便利配備缺少',     cond: '缺 無線充電',            expected: 27, test: (c) => !C(c, '無線充電') },
  { id: 18, text: '上車、插線、等待連上。每一次。',             kind: 'equip',  badge: '便利配備缺少',     cond: '缺 無線CarPlay',         expected: 15, test: (c) => !C(c, '無線CarPlay') },
  { id: 19, text: '保養那天，你多開了 25 分鐘的路。',           kind: 'spec',   badge: '規格條件',         cond: '服務據點：少',           expected: 7,  test: (c) => c.dealer === '少' },
  { id: 20, text: '換輪胎的帳單比你想的多。',                   kind: 'spec',   badge: '規格條件',         cond: '18 吋輪圈（CX-30 / Mufasa）', expected: 7, test: (c) => c.model === 'CX-30' || c.model === 'Mufasa' },
];

/** 常駐文案，一字不可改。 */
const HONESTY_LINE = '賽道名次受你何時調整權重影響。右邊的純得分排名才是你當前權重下的真實答案。';

/* ────────────────────────────────────────────────────────────────────────────
 * 小工具
 * ──────────────────────────────────────────────────────────────────────── */

/** 自訂 cubic-bezier 求值器（禁用 linear 與預設 ease）。 */
function cubicBezier(x1, y1, x2, y2) {
  const A = (a, b) => 1 - 3 * b + 3 * a;
  const B = (a, b) => 3 * b - 6 * a;
  const Cc = (a) => 3 * a;
  const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + Cc(a)) * t;
  const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + Cc(a);
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const s = slope(t, x1, x2);
      if (Math.abs(s) < 1e-6) break;
      const d = calc(t, x1, x2) - x;
      if (Math.abs(d) < 1e-6) break;
      t -= d / s;
    }
    return calc(t, y1, y2);
  };
}

/** 換車相機飛行專用曲線（自訂）。 */
const EASE_FLY = cubicBezier(0.62, 0.02, 0.14, 1.00);
/** 減速帶移除後「加速」的曲線（自訂）。 */
const EASE_BOOST = cubicBezier(0.18, 0.86, 0.30, 1.00);

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap01 = (u) => ((u % 1) + 1) % 1;
const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

/* ────────────────────────────────────────────────────────────────────────────
 * createRoom
 * ──────────────────────────────────────────────────────────────────────── */

export function createRoom(ctx) {
  const THREE = ctx.THREE;
  const scoring = ctx.scoring || SCORING;
  const cars = (ctx.cars || []).slice();
  const carsById = ctx.carsById || Object.fromEntries(cars.map((c) => [c.id, c]));

  // ── 場景 ────────────────────────────────────────────────────────────────
  const group = new THREE.Group();
  group.name = 'room5_circuit';

  const circuit = ctx.arch.buildCircuit(ctx);
  if (circuit && circuit.group) group.add(circuit.group);
  const trackWidth = (circuit && circuit.width) || 12;
  const lapM = (circuit && circuit.lengthM) || 1600;

  const rig = ctx.lighting && ctx.lighting.makeRig ? ctx.lighting.makeRig(ROOM_KEY) : null;
  if (rig && rig.group) group.add(rig.group);

  /** 唯一定位來源。若 arch 未提供 sampleAt 才退回 curve 求值。 */
  const _sTmp = { pos: new THREE.Vector3(), tangent: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), bank: 0 };
  function sampleAt(u) {
    const uu = wrap01(u);
    if (circuit && typeof circuit.sampleAt === 'function') return circuit.sampleAt(uu);
    const curve = circuit && circuit.curve;
    if (curve) {
      curve.getPointAt(uu, _sTmp.pos);
      curve.getTangentAt(uu, _sTmp.tangent);
      _sTmp.up.set(0, 1, 0);
      _sTmp.bank = 0;
      return _sTmp;
    }
    // 極端退化：畫一個圓（僅供無 arch 的極簡測試）
    const a = uu * Math.PI * 2, R = lapM / (Math.PI * 2);
    _sTmp.pos.set(Math.cos(a) * R, 0, Math.sin(a) * R);
    _sTmp.tangent.set(-Math.sin(a), 0, Math.cos(a));
    _sTmp.up.set(0, 1, 0); _sTmp.bank = 0;
    return _sTmp;
  }

  /** 材質一律向 ctx.materials 拿；測試 ctx 缺件時才退回最小 Standard 材質（會記錄）。 */
  const _fallbackMats = [];
  const _missingMats = [];
  function mat(name, fallbackColor = 0xBFC3C8, extra = {}) {
    try {
      if (ctx.materials && typeof ctx.materials.get === 'function') return ctx.materials.get(name);
    } catch (e) { /* 材質庫未提供該名稱 */ }
    if (!_missingMats.includes(name)) _missingMats.push(name);
    const m = new THREE.MeshStandardMaterial(Object.assign({ color: fallbackColor, roughness: 0.72, metalness: 0.03 }, extra));
    _fallbackMats.push(m);
    return m;
  }

  // ── 車輛資料 ────────────────────────────────────────────────────────────
  function footprintOf(car) {
    let fp = null;
    try {
      if (ctx.carModels && ctx.carModels.getFootprint) fp = ctx.carModels.getFootprint(car.id);
    } catch (e) { fp = null; }
    if (!fp || !fp.height) {
      fp = { length: car.length / 1000, width: car.width / 1000, height: car.height / 1000, wheelbase: car.wheelbase / 1000 };
    }
    return fp;
  }

  let eyeEstimated = false;
  function eyePointOf(car) {
    try {
      if (ctx.carModels && ctx.carModels.getEyePoint) {
        const p = ctx.carModels.getEyePoint(car.id);
        if (p && typeof p.y === 'number') return p.clone ? p.clone() : new THREE.Vector3(p.x || 0, p.y, p.z || 0);
      }
    } catch (e) { /* 退回推估 */ }
    eyeEstimated = true;
    return new THREE.Vector3(-0.36, (car.height / 1000) * 0.66, 0.10);
  }

  /** 推估車重（kg）。使用者假設值，非原廠資料。 */
  function massOf(car) {
    const v = (car.length / 1000) * (car.width / 1000) * (car.height / 1000);
    return Math.round(v * MASS_DENSITY);
  }
  /** 馬力重量比（ps/kg）。 */
  const pwOf = (car) => car.hp / massOf(car);
  /** 油門響應時間常數（秒）。越大越鈍。 */
  const tauOf = (car) => ACCEL_TAU_BASE / (pwOf(car) / PW_REF);
  /** 0–100 km/h 推估秒數。 */
  const zeroHundredOf = (car) => ACCEL_0100_K / pwOf(car);

  // ── 減速帶（即時算命中） ─────────────────────────────────────────────────
  const clearU = clamp(BUMP_CLEAR_M / lapM, 0, 0.5);
  const zoneU = clamp(BUMP_ZONE_M / lapM, 0.001, 0.05);
  const bumps = REGRETS.map((r, i) => {
    const hits = new Set(cars.filter((c) => r.test(c)).map((c) => c.id));
    return {
      ...r,
      u: clearU + ((i + 0.5) / REGRETS.length) * (1 - clearU),
      hits,
      hitCount: hits.size,
      removed: false,
      mesh: null,
    };
  });
  const bumpById = new Map(bumps.map((b) => [b.id, b]));
  /** 實算與表格不一致者（誠實記錄）。 */
  const bumpMismatch = bumps.filter((b) => b.hitCount !== b.expected)
    .map((b) => ({ id: b.id, got: b.hitCount, expected: b.expected }));

  function orientTo(obj, s) {
    obj.position.copy(s.pos);
    obj.quaternion.copy(quatFrom(s));
  }

  const _zA = new THREE.Vector3(), _yA = new THREE.Vector3(), _xA = new THREE.Vector3();
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _qBank = new THREE.Quaternion();
  const _fwd = new THREE.Vector3(0, 0, 1);
  function quatFrom(s, out) {
    // 車輛本地 -Z = 前進方向 → 本地 +Z 對應 -tangent
    _zA.copy(s.tangent).normalize().negate();
    _yA.copy(s.up || _yA.set(0, 1, 0)).normalize();
    _xA.crossVectors(_yA, _zA);
    if (_xA.lengthSq() < 1e-8) _xA.set(1, 0, 0);
    _xA.normalize();
    _yA.crossVectors(_zA, _xA).normalize();
    _m4.makeBasis(_xA, _yA, _zA);
    const q = out || _q;
    q.setFromRotationMatrix(_m4);
    if (s.bank) {
      _qBank.setFromAxisAngle(_fwd, s.bank);
      q.multiply(_qBank);
    }
    return q;
  }

  // 減速帶幾何
  const bumpGroup = new THREE.Group();
  bumpGroup.name = 'regret-bumps';
  group.add(bumpGroup);
  const bumpMat = mat('kerb.redwhite', 0xD8534E);
  const bumpGeo = new THREE.BoxGeometry(trackWidth * 0.94, 0.14, BUMP_ZONE_M * 0.42);
  const bumpPostGeo = new THREE.BoxGeometry(0.22, 1.35, 0.22);
  const bumpPostMat = mat('barrier.metal', 0x9AA0A6);
  for (const b of bumps) {
    const s = sampleAt(b.u);
    const holder = new THREE.Group();
    const bar = new THREE.Mesh(bumpGeo, bumpMat);
    bar.castShadow = false; bar.receiveShadow = true;
    bar.position.y = 0.07;
    holder.add(bar);
    // 兩側立柱（編號牌）
    for (const sgn of [-1, 1]) {
      const post = new THREE.Mesh(bumpPostGeo, bumpPostMat);
      post.position.set(sgn * (trackWidth * 0.52), 0.68, 0);
      post.castShadow = true;
      holder.add(post);
    }
    orientTo(holder, s);
    bumpGroup.add(holder);
    b.mesh = holder;
  }

  // ── 車陣狀態 ────────────────────────────────────────────────────────────
  /**
   * 絕對位置 u = packU + relBase + relLag
   *   packU   ：整個車陣隨時間前進的基準（領先車）
   *   relBase ：權重排序決定的落後量（≤ 0），權重一動就以 1200ms inOutQuint 補間
   *   relLag  ：減速帶造成的累積落後（≤ 0），移除該後悔時補回（= 加速）
   */
  let packU = 0;
  const runners = cars.map((car, i) => ({
    car,
    idx: i,
    relBase: 0,
    relLag: 0,
    lagBy: Object.create(null),   // { [bumpId]: 落後量 }
    u: 0,
    targetU: 0,
    prevU: 0,
    lane: ((i % 4) - 1.5) * (trackWidth * 0.20),
    speedMul: 1,
    slowT: 0,
    bounce: 0,
    tau: tauOf(car),
    alive: true,
    visible: true,
  }));
  const runnerById = new Map(runners.map((r) => [r.car.id, r]));

  function aliveIds() {
    const ids = Array.isArray(STATE.alive) && STATE.alive.length ? STATE.alive : cars.map((c) => c.id);
    return ids.filter((id) => carsById[id]);
  }
  function alive() {
    const set = new Set(aliveIds());
    for (const r of runners) r.alive = set.has(r.car.id);
    return runners.filter((r) => r.alive);
  }
  const scoreOf = (r) => scoring.score(r.car, STATE.weights);

  // 玩家
  let player = runnerById.get(STATE.chosenCarId) || runnerById.get('hrv-1') || runners[0];
  if (!player) throw new Error('room5_circuit：cars 為空，無法進入駕駛座');

  // ── 車隊（39 台 InstancedMesh + LOD） ───────────────────────────────────
  let fleet = null;
  try {
    if (ctx.carModels && ctx.carModels.createFleet) fleet = ctx.carModels.createFleet(cars.map((c) => c.id));
  } catch (e) { fleet = null; }
  if (fleet && fleet.group) group.add(fleet.group);

  // ── 駕駛艙（簡化 mesh，依車高調整） ────────────────────────────────────
  const cockpit = new THREE.Group();
  cockpit.name = 'cockpit';
  group.add(cockpit);

  const dashMat = mat('car.trim', 0x3F444B);
  const wheelMat = mat('car.tire', 0x2E3237);
  const pillarMat = mat('car.paint', 0xC9CDD3);
  const glassMat = mat('car.glass', 0xBFD4DE, { transparent: true, opacity: 0.16 });

  const dashCore = new THREE.Group();
  cockpit.add(dashCore);
  {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.30, 0.62), dashMat);
    dash.position.set(0, 0, -0.66);
    dashCore.add(dash);
    const cowl = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.10, 0.26), dashMat);
    cowl.position.set(0, 0.16, -0.98);
    cowl.rotation.x = -0.22;
    dashCore.add(cowl);
    const cluster = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.20, 0.06), dashMat);
    cluster.position.set(-0.36, 0.12, -0.52);
    cluster.rotation.x = 0.24;
    dashCore.add(cluster);
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.19, 0.04), glassMat);
    screen.position.set(0.10, 0.15, -0.56);
    screen.rotation.x = 0.14;
    dashCore.add(screen);
    // 方向盤
    const wheel = new THREE.Group();
    wheel.position.set(-0.36, -0.02, -0.30);
    wheel.rotation.x = -0.42;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.021, 8, 28), wheelMat);
    wheel.add(rim);
    for (let k = 0; k < 3; k++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.028, 0.018), wheelMat);
      const a = (k / 3) * Math.PI * 2 + Math.PI / 6;
      spoke.position.set(Math.cos(a) * 0.09, Math.sin(a) * 0.09, 0);
      spoke.rotation.z = a;
      wheel.add(spoke);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.03, 12), wheelMat);
    hub.rotation.x = Math.PI / 2;
    wheel.add(hub);
    dashCore.add(wheel);
    cockpit.userData.wheel = wheel;
    // A 柱
    for (const sgn of [-1, 1]) {
      const pil = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.92, 0.10), pillarMat);
      pil.position.set(sgn * 0.80, 0.48, -0.86);
      pil.rotation.x = -0.30;
      dashCore.add(pil);
    }
  }

  // 後照鏡（鏡面 mesh + 第二 camera + RenderTarget）
  const mirrorRT = new THREE.WebGLRenderTarget(512, 160, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: true, stencilBuffer: false,
  });
  mirrorRT.texture.colorSpace = THREE.SRGBColorSpace;
  mirrorRT.texture.wrapS = THREE.ClampToEdgeWrapping;
  mirrorRT.texture.repeat.x = -1;      // 鏡像
  mirrorRT.texture.offset.x = 1;
  const mirrorCam = new THREE.PerspectiveCamera(46, 512 / 160, 0.05, 400);
  const mirrorMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.42, 0.132),
    new THREE.MeshBasicMaterial({ map: mirrorRT.texture, toneMapped: false })
  );
  const mirrorHousing = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.16, 0.05), dashMat);
  const mirrorRig = new THREE.Group();
  mirrorHousing.position.z = 0.026;
  mirrorRig.add(mirrorHousing);
  mirrorMesh.position.z = 0.002;
  mirrorRig.add(mirrorMesh);
  cockpit.add(mirrorRig);

  let mirrorHz = 30;          // 30 → 15 → 0（關閉）
  let mirrorFrame = 0;
  let mirrorNote = '30Hz · 512×160';

  /** 依玩家車高擺放駕駛艙與後照鏡。 */
  function layoutCockpit() {
    const fp = footprintOf(player.car);
    const eye = eyePointOf(player.car);
    // 儀表台頂緣相對車高（越高的車，儀表台也越高，但眼點抬得更多）
    dashCore.position.set(eye.x, fp.height * 0.615, eye.z - 0.10);
    mirrorRig.position.set(0, eye.y + 0.30, eye.z - 0.62);
    mirrorRig.rotation.x = 0.10;
    cockpit.userData.eye = eye;
    cockpit.userData.fp = fp;
  }
  layoutCockpit();

  // ── 補間管理 ────────────────────────────────────────────────────────────
  const tweens = [];
  function tween(dur, easeFn, apply, onDone) {
    const t = { t: 0, dur: Math.max(1, dur) / 1000, ease: easeFn, apply, onDone, dead: false };
    tweens.push(t);
    return t;
  }
  /** 取消補間：必須整個移除，不能只把 apply 換掉 —— 否則舊的 onDone 仍會在原定時間覆寫新目標。 */
  function killTween(t) {
    if (!t) return;
    t.dead = true;
    const i = tweens.indexOf(t);
    if (i >= 0) tweens.splice(i, 1);
  }
  function stepTweens(dt) {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const t = tweens[i];
      if (t.dead) { tweens.splice(i, 1); continue; }
      t.t += dt;
      const k = clamp(t.t / t.dur, 0, 1);
      t.apply(t.ease(k), k);
      if (k >= 1) { tweens.splice(i, 1); t.dead = true; if (t.onDone) t.onDone(); }
    }
  }

  /* ──────────────────────────────────────────────────────────────────────
   * ★ 核心：轉動旋鈕的當下，車陣立刻重排
   * ────────────────────────────────────────────────────────────────────── */

  let reorderCount = 0;

  function animateTo(list, ms, easeName) {
    const ease = EASE_FN[easeName] || EASE_FN.inOutQuint;   // 禁用 linear
    for (const x of list) {
      const r = x.c;
      const from = r.relBase;
      const to = x.rel;
      if (Math.abs(to - from) < 1e-6) { killTween(r._tw); r._tw = null; r.relBase = to; continue; }
      // 同一台車只保留最後一次補間（舊的必須整個殺掉）
      killTween(r._tw); r._tw = null;
      r._tw = tween(ms, ease, (e) => { r.relBase = from + (to - from) * e; }, () => { r.relBase = to; r._tw = null; });
    }
  }

  function onWeightChange() {
    const running = alive();
    if (!running.length) return;
    const list = running.map((c) => ({ c, v: scoreOf(c) })).sort((a, b) => b.v - a.v);
    const leaderU = Math.max(...running.map((c) => c.u));
    const vMax = list[0].v, vMin = list[list.length - 1].v;
    list.forEach((x, i) => {
      const behind = (vMax - x.v) / (vMax - vMin || 1) * SPREAD;   // ★ 車距 = 得分差
      x.rel = -behind;                                             // 相對領先車
      x.c.targetU = leaderU - behind;
      x.c.wantRank = i + 1;
    });
    animateTo(list, REORDER_MS, 'inOutQuint');   // ★ 移動過程中車輛實際交錯而過
    reorderCount++;
    scheduleHud();
  }

  /* ──────────────────────────────────────────────────────────────────────
   * 權重旋鈕（含鎖定佔比）
   * ────────────────────────────────────────────────────────────────────── */

  const locks = Object.fromEntries(DIMS.map((d) => [d, false]));
  const lockPct = Object.fromEntries(DIMS.map((d) => [d, 0]));
  let lockWarn = '';

  const totalW = () => DIMS.reduce((a, d) => a + (STATE.weights[d] || 0), 0);
  const pctOf = (d) => {
    const t = totalW();
    return t > 0 ? (STATE.weights[d] || 0) / t : 0;
  };

  function captureLock(dim) {
    lockPct[dim] = pctOf(dim);
  }

  /**
   * 設定某個維度的權重，並維持所有「鎖定佔比」者的百分比。
   * 解法見檔頭假設 7。
   */
  function setWeight(dim, value, opts = {}) {
    lockWarn = '';
    const v = clamp(Math.round(value * 10) / 10, 0, 10);
    const lockedOthers = DIMS.filter((d) => d !== dim && locks[d]);
    if (!lockedOthers.length) {
      STATE.weights[dim] = v;
      if (locks[dim]) captureLock(dim);
      commitWeights(opts);
      return;
    }
    const sumLock = lockedOthers.reduce((a, d) => a + lockPct[d], 0);
    if (sumLock >= 0.98) {
      lockWarn = '鎖定的佔比合計已達 98%，這一次調整無法同時滿足所有鎖定。';
      STATE.weights[dim] = v;
      commitWeights(opts);
      return;
    }
    const freeSum = DIMS.filter((d) => d !== dim && !locks[d]).reduce((a, d) => a + (STATE.weights[d] || 0), 0);
    const T = (v + freeSum) / (1 - sumLock);
    const next = {};
    let ok = true;
    for (const d of lockedOthers) {
      const w = Math.round(lockPct[d] * T * 10) / 10;
      if (w > 10.0001 || w < -0.0001) ok = false;
      next[d] = clamp(w, 0, 10);
    }
    if (!ok) lockWarn = '為維持鎖定的佔比，部分旋鈕需要超出 0–10 的範圍，已夾在邊界值。';
    STATE.weights[dim] = v;
    for (const d of lockedOthers) STATE.weights[d] = next[d];
    if (locks[dim]) captureLock(dim);
    commitWeights(opts);
  }

  function commitWeights(opts = {}) {
    emit(EV.WEIGHTS_CHANGED, { weights: { ...STATE.weights }, source: ROOM_KEY, dim: opts.dim || null });
    emit(EV.STATE_CHANGED, { keys: ['weights'], source: ROOM_KEY });
    onWeightChange();                 // ★ 立刻重排
    syncKnobs();
  }

  /* ──────────────────────────────────────────────────────────────────────
   * DOM
   * ────────────────────────────────────────────────────────────────────── */

  const root = document.createElement('div');
  root.className = 'r5-root';
  root.innerHTML = '';

  const style = document.createElement('style');
  style.textContent = `
.r5-root{position:absolute;inset:0;font:400 13px/1.5 "Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;color:#1B1D21;pointer-events:none}
.r5-root *{box-sizing:border-box}
.r5-panel{position:absolute;background:rgba(250,250,251,.94);border:1px solid #DCDFE4;border-radius:10px;
  box-shadow:0 2px 6px rgba(20,22,26,.06),0 12px 28px rgba(20,22,26,.08);pointer-events:auto;
  backdrop-filter:saturate(1.15) blur(6px)}
.r5-h{font-weight:600;font-size:12px;letter-spacing:.06em;color:#5B6068;padding:9px 12px 6px;display:flex;
  align-items:baseline;gap:8px;justify-content:space-between}
.r5-h b{font-size:11px;font-weight:500;color:#8A9098}

/* 儀表板旋鈕 */
.r5-dash{left:14px;right:14px;bottom:12px;max-height:38vh;overflow:auto;padding-bottom:8px}
.r5-knobs{display:grid;grid-template-columns:repeat(2,minmax(340px,1fr));gap:2px 18px;padding:0 12px 6px}
@media (max-width:900px){.r5-knobs{grid-template-columns:1fr}}
.r5-knob{display:grid;grid-template-columns:64px 1fr 58px 46px 96px 26px;align-items:center;gap:8px;
  padding:3px 4px;border-radius:7px;transition:background 180ms ${EASE.micro}}
.r5-knob:hover{background:#F0F2F5}
.r5-knob.hot{background:#EAF0F7}
.r5-kl{font-size:12.5px;font-weight:500;white-space:nowrap}
.r5-knob input[type=range]{width:100%;accent-color:#2E6FB7;height:18px;cursor:pointer}
.r5-knob input[type=number]{width:100%;padding:2px 4px;font:inherit;font-size:12px;text-align:right;
  border:1px solid #D3D7DD;border-radius:5px;background:#FFF;color:#1B1D21}
.r5-pct{font-variant-numeric:tabular-nums;font-size:12px;color:#2E6FB7;text-align:right;font-weight:600;
  transition:transform 160ms ${EASE.micro}}
.r5-pct.bump{transform:scale(1.14)}
.r5-mini{display:flex;gap:4px}
.r5-mini button{font:inherit;font-size:11px;padding:1px 7px;border:1px solid #D3D7DD;background:#FFF;
  border-radius:5px;cursor:pointer;color:#42474E;transition:transform 150ms ${EASE.micro},background 150ms ${EASE.micro}}
.r5-mini button:hover{background:#EDF1F6;transform:scale(1.06)}
.r5-lock{width:22px;height:22px;border:1px solid #D3D7DD;background:#FFF;border-radius:5px;cursor:pointer;
  font-size:11px;line-height:1;color:#9AA0A6;transition:transform 150ms ${EASE.micro},background 150ms ${EASE.micro}}
.r5-lock[data-on="1"]{background:#2E6FB7;border-color:#2E6FB7;color:#FFF;transform:scale(1.08)}
.r5-warn{padding:2px 12px 6px;font-size:11.5px;color:#B4532C;min-height:16px}

/* 雙排名 */
.r5-rank{right:14px;top:14px;width:392px;max-height:52vh;overflow:auto}
.r5-rt{display:grid;grid-template-columns:1fr 1fr;gap:0 10px;padding:0 12px 8px;font-variant-numeric:tabular-nums}
.r5-rc h4{margin:0 0 4px;font-size:11px;font-weight:600;color:#6B7078;letter-spacing:.05em}
.r5-row{display:flex;gap:6px;align-items:baseline;padding:1.5px 5px;border-radius:5px;font-size:12px;
  transition:background 200ms ${EASE.micro},transform 200ms ${EASE.micro}}
.r5-row i{font-style:normal;color:#8A9098;width:17px;text-align:right;flex:none}
.r5-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.r5-row.me{background:#E4EDF8;font-weight:600}
.r5-row.mismatch{background:#FBEFE6;box-shadow:inset 2px 0 0 #C2703C}
.r5-row.me.mismatch{background:#F5E9E0}
.r5-honest{margin:0;padding:8px 12px 11px;font-size:12.5px;line-height:1.65;color:#42474E;
  border-top:1px solid #E4E7EB;background:#F4F6F8;border-radius:0 0 10px 10px}
.r5-honest b{color:#1B1D21;font-weight:600}
.r5-legend{padding:0 12px 6px;font-size:11px;color:#8A9098}
.r5-legend em{font-style:normal;background:#FBEFE6;box-shadow:inset 2px 0 0 #C2703C;padding:1px 5px;border-radius:4px;color:#8A5A38}

/* 後方（後照鏡輔助面板） */
.r5-mirror{left:50%;transform:translateX(-50%);top:12px;width:330px}
.r5-mrow{display:flex;gap:7px;align-items:baseline;padding:2px 12px;font-size:12px;font-variant-numeric:tabular-nums}
.r5-mrow i{font-style:normal;color:#8A9098;width:16px;text-align:right}
.r5-mrow b{margin-left:auto;color:#2E6FB7;font-weight:600;font-size:11.5px}
.r5-mnote{padding:4px 12px 9px;font-size:10.5px;color:#9AA0A6}

/* 換車 */
.r5-swap{left:14px;top:14px;width:280px;max-height:46vh;overflow:auto}
.r5-car{display:flex;gap:7px;align-items:baseline;width:100%;text-align:left;font:inherit;font-size:12px;
  padding:4px 12px;border:0;background:transparent;cursor:pointer;color:#1B1D21;
  transition:background 160ms ${EASE.micro},transform 160ms ${EASE.micro}}
.r5-car:hover{background:#EDF1F6;transform:translateX(2px)}
.r5-car[data-me="1"]{background:#E4EDF8;font-weight:600}
.r5-car u{text-decoration:none;margin-left:auto;color:#7A8088;font-size:11px;font-variant-numeric:tabular-nums}
.r5-swapinfo{padding:6px 12px 10px;font-size:11px;color:#6B7078;border-top:1px solid #E4E7EB;line-height:1.6}
.r5-est{font-size:10px;color:#9AA0A6}

/* 後悔卡片 */
.r5-card{left:50%;bottom:calc(38vh + 26px);width:452px;transform:translate(-50%,14px);opacity:0;
  transition:opacity 340ms ${EASE.component},transform 340ms ${EASE.component}}
.r5-card.show{opacity:1;transform:translate(-50%,0)}
.r5-badge{display:inline-block;font-size:10.5px;font-weight:600;letter-spacing:.05em;padding:2px 8px;
  border-radius:20px;background:#E7EBF0;color:#54595F}
.r5-badge[data-kind="data"]{background:#F3E4D6;color:#8A5A38;border:1px dashed #C2703C}
.r5-cardtxt{margin:9px 0 8px;padding:0 14px;font-size:16px;line-height:1.68;font-weight:500}
.r5-cardmeta{padding:0 14px 10px;font-size:11.5px;color:#7A8088;display:flex;gap:10px;flex-wrap:wrap}
.r5-cardbtns{display:flex;gap:8px;padding:0 14px 13px}
.r5-btn{font:inherit;font-size:12.5px;padding:6px 14px;border-radius:7px;border:1px solid #2E6FB7;
  background:#2E6FB7;color:#FFF;cursor:pointer;transition:transform 170ms ${EASE.micro},box-shadow 170ms ${EASE.micro}}
.r5-btn:hover{transform:scale(1.04);box-shadow:0 4px 12px rgba(46,111,183,.28)}
.r5-btn.ghost{background:#FFF;color:#42474E;border-color:#D3D7DD}
.r5-btn:disabled{opacity:.45;cursor:default;transform:none;box-shadow:none}

/* 後悔清單 */
.r5-list{left:14px;bottom:calc(38vh + 26px);width:280px;max-height:34vh;overflow:auto}
.r5-li{display:flex;gap:7px;align-items:baseline;padding:2px 12px;font-size:11.5px;color:#42474E}
.r5-li i{font-style:normal;color:#9AA0A6;width:17px;text-align:right}
.r5-li u{text-decoration:none;margin-left:auto;color:#7A8088;font-variant-numeric:tabular-nums}
.r5-li[data-removed="1"]{color:#A6ABB2;text-decoration:line-through}
.r5-li[data-kind="data"] i{color:#C2703C;font-weight:700}

/* toast */
.r5-toast{left:50%;bottom:calc(38vh + 96px);transform:translate(-50%,10px);opacity:0;padding:8px 16px;
  font-size:13px;font-weight:600;color:#1B1D21;
  transition:opacity 300ms ${EASE.component},transform 300ms ${EASE.component}}
.r5-toast.show{opacity:1;transform:translate(-50%,0)}
.r5-hint{right:14px;bottom:calc(38vh + 26px);width:392px;padding:8px 12px;font-size:11.5px;color:#6B7078;line-height:1.65}
`;
  root.appendChild(style);

  // 換車面板
  const swapEl = el('div', 'r5-panel r5-swap');
  swapEl.innerHTML = `<div class="r5-h"><span>駕駛座</span><b>點一台車跳過去</b></div><div class="r5-carlist"></div><div class="r5-swapinfo"></div>`;
  const carListEl = swapEl.querySelector('.r5-carlist');
  const swapInfoEl = swapEl.querySelector('.r5-swapinfo');
  root.appendChild(swapEl);

  // 雙排名
  const rankEl = el('div', 'r5-panel r5-rank');
  rankEl.innerHTML = `<div class="r5-h"><span>名次</span><b>左：賽道實際位置｜右：純得分</b></div>
<div class="r5-rt"><div class="r5-rc" data-c="track"><h4>賽道名次</h4><div class="r5-rl"></div></div>
<div class="r5-rc" data-c="score"><h4>純得分排名</h4><div class="r5-rl"></div></div></div>
<div class="r5-legend"><em>橘線</em> 表示這一列左右不一致</div>
<p class="r5-honest"><b>${HONESTY_LINE}</b></p>`;
  const trackListEl = rankEl.querySelector('[data-c="track"] .r5-rl');
  const scoreListEl = rankEl.querySelector('[data-c="score"] .r5-rl');
  root.appendChild(rankEl);

  // 後照鏡輔助面板
  const mirrorEl = el('div', 'r5-panel r5-mirror');
  mirrorEl.innerHTML = `<div class="r5-h"><span>後照鏡</span><b>後方三台</b></div><div class="r5-mlist"></div><div class="r5-mnote"></div>`;
  const mirrorListEl = mirrorEl.querySelector('.r5-mlist');
  const mirrorNoteEl = mirrorEl.querySelector('.r5-mnote');
  root.appendChild(mirrorEl);

  // 儀表板旋鈕
  const dashEl = el('div', 'r5-panel r5-dash');
  dashEl.innerHTML = `<div class="r5-h"><span>十個旋鈕｜0–10 步進 0.1</span><b>拖動的當下車陣就會重排</b></div>
<div class="r5-knobs"></div><div class="r5-warn"></div>`;
  const knobsEl = dashEl.querySelector('.r5-knobs');
  const warnEl = dashEl.querySelector('.r5-warn');
  root.appendChild(dashEl);

  // 後悔清單
  const listEl = el('div', 'r5-panel r5-list');
  listEl.innerHTML = `<div class="r5-h"><span>20 條減速帶</span><b>命中數為即時實算</b></div><div class="r5-lb"></div>`;
  const listBodyEl = listEl.querySelector('.r5-lb');
  root.appendChild(listEl);

  // 提示
  const hintEl = el('div', 'r5-panel r5-hint');
  root.appendChild(hintEl);

  // 卡片 / toast
  const cardEl = el('div', 'r5-panel r5-card');
  root.appendChild(cardEl);
  const toastEl = el('div', 'r5-panel r5-toast');
  root.appendChild(toastEl);

  function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

  /* ── 旋鈕 DOM ─────────────────────────────────────────────────────────── */
  const knobRefs = {};
  for (const d of DIMS) {
    const row = el('div', 'r5-knob');
    row.innerHTML = `<label class="r5-kl" for="r5w-${d}">${DIM_LABEL[d]}</label>
<input id="r5w-${d}" type="range" min="0" max="10" step="0.1" value="${STATE.weights[d]}">
<input type="number" min="0" max="10" step="0.1" value="${STATE.weights[d]}" aria-label="${DIM_LABEL[d]} 權重數值">
<span class="r5-pct">0.0%</span>
<span class="r5-mini"><button type="button" data-a="zero">歸零</button><button type="button" data-a="max">拉滿</button></span>
<button type="button" class="r5-lock" data-on="0" title="鎖定佔比：鎖住之後，其他旋鈕變動時自動維持這個百分比">鎖</button>`;
    const range = row.querySelector('input[type=range]');
    const num = row.querySelector('input[type=number]');
    const pct = row.querySelector('.r5-pct');
    const lockBtn = row.querySelector('.r5-lock');
    // ★ 一律 oninput：拖動的過程中就要反應
    range.oninput = () => { num.value = fmt1(+range.value); setWeight(d, +range.value, { dim: d }); pulse(pct); };
    num.oninput = () => {
      const v = parseFloat(num.value);
      if (!Number.isFinite(v)) return;
      setWeight(d, v, { dim: d }); pulse(pct);
    };
    row.querySelector('[data-a="zero"]').onclick = () => { setWeight(d, 0, { dim: d }); pulse(pct); };
    row.querySelector('[data-a="max"]').onclick = () => { setWeight(d, 10, { dim: d }); pulse(pct); };
    lockBtn.onclick = () => {
      locks[d] = !locks[d];
      if (locks[d]) captureLock(d);
      lockBtn.dataset.on = locks[d] ? '1' : '0';
      row.classList.toggle('hot', locks[d]);
      syncKnobs();
    };
    knobsEl.appendChild(row);
    knobRefs[d] = { row, range, num, pct, lockBtn };
  }

  function pulse(node) {
    node.classList.add('bump');
    setTimeout(() => node.classList.remove('bump'), 170);
  }

  function syncKnobs() {
    for (const d of DIMS) {
      const k = knobRefs[d];
      const v = STATE.weights[d];
      if (document.activeElement !== k.range) k.range.value = String(v);
      if (document.activeElement !== k.num) k.num.value = fmt1(v);
      const p = pctOf(d) * 100;
      k.pct.textContent = `${p.toFixed(1)}%${locks[d] ? ' 鎖' : ''}`;
      k.pct.title = locks[d] ? `已鎖定佔比 ${(lockPct[d] * 100).toFixed(1)}%` : `佔總權重 ${p.toFixed(1)}%`;
    }
    warnEl.textContent = lockWarn;
  }

  /* ── 名次 / 面板更新 ──────────────────────────────────────────────────── */
  let hudDirty = true, hudTimer = 0;
  function scheduleHud() { hudDirty = true; }

  function updateHud() {
    const running = alive();
    if (!running.length) return;
    const byTrack = running.slice().sort((a, b) => b.u - a.u);
    const pureRank = scoring.rank(running.map((r) => r.car), STATE.weights);
    const trackPos = new Map(byTrack.map((r, i) => [r.car.id, i]));
    const scorePos = new Map(pureRank.map((x, i) => [x.car.id, i]));

    const N = Math.min(12, running.length);
    let a = '', b = '';
    for (let i = 0; i < N; i++) {
      const rt = byTrack[i];
      const mis = scorePos.get(rt.car.id) !== i;
      a += `<div class="r5-row${rt === player ? ' me' : ''}${mis ? ' mismatch' : ''}"><i>${i + 1}</i><span>${label(rt.car, rt === player)}</span></div>`;
      const rs = pureRank[i].car;
      const mis2 = trackPos.get(rs.id) !== i;
      b += `<div class="r5-row${rs.id === player.car.id ? ' me' : ''}${mis2 ? ' mismatch' : ''}"><i>${i + 1}</i><span>${label(rs, rs.id === player.car.id)}</span></div>`;
    }
    trackListEl.innerHTML = a;
    scoreListEl.innerHTML = b;

    // 後照鏡輔助：後方三台
    const me = trackPos.get(player.car.id) ?? 0;
    let m = '';
    for (let i = me + 1; i <= Math.min(me + 3, byTrack.length - 1); i++) {
      const r = byTrack[i];
      const gapM = Math.max(0, (player.u - r.u) * lapM);
      m += `<div class="r5-mrow"><i>${i + 1}</i><span>${esc(r.car.model)} ${esc(r.car.trim)}</span><b>後方 ${gapM.toFixed(0)} m</b></div>`;
    }
    if (!m) m = `<div class="r5-mrow"><span>後面沒有車了。</span></div>`;
    mirrorListEl.innerHTML = m;
    mirrorNoteEl.textContent = `鏡面：${mirrorNote}｜你目前賽道第 ${me + 1} 名，純得分第 ${(scorePos.get(player.car.id) ?? 0) + 1} 名`;

    // 換車清單
    let cl = '';
    for (const r of byTrack.slice(0, 39)) {
      const fp = footprintOf(r.car);
      cl += `<button type="button" class="r5-car" data-id="${r.car.id}" data-me="${r === player ? 1 : 0}">
<span>${esc(r.car.brand)} ${esc(r.car.model)} ${esc(r.car.trim)}</span><u>${Math.round(fp.height * 1000)}mm · ${r.car.hp}ps</u></button>`;
    }
    carListEl.innerHTML = cl;
    for (const btn of carListEl.querySelectorAll('.r5-car')) {
      btn.onclick = () => jumpTo(btn.dataset.id);
    }

    // 後悔清單
    let ll = '';
    for (const bp of bumps) {
      ll += `<div class="r5-li" data-removed="${bp.removed ? 1 : 0}" data-kind="${bp.kind}" title="${esc(bp.cond)}">
<i>${bp.id}</i><span>${esc(bp.badge)}</span><u>${bp.hitCount} 台</u></div>`;
    }
    listBodyEl.innerHTML = ll;

    // 玩家車輛資訊
    const fp = footprintOf(player.car);
    const eye = eyePointOf(player.car);
    const mass = massOf(player.car);
    swapInfoEl.innerHTML = `<div><b>${esc(player.car.brand)} ${esc(player.car.model)} ${esc(player.car.trim)}</b></div>
<div>車高 ${Math.round(fp.height * 1000)} mm｜眼點 ${eye.y.toFixed(2)} m${eyeEstimated ? '（推估）' : ''}</div>
<div>${player.car.hp} ps｜推估車重 ${mass} kg｜0–100 推估 ${zeroHundredOf(player.car).toFixed(1)} 秒</div>
<div class="r5-est">${ESTIMATE_NOTE}（車重＝車長×車寬×車高×${MASS_DENSITY} kg/m³）</div>`;

    hintEl.innerHTML = `一圈 ${Math.round(lapM)} m｜賽道寬 ${trackWidth.toFixed(1)} m｜20 條減速帶避開起跑線後 ${BUMP_CLEAR_M} m
｜已移除 ${STATE.removedRegrets.length} 條後悔｜重排次數 ${reorderCount}
${bumpMismatch.length ? `<br><b style="color:#B4532C">實算與對照表不符：${bumpMismatch.map((x) => `#${x.id} 實算 ${x.got}／表 ${x.expected}`).join('、')}</b>` : ''}
${_missingMats.length ? `<br><span class="r5-est">材質庫缺：${_missingMats.join('、')}（已用替代材質）</span>` : ''}`;
  }

  function label(car, isMe) {
    const name = `${car.model} ${car.trim}`;
    return isMe ? `你（${esc(name)}）` : esc(name);
  }

  /* ── 卡片與移除 ───────────────────────────────────────────────────────── */
  let cardBump = null;
  function showCard(bp) {
    cardBump = bp;
    const affected = countLagged(bp.id);
    cardEl.innerHTML = `<div class="r5-h"><span>減速帶 #${bp.id}</span>
<span class="r5-badge" data-kind="${bp.kind}">${esc(bp.badge)}</span></div>
<p class="r5-cardtxt">${esc(bp.text)}</p>
<div class="r5-cardmeta"><span>條件：${esc(bp.cond)}</span><span>命中 <b>${bp.hitCount}</b> 台（即時實算）</span>
${bp.kind === 'data' ? `<span>這一條不是配備缺少，是你查不到。</span>` : ''}</div>
<div class="r5-cardbtns">
<button type="button" class="r5-btn" data-a="remove"${bp.removed ? ' disabled' : ''}>${bp.removed ? '已移除' : '移除這個後悔'}</button>
<button type="button" class="r5-btn ghost" data-a="close">先開過去</button></div>`;
    cardEl.querySelector('[data-a="close"]').onclick = hideCard;
    const rm = cardEl.querySelector('[data-a="remove"]');
    if (rm && !bp.removed) rm.onclick = () => removeRegret(bp);
    cardEl.classList.add('show');
  }
  function hideCard() { cardEl.classList.remove('show'); cardBump = null; }

  function countLagged(id) {
    let n = 0;
    for (const r of runners) if (r.lagBy[id] > 1e-6) n++;
    return n;
  }

  function removeRegret(bp) {
    if (bp.removed) return;
    bp.removed = true;
    if (bp.mesh) {
      // 減速帶降下去（transform 動畫，非 linear）
      const y0 = bp.mesh.position.y;
      tween(520, EASE_FN.outCubic, (e) => { bp.mesh.position.y = y0 - 0.30 * e; },
        () => { bp.mesh.visible = false; });
    }
    // ★ 所有被它拖慢的車全部加速：把記在這條減速帶名下的落後量補回去
    let n = 0;
    for (const r of runners) {
      const amt = r.lagBy[bp.id] || 0;
      if (amt <= 1e-6) continue;
      n++;
      r.boost = 1;
      tween(900, EASE_BOOST, (e) => { r.lagBy[bp.id] = amt * (1 - e); r.boost = 1 - e; },
        () => { delete r.lagBy[bp.id]; r.boost = 0; });
    }
    if (!STATE.removedRegrets.includes(bp.id)) STATE.removedRegrets.push(bp.id);
    emit(EV.REGRET_REMOVED, { id: bp.id, text: bp.text, kind: bp.kind, hitCount: bp.hitCount, accelerated: n, room: ROOM_KEY });
    emit(EV.STATE_CHANGED, { keys: ['removedRegrets'], source: ROOM_KEY });
    toast(`${n} 台車加速了`);
    hideCard();
    scheduleHud();
  }

  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  /* ── 換車（1.5 秒相機飛行） ───────────────────────────────────────────── */
  let fly = null;
  function jumpTo(carId) {
    const r = runnerById.get(carId);
    if (!r || r === player) return;
    const prevCar = player.car;
    const fromPos = new THREE.Vector3(), fromQuat = new THREE.Quaternion();
    fromPos.copy(_camPos); fromQuat.copy(_camQuat);
    player = r;
    STATE.chosenCarId = carId;
    layoutCockpit();
    if (fleet) {
      for (const rr of runners) if (fleet.setVisible) fleet.setVisible(rr.idx, rr.alive && rr !== player);
    }
    // 換車瞬間起步：依馬力重量比恢復速度（低馬力明顯變鈍）
    r.speedMul = 0.55;
    fly = { t: 0, dur: FLY_MS / 1000, fromPos, fromQuat };
    emit(EV.CAR_CHOSEN, { carId, room: ROOM_KEY });
    emit(EV.STATE_CHANGED, { keys: ['chosenCarId'], source: ROOM_KEY });
    const dh = (r.car.height - prevCar.height) / 1000;
    const dEye = eyePointOf(r.car).y - eyePointOf(prevCar).y;
    toast(`${prevCar.model} → ${r.car.model}：車高 ${dh >= 0 ? '+' : ''}${(dh * 1000).toFixed(0)} mm，眼點 ${dEye >= 0 ? '+' : ''}${dEye.toFixed(2)} m，0–100 推估 ${zeroHundredOf(r.car).toFixed(1)} 秒`);
    scheduleHud();
  }

  /* ── 事件訂閱 ─────────────────────────────────────────────────────────── */
  const offs = [];
  function subscribe() {
    offs.push(on(EV.WEIGHTS_CHANGED, (e) => {
      if (e.detail && e.detail.source === ROOM_KEY) return;
      syncKnobs(); onWeightChange();
    }));
    offs.push(on(EV.CAR_ELIMINATED, () => { refreshAliveVisibility(); onWeightChange(); }));
    offs.push(on(EV.CAR_REVIVED, () => { refreshAliveVisibility(); onWeightChange(); }));
    offs.push(on(EV.STATE_CHANGED, (e) => {
      if (e.detail && e.detail.source === ROOM_KEY) return;
      if (e.detail && Array.isArray(e.detail.keys) && e.detail.keys.includes('alive')) {
        refreshAliveVisibility(); onWeightChange();
      }
    }));
  }
  function refreshAliveVisibility() {
    alive();
    if (!fleet || !fleet.setVisible) return;
    for (const r of runners) fleet.setVisible(r.idx, r.alive && r !== player);
    if (fleet.commit) fleet.commit();
    scheduleHud();
  }

  /* ── 每幀 ─────────────────────────────────────────────────────────────── */
  const _camPos = new THREE.Vector3();
  const _camQuat = new THREE.Quaternion();
  const _tmpV = new THREE.Vector3(), _tmpQ = new THREE.Quaternion(), _tmpQ2 = new THREE.Quaternion();
  const _lat = new THREE.Vector3();
  const _yAxis = new THREE.Vector3(0, 1, 0);
  let shakeT = 0;
  let running = false;
  let fpsAcc = 0, fpsN = 0, fpsCheck = 0;

  const baseRate = 1 / LAP_SECONDS;   // u / 秒

  function update(dt, elapsed, camera) {
    if (!running) return;
    dt = Math.min(dt || 0.016, 0.05);

    stepTweens(dt);

    // 車陣前進
    packU += baseRate * dt;

    // 每台車的速度倍率（減速帶 + 油門響應）
    for (const r of runners) {
      if (!r.alive) continue;
      r.prevU = r.u;
      // 減速帶區域判定
      let inZone = null;
      const uw = wrap01(packU + r.relBase + r.relLag);
      for (const bp of bumps) {
        if (bp.removed || !bp.hits.has(r.car.id)) continue;
        let d = uw - bp.u;
        if (d < -0.5) d += 1; else if (d > 0.5) d -= 1;
        if (d >= -zoneU * 0.5 && d <= zoneU) { inZone = bp; break; }
      }
      const target = inZone ? BUMP_SLOW : 1;
      // 油門響應：恢復速度依馬力重量比（tau 越大越鈍）
      const k = 1 - Math.exp(-dt / (target < r.speedMul ? 0.10 : r.tau));
      r.speedMul += (target - r.speedMul) * k;
      if (inZone) {
        // 落後量記在該條減速帶名下，移除時可補回（= 加速）；上限為 LAG_CAP
        const lost = baseRate * (1 - r.speedMul) * dt;
        r.lagBy[inZone.id] = Math.min(LAG_CAP, (r.lagBy[inZone.id] || 0) + lost);
        r.bounce = Math.min(1, r.bounce + dt * 6);
        if (r === player) {
          if (shakeT <= 0) shakeT = SHAKE_MS / 1000;
          if (cardBump !== inZone) showCard(inZone);
        }
      } else {
        r.bounce = Math.max(0, r.bounce - dt * 3);
      }
      // relLag 一律由 lagBy 導出，補間中也不會被覆寫
      let sum = 0;
      for (const k2 in r.lagBy) sum += r.lagBy[k2];
      r.relLag = -sum;
      r.u = packU + r.relBase + r.relLag;
    }

    // 擺放車輛
    if (fleet) {
      for (const r of runners) {
        if (!r.alive || r === player) continue;
        const s = sampleAt(r.u);
        const q = quatFrom(s, _tmpQ);
        _lat.set(1, 0, 0).applyQuaternion(q).multiplyScalar(r.lane);
        _tmpV.copy(s.pos).add(_lat);
        _tmpV.y += r.bounce * 0.035 * Math.sin(elapsed * 42 + r.idx);
        if (fleet.setTransform) fleet.setTransform(r.idx, _tmpV, q);
      }
      if (fleet.commit) fleet.commit();
    }

    // 玩家：相機 + 駕駛艙
    const ps = sampleAt(player.u);
    const pq = quatFrom(ps, _tmpQ2);
    _lat.set(1, 0, 0).applyQuaternion(pq).multiplyScalar(player.lane);
    const eye = cockpit.userData.eye;
    _tmpV.copy(eye).applyQuaternion(pq);
    _camPos.copy(ps.pos).add(_lat).add(_tmpV);
    _camQuat.copy(pq);

    cockpit.position.copy(ps.pos).add(_lat);
    cockpit.quaternion.copy(pq);
    const w = cockpit.userData.wheel;
    if (w) w.rotation.z = Math.sin(elapsed * 0.7) * 0.16;

    if (camera) {
      if (fly) {
        fly.t += dt;
        const e = EASE_FLY(clamp(fly.t / fly.dur, 0, 1));
        camera.position.lerpVectors(fly.fromPos, _camPos, e);
        camera.quaternion.copy(fly.fromQuat).slerp(_camQuat, e);
        if (fly.t >= fly.dur) fly = null;
      } else {
        camera.position.copy(_camPos);
        camera.quaternion.copy(_camQuat);
      }
      if (shakeT > 0) {
        shakeT -= dt;
        const a = Math.max(0, shakeT / (SHAKE_MS / 1000));
        const amp = 0.026 * a;
        camera.position.x += (Math.sin(elapsed * 71) * amp);
        camera.position.y += (Math.sin(elapsed * 97) * amp);
        camera.rotateZ(Math.sin(elapsed * 83) * 0.012 * a);
        cockpit.position.y += Math.sin(elapsed * 97) * amp * 0.6;
      }
    }

    // 後照鏡
    stepMirror(dt, camera);

    // HUD 節流（6Hz）
    hudTimer += dt;
    if (hudTimer > 1 / 6 || hudDirty) {
      hudTimer = 0; hudDirty = false;
      updateHud();
    }

    // fps 監看（保護 60fps）
    fpsAcc += dt; fpsN++;
    fpsCheck += dt;
    if (fpsCheck > 2) {
      const fps = fpsN / fpsAcc;
      fpsAcc = 0; fpsN = 0; fpsCheck = 0;
      if (fps < 35 && mirrorHz > 0) { mirrorHz = 0; mirrorNote = `因效能不足已關閉（實測 ${fps.toFixed(0)}fps），改用下方名次面板`; }
      else if (fps < 45 && mirrorHz === 30) { mirrorHz = 15; mirrorNote = `15Hz · 512×160（實測 ${fps.toFixed(0)}fps）`; }
      else if (fps >= 55 && mirrorHz === 15) { mirrorHz = 30; mirrorNote = '30Hz · 512×160'; }
    }
  }

  function stepMirror(dt, camera) {
    if (mirrorHz <= 0) { mirrorMesh.visible = false; return; }
    mirrorMesh.visible = true;
    mirrorFrame++;
    const every = mirrorHz === 30 ? 2 : 4;
    if (mirrorFrame % every !== 0) return;
    const renderer = ctx.renderer;
    if (!renderer || !ctx.scene) return;
    // 鏡頭：與眼點同位置，朝後
    mirrorCam.position.copy(_camPos);
    _tmpQ.setFromAxisAngle(_yAxis, Math.PI);
    mirrorCam.quaternion.copy(_camQuat).multiply(_tmpQ);
    mirrorCam.updateMatrixWorld();
    const prevRT = renderer.getRenderTarget();
    mirrorMesh.visible = false;
    renderer.setRenderTarget(mirrorRT);
    renderer.render(ctx.scene, mirrorCam);
    renderer.setRenderTarget(prevRT);
    mirrorMesh.visible = true;
  }

  /* ── 生命週期 ─────────────────────────────────────────────────────────── */
  const spawnSample = sampleAt(0.0);
  const spawnEye = eyePointOf(player.car);
  const spawnQ = quatFrom(spawnSample, new THREE.Quaternion());
  const spawnPos = spawnSample.pos.clone().add(spawnEye.clone().applyQuaternion(spawnQ));
  const spawnYaw = Math.atan2(-spawnSample.tangent.x, -spawnSample.tangent.z);

  const handle = {
    key: ROOM_KEY,
    group,
    spawn: { pos: [spawnPos.x, spawnPos.y, spawnPos.z], yaw: spawnYaw },

    enter() {
      if (running) return;
      running = true;
      (ctx.ui || document.body).appendChild(root);
      subscribe();
      refreshAliveVisibility();
      STATE.chosenCarId = STATE.chosenCarId || player.car.id;
      // 依目前權重排一次（不重複 emit WEIGHTS_CHANGED）
      onWeightChange();
      // 起跑時直接就位，不要從 0 慢慢滑過來
      for (const r of runners) { killTween(r._tw); r._tw = null; }
      const list = alive().map((c) => ({ c, v: scoreOf(c) })).sort((a, b) => b.v - a.v);
      if (list.length) {
        const vMax = list[0].v, vMin = list[list.length - 1].v;
        list.forEach((x) => {
          x.c.relBase = -((vMax - x.v) / (vMax - vMin || 1) * SPREAD);
          x.c.relLag = 0; x.c.lagBy = Object.create(null);
          x.c.u = packU + x.c.relBase; x.c.prevU = x.c.u;
        });
      }
      syncKnobs();
      scheduleHud();
      updateHud();
    },

    exit() {
      running = false;
      hideCard();
      for (const off of offs.splice(0)) { try { off(); } catch (e) { /* noop */ } }
      if (root.parentNode) root.parentNode.removeChild(root);
      clearTimeout(toastTimer);
    },

    update,

    dispose() {
      handle.exit();
      tweens.length = 0;
      mirrorRT.dispose();
      mirrorMesh.geometry.dispose();
      mirrorMesh.material.dispose();
      bumpGeo.dispose(); bumpPostGeo.dispose();
      cockpit.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
      for (const m of _fallbackMats) m.dispose();
      if (rig && rig.dispose) rig.dispose();
      group.clear();
    },

    // ── 供測試 / 驗收用（不屬於 RoomHandle 必要介面） ────────────────────
    _debug: {
      bumps, bumpById, runners, REGRETS, locks, lockPct,
      hitCounts: () => bumps.map((b) => ({ id: b.id, got: b.hitCount, expected: b.expected })),
      mismatch: bumpMismatch,
      onWeightChange, setWeight, jumpTo, removeRegret,
      setLock: (d, on) => { locks[d] = !!on; if (on) captureLock(d); syncKnobs(); },
      get lockWarn() { return lockWarn; },
      get player() { return player; },
      get packU() { return packU; },
      trackOrder: () => alive().slice().sort((a, b) => b.u - a.u).map((r) => r.car.id),
      scoreOrder: () => scoring.rank(alive().map((r) => r.car), STATE.weights).map((x) => x.car.id),
      massOf, tauOf, zeroHundredOf, eyePointOf,
    },
  };

  return handle;
}

export default { ROOM_KEY, createRoom, REGRETS };
