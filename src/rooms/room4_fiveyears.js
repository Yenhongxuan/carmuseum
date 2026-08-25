/**
 * room4_fiveyears.js — B6 廳四·五年（第 2 階段子代理產出）
 *
 * 主題：走進隧道，時間加速。車在眼前積灰、輪胎下沉、車漆變暗；九個轉折逐一撞上你的決定。
 *
 * 假設（全部為使用者假設值／推估，非原廠資料；畫面上以小字同步標明）：
 *   - 隧道長度            120 公尺 = 60 個月（2 公尺／月）
 *   - 時間推進            以「玩家前進距離」為主；若玩家原地不動，以 1.0 m/s 自動前進
 *                         （＝ 2 秒／月、120 秒走完五年，與規格的 120 秒相符）
 *   - 積灰                ctx.materials.setDust(月/60)，0 → 1
 *   - 輪胎下沉            五年下沉 1.8 公分（車身 y 由 0 線性降到 −0.018）
 *   - 殘值曲線（推估）    第 1–5 年 78% / 67% / 57% / 47% / 38.4%，月內線性內插
 *                         （38.4% 與廳三同一組校準值）
 *   - 貸款（推估）        貸 8 成、年利率 3.5%、期數 60 期、等額本息
 *   - 新車規費（推估）    30,000 元（領牌、登記、強制險、代辦合計）
 *   - 換車代價            折舊（推估）＋ 剩餘貸款 ＋ 新車規費
 *   - 五年總帳的保養／保險為推估：保養 9,000 元／年、保險 18,000 元／年
 *   - 油錢／稅金／停車費沿用廳三同一組假設（181 km/用車日、30.0 元/L、3,000 元/月）
 *
 * ★ 台數一律由 data/cars.json 即時 filter 算出，程式中沒有任何硬編台數。
 *   node 實算結果（與 MODULE_API §10 使用者裁決的「以資料為準」完全一致）：
 *     第3月 12｜第8月 5｜第14月 22｜第19月 14｜第24月 17｜
 *     第31月 14｜第37月 29｜第42月 13｜第50月 7｜第58月（賣車）39
 *   受衝擊次數（九個轉折，不含第 58 月「全部都要賣」）：
 *     Mazda CX-30 四個車型皆 7 次 ✔ 全場最高，與文案相符
 *     最低為 2 次，共 14 個車型並列；其中含 Corolla Cross 1.8 Hybrid The 60th / GR Sport / 旗艦、
 *     HR-V e:HEV Prestige / Prestige Super Edition ✔ 與文案相符
 *     ⚠ 但 Corolla Cross 1.8 Hybrid豪華 為 3 次、HR-V e:HEV S 為 3 次，
 *       所以「Corolla Cross Hybrid 系列」並非整個系列都是 2 次。文案照原文顯示，
 *       畫面上另以小字揭露此差異與逐台實算值，不假裝。
 *
 * 依賴（一律依賴注入，不 import）：
 *   ctx.THREE / ctx.arch.buildTunnel / ctx.materials（get / setDust）/
 *   ctx.lighting.makeRig(+ rig.setTravel) / ctx.carModels.getCarMesh
 *   只 import ../contract.js。
 *
 * 未達成的規格（誠實列出）：
 *   - 「車漆變暗」完全交給 ctx.materials.setDust()，本模組不直接改共用材質的顏色。
 *   - 地面碎裂是「自建的一層碎裂板」往下掉並露出下層混凝土板，不是把 B1 的地板真的切開。
 *   - 鏡頭震動以每幀加/減偏移量實作；若外部同時有相機控制器，兩者可能互相輕微干擾。
 *   - 場景內文字一律 DOM overlay（碑文以 3D 座標投影定位），無 3D 文字幾何。
 */

import { ROOMS, STATE, EV, emit, EASE, EASE_FN, ESTIMATE_NOTE, NO_DATA } from '../contract.js';

export const ROOM_KEY = ROOMS.FIVE_YEARS;

/* ───────────────────────── 常數與假設 ───────────────────────── */

const MONTHS       = 60;
const TUNNEL_LEN   = 120;                 // 公尺
const M_PER_MONTH  = TUNNEL_LEN / MONTHS; // 2 公尺／月
const AUTO_SPEED   = 1.0;                 // m/s → 2 秒／月
const TIRE_SINK    = 0.018;               // 五年下沉 1.8 cm

const A = {
  FUEL_PRICE: 30.0,
  KM_PER_USE_DAY: 181,
  PARK_PER_MONTH: 3000,
  USE_DAYS_PER_YEAR: 52,
  YEARS: 5,
  RESIDUAL_CURVE: [1, 0.78, 0.67, 0.57, 0.47, 0.384],   // index = 年
  LOAN_RATIO: 0.80,
  LOAN_APR: 0.035,
  LOAN_TERMS: 60,
  NEW_CAR_FEE: 30000,
  MAINT_PER_YEAR: 9000,
  INSURE_PER_YEAR: 18000,
};

/* ───────────────────────── 九個轉折（條件不可改） ───────────────────────── */

const TURNS = [
  { m: 3,  title: '公司搬家，通勤 8km → 25km',
    cond: (c) => c.kml < 16,                        label: '油耗 < 16 km/L' },
  { m: 8,  title: '你爸中風，每週載他回診',
    cond: (c) => c.height < 1560,                   label: '車高 < 1,560 mm（上下車要彎腰）' },
  { m: 14, title: '她懷孕了',
    cond: (c) => c.cargo === null,                  label: `行李廂容積：${NO_DATA}` },
  { m: 19, title: '停車場改建，車位縮短 30 公分',
    cond: (c) => c.length > 4390,                   label: '車長 > 4,390 mm' },
  { m: 24, title: '油價漲到 38 元',
    cond: (c) => c.kml < 17,                        label: '油耗 < 17 km/L' },
  { m: 31, title: '雨天追撞前車',
    cond: (c) => c.safetyCount < 6,                 label: '主動安全項目 < 6' },
  { m: 37, title: '保固到期後三個月變速箱異音',
    cond: (c) => String(c.warranty).startsWith('3年'), label: '保固以「3年」起算' },
  { m: 42, title: '換工作要跑中南部',
    cond: (c) => c.hp < 120 || c.dealer === '少',   label: '馬力 < 120 hp 或 服務據點「少」' },
  { m: 50, title: '政府調高大排氣量貨物稅',
    cond: (c) => c.tax === 17440,                   label: '稅金 = 17,440 元' },
];
const SELL_TURN = { m: 58, title: '你決定賣車', cond: () => true, label: '全部' };
const ALL_TURNS = TURNS.concat([SELL_TURN]);

/* 第 14 月：一字不可改。這是資料缺口，不是規格缺點。 */
const LINE_M14 =
  '「你選的這台車，<b>行李廂容積原廠從未公布</b>——你在買之前根本<b>查不到</b>它放不放得下。」';

/* ★ 必須揭露（一字不可改） */
const DISCLOSURE = [
  '<b>主動安全 11/11 全滿的 Mazda CX-30，在九個轉折中受衝擊 7 次，是全場最脆弱的。</b>',
  '它同時具備：車高最低、油耗最差、車長最長、稅金最高、輪胎最貴。',
  '<b>配備最強 ≠ 最撐得住。</b>',
  'Corolla Cross Hybrid 系列與 HR-V e:HEV Prestige 只受衝擊 2 次，最穩健。',
];

/* ───────────────────────── 計算 ───────────────────────── */

const nf = (n) => Math.round(n).toLocaleString('en-US');
const wan = (n) => (n / 10000);

function residualAt(month) {
  const y = Math.max(0, Math.min(A.YEARS, month / 12));
  const i = Math.floor(y), f = y - i;
  const a = A.RESIDUAL_CURVE[Math.min(i, A.YEARS)];
  const b = A.RESIDUAL_CURVE[Math.min(i + 1, A.YEARS)];
  return a + (b - a) * f;
}
function loanBalance(price, month) {
  const P = price * A.LOAN_RATIO;
  const r = A.LOAN_APR / 12;
  const n = A.LOAN_TERMS;
  const m = Math.max(0, Math.min(n, Math.round(month)));
  if (r === 0) return P * (1 - m / n);
  const pow = Math.pow(1 + r, n);
  const pay = P * r * pow / (pow - 1);
  return Math.max(0, P * Math.pow(1 + r, m) - pay * (Math.pow(1 + r, m) - 1) / r);
}
function switchCost(car, month) {
  const dep = car.price * (1 - residualAt(month));
  const loan = loanBalance(car.price, month);
  const fee = A.NEW_CAR_FEE;
  return { dep, loan, fee, total: dep + loan + fee };
}
function fuelCostMonths(car, months) {
  const days = A.USE_DAYS_PER_YEAR * (months / 12);
  return days * A.KM_PER_USE_DAY / car.kml * A.FUEL_PRICE;
}
/** 每台車在九個轉折中的受衝擊次數（不含第 58 月「全部」） */
function impactCount(car) { return TURNS.reduce((n, t) => n + (t.cond(car) ? 1 : 0), 0); }

/* ───────────────────────── 小工具 ───────────────────────── */

function pickMaterial(ctx, ...names) {
  const lib = ctx.materials;
  if (lib) {
    for (const n of names) {
      try {
        if (typeof lib.has === 'function' ? lib.has(n) : true) return lib.get(n);
      } catch (_) { /* 換下一個候選 */ }
    }
  }
  return new ctx.THREE.MeshStandardMaterial({ color: 0xd5d6d9, roughness: 0.9, metalness: 0 });
}
function el(tag, cls, html) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html != null) d.innerHTML = html;
  return d;
}

/* ───────────────────────── 主體 ───────────────────────── */

export function createRoom(ctx) {
  const T = ctx.THREE;
  const cars = (ctx.cars && ctx.cars.length) ? ctx.cars : [];
  const uiRoot = ctx.ui || document.body;

  const group = new T.Group();
  group.name = ROOM_KEY;

  let rig = null;
  if (ctx.arch && typeof ctx.arch.buildTunnel === 'function') group.add(ctx.arch.buildTunnel(ctx));
  if (ctx.lighting && typeof ctx.lighting.makeRig === 'function') {
    rig = ctx.lighting.makeRig(ROOM_KEY);
    if (rig && rig.group) group.add(rig.group);
  }

  /* —— 被時間磨損的那台車 —— */
  function pickCar() {
    if (STATE.chosenCarId) {
      const c = cars.find((x) => x.id === STATE.chosenCarId);
      if (c) return c;
    }
    if (Array.isArray(STATE.alive) && STATE.alive.length) {
      const c = cars.find((x) => x.id === STATE.alive[0]);
      if (c) return c;
    }
    // 預設挑一台「行李廂容積原廠從未公布」的車，讓第 14 月那句對得上資料
    return cars.find((c) => c.cargo === null) || cars[0] || null;
  }
  let car = pickCar();

  const carHolder = new T.Group();
  group.add(carHolder);
  let carMesh = null;
  function mountCar() {
    if (carMesh) { carHolder.remove(carMesh); carMesh = null; }
    if (!car || !ctx.carModels || typeof ctx.carModels.getCarMesh !== 'function') return;
    try {
      carMesh = ctx.carModels.getCarMesh(car.id);
      if (carMesh) {
        carMesh.traverse?.((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        carHolder.add(carMesh);
      }
    } catch (_) { carMesh = null; }
  }
  mountCar();

  /* —— 碎裂板 + 下層混凝土 —— */
  const SH = { cols: 6, rows: 5, w: 1.15, d: 1.30 };
  const slabGeo = new T.BoxGeometry(SH.w * 0.96, 0.11, SH.d * 0.96);
  const slabMat = pickMaterial(ctx, 'tunnel.tile', 'concrete.wall');
  const shatterRoot = new T.Group();
  shatterRoot.visible = false;
  group.add(shatterRoot);

  const subGeo = new T.BoxGeometry(SH.cols * SH.w + 1.2, 0.3, SH.rows * SH.d + 1.2);
  const subMat = pickMaterial(ctx, 'concrete.wall', 'barrier.concrete');
  const subFloor = new T.Mesh(subGeo, subMat);
  subFloor.position.y = -1.62;
  subFloor.receiveShadow = true;
  shatterRoot.add(subFloor);

  const slabs = [];
  for (let r = 0; r < SH.rows; r++) {
    for (let c = 0; c < SH.cols; c++) {
      const mesh = new T.Mesh(slabGeo, slabMat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      const x = (c - (SH.cols - 1) / 2) * SH.w;
      const z = (r - (SH.rows - 1) / 2) * SH.d;
      mesh.position.set(x, 0.055, z);
      shatterRoot.add(mesh);
      const h = (c * 7 + r * 13);
      slabs.push({
        mesh, x, z,
        vy: 0, spin: [Math.sin(h) * 1.4, Math.cos(h * 1.7) * 0.9, Math.sin(h * 2.3) * 1.4],
        delay: (Math.hypot(x, z) / 4.2) * 0.42 + (Math.abs(Math.sin(h * 3.1)) * 0.16),
        rest: -1.42 + Math.abs(Math.sin(h * 5.7)) * 0.12,
      });
    }
  }

  /* —— 碑 —— */
  const steleGeo = new T.BoxGeometry(0.92, 1.55, 0.20);
  const steleMat = pickMaterial(ctx, 'court.stone', 'barrier.concrete', 'concrete.wall');
  const steles = [];   // { mesh, node, text }

  /* ───────────────── DOM ───────────────── */

  const dom = el('div', 'r4-root');
  const style = el('style');
  style.textContent = `
.r4-root{position:absolute;inset:0;color:#17191C;
  font:400 15px/1.62 "Noto Sans TC","PingFang TC","Helvetica Neue",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;pointer-events:none}
.r4-root *{box-sizing:border-box}
.r4-note{margin-top:10px;font-size:11px;line-height:1.55;color:#8A9096;letter-spacing:.02em}
.r4-hud{position:absolute;left:30px;top:30px;width:264px;
  background:rgba(255,255,255,.90);border:1px solid #D6D8DC;border-radius:3px;padding:13px 16px}
.r4-hud .big{font-size:27px;font-weight:700;line-height:1.15;font-variant-numeric:tabular-nums}
.r4-hud .sub{font-size:12px;color:#6A6F76;margin-top:2px}
.r4-bar{height:3px;background:#DDE0E4;border-radius:2px;margin-top:11px;overflow:hidden}
.r4-bar i{display:block;height:100%;width:0;background:#A8442E;transform-origin:left center;
  transition:width 180ms ${EASE.micro}}
.r4-log{position:absolute;right:30px;top:30px;width:302px;
  background:rgba(255,255,255,.90);border:1px solid #D6D8DC;border-radius:3px;padding:13px 15px}
.r4-log h3{margin:0 0 7px;font-size:12px;font-weight:700;letter-spacing:.06em;color:#6A6F76}
.r4-log .li{display:flex;gap:9px;font-size:12.5px;padding:2.5px 0;opacity:.32;
  transition:opacity 320ms ${EASE.component}}
.r4-log .li.on{opacity:1}
.r4-log .li u{text-decoration:none;color:#8A9096;flex:0 0 42px;font-variant-numeric:tabular-nums}
.r4-log .li em{font-style:normal;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.r4-log .li s{text-decoration:none;font-variant-numeric:tabular-nums;font-weight:600;flex:0 0 46px;text-align:right}
.r4-log .li.hit s{color:#A8442E}
.r4-card{position:absolute;left:50%;bottom:52px;width:min(680px,calc(100% - 72px));
  transform:translate(-50%,18px);background:rgba(255,255,255,.95);
  border:1px solid #D6D8DC;border-left:3px solid #A8442E;border-radius:3px;
  padding:20px 24px 18px;pointer-events:auto;opacity:0;visibility:hidden;
  transition:opacity 380ms ${EASE.component},transform 380ms ${EASE.component}}
.r4-card.on{opacity:1;visibility:visible;transform:translate(-50%,0)}
.r4-card .when{font-size:12px;letter-spacing:.08em;color:#8A9096}
.r4-card h2{margin:5px 0 8px;font-size:22px;font-weight:700;line-height:1.45}
.r4-card p{margin:0 0 4px;font-size:14.5px;color:#3A3F45}
.r4-card p.quote{font-size:17px;line-height:1.7;color:#17191C;margin:10px 0 6px}
.r4-card b{font-weight:700;color:#17191C}
.r4-ask{margin-top:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.r4-ask .q{font-size:15px;font-weight:600;margin-right:4px}
.r4-btn{appearance:none;border:1px solid #C3C7CC;background:#fff;color:#17191C;
  border-radius:3px;padding:9px 18px;font:inherit;font-size:14px;cursor:pointer;
  transition:transform 170ms ${EASE.micro},border-color 170ms ${EASE.micro},background 170ms ${EASE.micro}}
.r4-btn:hover{border-color:#8A9096;transform:translateY(-1px)}
.r4-btn.warn{border-color:#A8442E;color:#A8442E}
.r4-btn.warn:hover{background:#A8442E;color:#fff}
.r4-cost{margin-top:14px;border-top:1px solid #DDE0E4;padding-top:12px}
.r4-cost .row{display:flex;justify-content:space-between;font-size:13.5px;padding:3px 0}
.r4-cost .row.tot{border-top:1px solid #DDE0E4;margin-top:5px;padding-top:7px;font-weight:700;font-size:15px}
.r4-cost .row s{text-decoration:none;font-variant-numeric:tabular-nums}
.r4-stele{position:absolute;transform:translate(-50%,-100%);white-space:nowrap;
  background:rgba(255,255,255,.94);border:1px solid #A8442E;border-radius:3px;
  padding:6px 11px;font-size:12px;opacity:0;transition:opacity 420ms ${EASE.component}}
.r4-stele.on{opacity:1}
.r4-stele b{display:block;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}
.r4-final{position:absolute;left:50%;top:50%;transform:translate(-50%,-48%) scale(.985);
  width:min(760px,calc(100% - 64px));max-height:calc(100% - 64px);overflow:auto;
  background:rgba(255,255,255,.96);border:1px solid #D6D8DC;border-radius:3px;
  padding:26px 30px;pointer-events:auto;opacity:0;visibility:hidden;
  transition:opacity 620ms ${EASE.region},transform 620ms ${EASE.region}}
.r4-final.on{opacity:1;visibility:visible;transform:translate(-50%,-50%) scale(1)}
.r4-final h2{margin:0 0 4px;font-size:23px;font-weight:700}
.r4-final h4{margin:20px 0 7px;font-size:12px;letter-spacing:.07em;color:#6A6F76}
.r4-final .row{display:flex;justify-content:space-between;gap:16px;font-size:13.5px;
  padding:4px 0;border-bottom:1px dotted #DDE0E4}
.r4-final .row.tot{font-weight:700;font-size:15.5px;border-bottom:0;border-top:1px solid #C9CCD1;margin-top:5px;padding-top:8px}
.r4-final .row s{text-decoration:none;font-variant-numeric:tabular-nums}
.r4-disc{margin-top:18px;border-left:3px solid #A8442E;padding:12px 16px;background:#F6F1EE}
.r4-disc p{margin:0 0 5px;font-size:14.5px;line-height:1.72}
.r4-disc p:last-of-type{margin-bottom:0}
`;
  dom.appendChild(style);

  const hud = el('div', 'r4-hud');
  const log = el('div', 'r4-log');
  const card = el('div', 'r4-card');
  const final = el('div', 'r4-final');
  dom.append(hud, log, card, final);

  /* ───────────────── 狀態 ───────────────── */

  const st = {
    travel: 0, month: 0, running: false,
    lastCamZ: null,
    frozen: false,
    idx: 0,                    // 下一個要觸發的轉折
    pending: null,             // { turn, wait }
    shattering: 0,             // 剩餘碎裂時間
    hudAt: -99,
    shakeT: 0,
    lostTotal: 0,
    ended: false,
    dustApplied: -1,
  };
  const shake = new T.Vector3();
  let shakeApplied = false;

  const counts = ALL_TURNS.map((t) => (cars.length ? cars.filter(t.cond).length : 0));

  function renderLog() {
    log.innerHTML = `<h3>九個轉折 · 台數由 cars.json 即時算出</h3>` +
      ALL_TURNS.map((t, i) => {
        const hit = car ? t.cond(car) : false;
        const on = st.month >= t.m;
        return `<div class="li${on ? ' on' : ''}${hit ? ' hit' : ''}"><u>第${t.m}月</u>` +
               `<em>${t.title}</em><s>${counts[i]} 台</s></div>`;
      }).join('') +
      `<div class="r4-note">條件取自文案原文，台數為 filter 實算值（MODULE_API §10：以資料為準）。
       ${car ? `你這台 ${car.brand} ${car.model} ${car.trim} 命中 <b>${impactCount(car)}</b> / 9 個轉折。` : ''}</div>`;
  }

  function renderHud() {
    const y = Math.floor(st.month / 12), m = Math.floor(st.month % 12);
    const pct = Math.min(100, st.month / MONTHS * 100);
    hud.innerHTML = `<div class="big">第 ${Math.floor(st.month)} 個月</div>
<div class="sub">第 ${y} 年 ${m} 個月　·　已走 ${st.travel.toFixed(1)} m / ${TUNNEL_LEN} m</div>
<div class="r4-bar"><i style="width:${pct}%"></i></div>
<div class="sub" style="margin-top:9px">積灰 ${(st.month / MONTHS * 100).toFixed(0)}%　·
輪胎下沉 ${(st.month / MONTHS * TIRE_SINK * 100).toFixed(1)} cm</div>
${car ? `<div class="sub">${car.brand} ${car.model} ${car.trim}</div>` : ''}
${st.lostTotal > 0 ? `<div class="sub" style="color:#A8442E">已損失 ${wan(st.lostTotal).toFixed(1)} 萬</div>` : ''}
<div class="r4-note">${ESTIMATE_NOTE}：2 公尺 = 1 個月；停下時以 1.0 m/s 自動前進。</div>`;
  }

  /* ───────────────── 轉折卡 ───────────────── */

  function cardHTML(turn, i) {
    const n = counts[i];
    const hit = car ? turn.cond(car) : false;
    const isM14 = turn.m === 14;
    const cargoTxt = car ? (car.cargo === null ? NO_DATA : `${car.cargo} 公升`) : '—';
    let body = '';
    if (isM14) {
      body = `<p class="quote">${LINE_M14}</p>
<p>39 台裡有 <b>${n}</b> 台從未公布行李廂容積。${car
        ? `你這台 ${car.brand} ${car.model} ${car.trim}：行李廂 <b>${cargoTxt}</b>。`
        : ''}</p>
<div class="r4-note">這是<b>資料缺口</b>，不是規格缺點——原廠沒公布，不代表它小。
台數為 cargo === null 的 filter 實算值。</div>`;
    } else {
      body = `<p>條件：${turn.label}　→　39 台裡 <b>${n}</b> 台會被這件事打到。</p>
<p>${hit ? '<b>你這台在其中。</b>' : '你這台這次沒被打到。'}</p>
<div class="r4-note">台數為 cars.json 即時 filter 實算值，未硬編。</div>`;
    }
    return `<div class="when">第 ${turn.m} 個月　·　第 ${Math.floor(turn.m / 12)} 年 ${turn.m % 12} 個月</div>
<h2>${turn.title}</h2>${body}
<div class="r4-ask"><span class="q">你的決定還成立嗎？</span>
<button class="r4-btn" data-act="keep">還成立</button>
<button class="r4-btn warn" data-act="swap">我想換</button></div>`;
  }

  function costHTML(turn) {
    if (!car) return '';
    const c = switchCost(car, turn.m);
    return `<div class="r4-cost">
<div class="row"><span>折舊（推估）　車價 ${nf(car.price)} × (1 − 殘值率 ${(residualAt(turn.m) * 100).toFixed(1)}%)</span><s>${nf(c.dep)}</s></div>
<div class="row"><span>剩餘貸款（推估）　貸 8 成 / 年利率 3.5% / 60 期，第 ${turn.m} 期</span><s>${nf(c.loan)}</s></div>
<div class="row"><span>新車規費（推估）　領牌 + 登記 + 強制險 + 代辦</span><s>${nf(c.fee)}</s></div>
<div class="row tot"><span>現在換掉，代價</span><s>${nf(c.total)} 元</s></div>
<div class="r4-note">${ESTIMATE_NOTE}。殘值曲線：1年78% / 2年67% / 3年57% / 4年47% / 5年38.4%，月內線性內插。</div>
<div class="r4-ask">
<button class="r4-btn" data-act="back">再想想</button>
<button class="r4-btn warn" data-act="confirm">確認換車</button></div></div>`;
  }

  function openCard(turn, i) {
    card.innerHTML = cardHTML(turn, i);
    card.classList.add('on');
    card.onclick = (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'keep') { closeCard(); resume(); }
      else if (act === 'swap') {
        card.insertAdjacentHTML('beforeend', costHTML(turn));
      } else if (act === 'back') {
        const c = card.querySelector('.r4-cost'); if (c) c.remove();
      } else if (act === 'confirm') {
        const c = car ? switchCost(car, turn.m) : { total: 0 };
        st.lostTotal += c.total;
        closeCard();
        startShatter(c.total);
      }
    };
  }
  function closeCard() { card.classList.remove('on'); card.onclick = null; }
  function resume() { st.frozen = false; }

  /* ───────────────── 地面碎裂 ───────────────── */

  function startShatter(lost) {
    const z = -st.travel - 6;
    shatterRoot.position.set(0, 0, z);
    shatterRoot.visible = true;
    for (const s of slabs) {
      s.mesh.position.set(s.x, 0.055, s.z);
      s.mesh.rotation.set(0, 0, 0);
      s.vy = 0;
      s.t = 0;
    }
    st.shattering = 1.9;
    st.shakeT = 1.5;
    // 立碑
    const mesh = new T.Mesh(steleGeo, steleMat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.position.set(3.1, 0.78, z + 1.4);
    mesh.rotation.y = -0.22;
    group.add(mesh);
    const node = el('div', 'r4-stele');
    node.innerHTML = `已損失<b>${wan(st.lostTotal).toFixed(1)} 萬</b>`;
    dom.appendChild(node);
    steles.push({ mesh, node });
    window.setTimeout(() => node.classList.add('on'), 60);
    renderHud();
  }

  function updateShatter(d) {
    if (st.shattering <= 0) return;
    st.shattering -= d;
    const el0 = 1.9 - st.shattering;
    for (const s of slabs) {
      const t = el0 - s.delay;
      if (t <= 0) continue;
      if (s.mesh.position.y > s.rest) {
        s.vy -= 9.8 * d;
        s.mesh.position.y += s.vy * d;
        s.mesh.rotation.x += s.spin[0] * d;
        s.mesh.rotation.y += s.spin[1] * d;
        s.mesh.rotation.z += s.spin[2] * d;
        if (s.mesh.position.y < s.rest) { s.mesh.position.y = s.rest; s.vy = 0; }
      }
    }
    if (st.shattering <= 0) { st.shattering = 0; resume(); }
  }

  /* ───────────────── 結尾總帳 ───────────────── */

  function ledgerHTML() {
    if (!car) return '<h2>五年的總帳</h2><p>沒有選定車輛。</p>';
    const days5 = A.USE_DAYS_PER_YEAR * A.YEARS;
    const fuel = fuelCostMonths(car, 60);
    const tax = car.tax * A.YEARS;
    const park = A.PARK_PER_MONTH * 12 * A.YEARS;
    const maint = A.MAINT_PER_YEAR * A.YEARS;
    const ins = A.INSURE_PER_YEAR * A.YEARS;
    const res = car.price * A.RESIDUAL_CURVE[5];
    const net = car.price + fuel + tax + park + maint + ins - res;
    const perDay = net / days5;

    // ★ 實算：受衝擊次數
    const cx = cars.filter((c) => /CX-30/.test(c.model));
    const cxHits = cx.length ? impactCount(cx[0]) : 0;
    const cxAll = cx.map((c) => impactCount(c));
    const sameCx = cxAll.every((v) => v === cxAll[0]);
    const ranked = cars.map((c) => ({ c, n: impactCount(c) })).sort((a, b) => b.n - a.n);
    const minN = ranked.length ? ranked[ranked.length - 1].n : 0;
    const minCars = ranked.filter((r) => r.n === minN);
    const ccHy = cars.filter((c) => c.series === 'corolla-cross' && /Hybrid/i.test(c.trim))
                     .map((c) => `${c.trim} ${impactCount(c)} 次`);
    const hrvP = cars.filter((c) => /HR-V/.test(c.model) && /Prestige/i.test(c.trim))
                     .map((c) => `${c.trim} ${impactCount(c)} 次`);

    return `<h2>五年的總帳</h2>
<div class="r4-note" style="margin-top:2px">${car.brand} ${car.model} ${car.trim}　·
每一個數字都是推估：${ESTIMATE_NOTE}</div>
<h4>持有成本（五年）</h4>
<div class="row"><span>車價（原廠公布）</span><s>${nf(car.price)}</s></div>
<div class="row"><span>油錢（推估：${days5} 個用車日 × 181 km ÷ ${car.kml} km/L × 30.0 元）</span><s>${nf(fuel)}</s></div>
<div class="row"><span>稅金（牌照+燃料，未計調漲）</span><s>${nf(tax)}</s></div>
<div class="row"><span>停車費（推估：3,000 元／月 × 60）</span><s>${nf(park)}</s></div>
<div class="row"><span>保養（推估：9,000 元／年）</span><s>${nf(maint)}</s></div>
<div class="row"><span>保險（推估：18,000 元／年）</span><s>${nf(ins)}</s></div>
<div class="row"><span>五年後殘值（推估：殘值率 38.4%）</span><s>− ${nf(res)}</s></div>
<div class="row tot"><span>五年淨持有成本</span><s>${nf(net)} 元</s></div>
<div class="row"><span>每一個出遊日的成本</span><s>${nf(perDay)} 元</s></div>
${st.lostTotal > 0 ? `<div class="row"><span>途中換車的代價合計（推估）</span><s>${nf(st.lostTotal)} 元</s></div>` : ''}
<h4>九個轉折 · 逐條實算</h4>
${TURNS.map((t, i) => `<div class="row"><span>第 ${t.m} 月　${t.title}　（${t.label}）</span><s>${counts[i]} 台</s></div>`).join('')}
<div class="row"><span>第 58 月　${SELL_TURN.title}　（${SELL_TURN.label}）</span><s>${counts[9]} 台</s></div>
<div class="r4-disc">${DISCLOSURE.map((s) => `<p>${s}</p>`).join('')}</div>
<div class="r4-note">★ 程式驗算（對 data/cars.json 即時計算，九個轉折不含第 58 月「全部都要賣」）：
Mazda CX-30 受衝擊 <b>${cxHits}</b> 次${sameCx ? '（四個車型皆同）' : '（各車型不同：' + cxAll.join(' / ') + '）'}，
${ranked.length && ranked[0].n === cxHits ? '確為全場最高' : '並非全場最高（最高為 ' + (ranked[0] ? ranked[0].n : 0) + ' 次）'}。
最低為 <b>${minN}</b> 次，共 ${minCars.length} 個車型並列。
Corolla Cross Hybrid：${ccHy.join('、') || '—'}。HR-V Prestige：${hrvP.join('、') || '—'}。
⚠ 因此「Corolla Cross Hybrid 系列只受衝擊 2 次」對 <b>Hybrid豪華</b> 並不成立（它是 3 次）；
文案照原文顯示，實算差異在此揭露，不假裝。</div>
<div class="r4-note">未計入：輪胎、罰單、貸款利息、通膨、油價變動、事故自負額。</div>`;
  }

  function showFinal() {
    if (st.ended) return;
    st.ended = true;
    st.frozen = true;
    final.innerHTML = ledgerHTML();
    window.setTimeout(() => final.classList.add('on'), 700);   // 關鍵時刻前 0.7 s 靜止
    emit(EV.STATE_CHANGED, { keys: ['visited'], room: ROOM_KEY });
  }

  /* ───────────────── 投影 ───────────────── */

  const _v = new T.Vector3();
  function projectNode(node, world, camera) {
    const cv = ctx.renderer && ctx.renderer.domElement;
    const w = cv ? cv.clientWidth : window.innerWidth;
    const h = cv ? cv.clientHeight : window.innerHeight;
    _v.copy(world).project(camera);
    node.style.left = `${(_v.x * 0.5 + 0.5) * w}px`;
    node.style.top = `${(-_v.y * 0.5 + 0.5) * h}px`;
    node.style.visibility = (_v.z > 1) ? 'hidden' : 'visible';
  }

  /* ───────────────── RoomHandle ───────────────── */

  let mounted = false;

  const handle = {
    key: ROOM_KEY,
    group,
    // ★ 第 3 階段整合修正：B1 的隧道自 z≈0 往 -Z 延伸 240 m，z=+4 其實在洞口外，
    //   相機正對洞口端面的磁磚，畫面是一片貼圖。移到 z=-8（洞內）。
    spawn: { pos: [0, 1.6, -8], yaw: 0 },

    enter() {
      if (!mounted) { uiRoot.appendChild(dom); mounted = true; }
      car = pickCar();
      mountCar();
      st.travel = 0; st.month = 0; st.idx = 0; st.pending = null;
      st.frozen = false; st.running = true; st.lastCamZ = null;
      st.shattering = 0; st.shakeT = 0; st.lostTotal = 0; st.ended = false;
      st.dustApplied = -1;
      shatterRoot.visible = false;
      for (const s of steles) { group.remove(s.mesh); if (s.node.parentNode) s.node.remove(); }
      steles.length = 0;
      closeCard();
      final.classList.remove('on');
      if (ctx.materials && typeof ctx.materials.setDust === 'function') ctx.materials.setDust(0);
      renderHud(); renderLog();
      emit(EV.ROOM_ENTER, { room: ROOM_KEY });
    },

    exit() {
      st.running = false;
      if (mounted && dom.parentNode) { dom.parentNode.removeChild(dom); mounted = false; }
      emit(EV.ROOM_EXIT, { room: ROOM_KEY });
    },

    update(dt, elapsed, camera) {
      const d = Math.min(dt || 0, 0.05);

      // 還原上一幀的鏡頭震動，避免累積
      if (camera && shakeApplied) { camera.position.sub(shake); shakeApplied = false; }

      if (rig && typeof rig.update === 'function') rig.update(d, elapsed);

      if (st.running && !st.frozen && !st.ended) {
        let adv = AUTO_SPEED * d;
        if (camera) {
          if (st.lastCamZ == null) st.lastCamZ = camera.position.z;
          const camAdv = st.lastCamZ - camera.position.z;      // 前進方向 = −Z
          st.lastCamZ = camera.position.z;
          if (camAdv > adv) adv = Math.min(camAdv, 3.0);
        }
        st.travel = Math.min(TUNNEL_LEN, st.travel + adv);
        st.month = Math.min(MONTHS, st.travel / M_PER_MONTH);
      } else if (camera) {
        st.lastCamZ = camera.position.z;
      }

      // 積灰 / 輪胎下沉 / 車位置
      const t01 = Math.max(0, Math.min(1, st.month / MONTHS));
      if (Math.abs(t01 - st.dustApplied) > 0.004) {
        st.dustApplied = t01;
        if (ctx.materials && typeof ctx.materials.setDust === 'function') ctx.materials.setDust(t01);
      }
      carHolder.position.set(0, -TIRE_SINK * t01, -st.travel - 9);
      if (rig && typeof rig.setTravel === 'function') rig.setTravel(st.travel);
      if (ctx.carModels && typeof ctx.carModels.update === 'function') ctx.carModels.update(d, elapsed, camera);

      // 轉折觸發
      if (!st.frozen && !st.pending && st.idx < ALL_TURNS.length && st.month >= ALL_TURNS[st.idx].m) {
        const turn = ALL_TURNS[st.idx];
        st.frozen = true;                      // ★ 關鍵時刻前的靜止
        st.pending = { turn, i: st.idx, wait: (turn.m === 14 ? 0.8 : 0.6) };
        st.idx++;
        renderLog();
      }
      if (st.pending) {
        st.pending.wait -= d;
        if (st.pending.wait <= 0) { openCard(st.pending.turn, st.pending.i); st.pending = null; }
      }

      updateShatter(d);

      // 鏡頭震動
      if (st.shakeT > 0 && camera) {
        st.shakeT -= d;
        const k = Math.max(0, st.shakeT / 1.5);
        const amp = 0.055 * k * k;
        const tt = (elapsed || 0) * 41;
        shake.set(Math.sin(tt) * amp, Math.sin(tt * 1.7 + 1.2) * amp, Math.sin(tt * 0.9 + 2.4) * amp * 0.4);
        camera.position.add(shake);
        shakeApplied = true;
      }

      // 走出隧道
      if (!st.ended && st.travel >= TUNNEL_LEN - 0.01 && st.idx >= ALL_TURNS.length && !st.pending
          && !card.classList.contains('on') && st.shattering <= 0) showFinal();

      // 碑文投影
      if (camera) {
        for (const s of steles) {
          _v.set(s.mesh.position.x, s.mesh.position.y + 0.92, s.mesh.position.z);
          projectNode(s.node, _v, camera);
        }
      }

      if (Math.abs(st.month - st.hudAt) > 0.05) { st.hudAt = st.month; renderHud(); }
    },

    dispose() {
      handle.exit();
      slabGeo.dispose(); subGeo.dispose(); steleGeo.dispose();
      for (const s of steles) group.remove(s.mesh);
      steles.length = 0;
      if (ctx.materials && typeof ctx.materials.setDust === 'function') ctx.materials.setDust(0);
      if (rig && typeof rig.dispose === 'function') rig.dispose();
      group.clear();
    },
  };

  return handle;
}

/** node 端自我驗算（瀏覽器不會走到；供 CI / 主代理對帳用） */
export function __selfCheck(cars) {
  const counts = {};
  for (const t of TURNS) counts['m' + t.m] = cars.filter(t.cond).length;
  counts.m58 = cars.length;
  const ranked = cars.map((c) => ({ id: c.id, n: TURNS.reduce((k, t) => k + (t.cond(c) ? 1 : 0), 0) }))
                     .sort((a, b) => b.n - a.n);
  return { counts, top: ranked.slice(0, 5), bottom: ranked.slice(-5), max: ranked[0].n, min: ranked[ranked.length - 1].n };
}
