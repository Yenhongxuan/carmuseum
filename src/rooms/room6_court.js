/**
 * room6_court.js — B8 廳六 法庭（第 2 階段子代理產出）
 *
 * 一句話：你選的那台車站在被告席上，被天光照亮；其餘 38 台在兩側的亮灰藍陰影裡看得見、
 * 看不清。檢方逐條指控，每一條都引用 cars.json 的真實數字。你不能打字辯護，
 * 只能從三個「有代價的立場」裡挑一個，或者認輸。
 *
 * ── 假設（全部列出）──────────────────────────────────────────────
 *  A1 ctx 依 MODULE_API.md §4 提供：THREE / scene / camera / cars / carsById / materials /
 *     lighting / arch / carModels / ui / STATE / EVENTS / EV / ROOMS / scoring。
 *  A2 ctx.cars 的每台已由 scoring.computeScores() 掛上 .s（本檔仍會在缺 .s 時自行補算）。
 *  A3 ctx.arch.buildCourt(ctx) 回傳含地板、被告席平台與兩側陰影區的 Group。
 *     平台高度未知 → 先讀 ctx.arch.DIMENSIONS.court.platformHeight / platform.height，
 *     讀不到時採預設 0.45 m（PLATFORM_Y）。法庭尺寸同理，預設 26 m × 34 m。
 *  A4 ctx.carModels.createFleet(ids) 的 setTransform 只吃 (pos, quat)，沒有 scale，
 *     所以「熄滅沉下」只用「下沉 + setHighlight(false) + 最後 setVisible(false)」表現。
 *  A5 「油電」在 cars.json 沒有欄位 → 以 trim 字串含 Hybrid 或 e:HEV 判定（7 台）。
 *  A6 「品牌可靠度」在 cars.json 沒有欄位 → 只能用原廠自己承諾得起的兩件事當代理指標：
 *     保固分（scoring.WARRANTY_SCORE）與據點分（scoring.DEALER_SCORE）的平均。
 *     這是代理指標不是可靠度統計，畫面小字有寫明。
 *  A7 「保養那天多開 25 分鐘」與油耗指控裡的年行駛里程，是推估值，
 *     一律加註 contract.js 的 ESTIMATE_NOTE。
 *  A8 被告若在陣亡（認輸）後重選，被定罪的那台不再回到候選名單（它沉到平台底下了）。
 *
 * ── 八個立場的 predicate 與「實算」淘汰台數（★ 一律由 cars.json 即時算出，程式內無硬編台數）──
 *   1 我要油電          predicate: !/Hybrid|e:HEV/.test(trim)                    實算 32 台（表格寫 30）
 *   2 保固比配備重要    predicate: warranty === 全場最短保固字串（'3年10萬公里'）  實算 26 台（表格 26 ✓，含 Toyota / Honda / Nissan 全系）
 *   3 價格是唯一底線    predicate: price >= 全場第 ceil(39/3)=13 貴的價格（915,000）實算 13 台（表格 13 ✓）
 *   4 品牌可靠度 > 配備 predicate: (保固分+據點分)/2 < 全場中位數 0.70            實算 14 台（表格寫 7）
 *   5 服務據點對我很重要 predicate: dealer === '少'                              實算 7 台（表格 7 ✓）
 *   6 我一年只開八千公里 predicate: 恆 false（不淘汰任何車）                      實算 0 台（表格 0 ✓）只解除油耗指控
 *   7 我幾乎不倒車進窄位 predicate: 恆 false                                     實算 0 台（表格 0 ✓）只解除停車／倒車類安全指控
 *   8 後座很少載人      predicate: 恆 false                                     實算 0 台（表格 0 ✓）只解除行李廂指控
 *   ★ 1 與 4 與表格不同，依任務指示「以實算值為準、誠實優先於湊數字」，
 *     按鈕上顯示實算值，畫面「立場定義」小字面板列出每一條 predicate 原文。
 *
 * ── 互斥（衝突偵測）──────────────────────────────────────────────
 *   宣告式：價格是唯一底線 ↔ 品牌可靠度 > 配備（任務指定，必須包含）
 *   計算式：任兩個立場若同時成立會讓「存活車數歸零」即判為互斥 → 實算得到
 *           我要油電 ↔ 保固比配備重要（油電全是 3年10萬公里 的 Toyota / Honda）
 *
 * ── 依賴（依賴注入，不 import）──────────────────────────────────
 *   ctx.arch.buildCourt / ctx.arch.DIMENSIONS
 *   ctx.lighting.makeRig(ROOM_KEY)
 *   ctx.carModels.getCarMesh / createFleet / getFootprint
 *   ctx.materials（本檔不自己 new 任何 Material；只有下沉動畫用到既有物件）
 *   本檔只 import ../contract.js 與 ../scoring.js。THREE 一律由 ctx.THREE 取得。
 *
 * ── 未達成的規格（誠實列出）──────────────────────────────────────
 *   U1 「我要油電 30 台 / 品牌可靠度 7 台」未達成：實算為 32 / 14，見上。
 *   U2 檢方模板 8 條全部照抄不動，但另外新增了一條「油耗」指控（型別 fuel），
 *      否則「我一年只開八千公里（只解除油耗指控）」這個立場沒有任何指控可解除。
 *      新增的那條不是任務給的模板，措辭由本檔自撰，並標了推估註記。
 *   U3 被告的重選是 DOM 清單點選，不是 3D 拾取（沒有 raycast 選車）。
 *   U4 沉下動畫用位移表現，沒有逐台的材質淡出（InstancedMesh 無法逐實例改透明度，
 *      且 setTransform 不吃 scale）。
 */

import {
  ROOMS, STATE, EV, emit, EASE, EASE_FN, NO_DATA, ESTIMATE_NOTE,
} from '../contract.js';
import {
  DIMS, WARRANTY_SCORE, DEALER_SCORE, dominates, computeScores,
} from '../scoring.js';

export const ROOM_KEY = ROOMS.COURT;

/* ══════════════════════════════════════════════════════════════════
   一、純邏輯（無 DOM、無 three.js）—— 可在 node 裡單獨驗算
   ══════════════════════════════════════════════════════════════════ */

export const HYBRID_RE = /Hybrid|e:HEV/i;
export const isHybrid = (c) => HYBRID_RE.test(c.trim || '');

/** 停車／倒車類的安全項目（「我幾乎不倒車進窄位」能解除的範圍） */
export const REVERSE_ITEMS = [
  '倒車主動煞停', '後方橫向車流警示', '後停車雷達', '前停車雷達', '360度環景',
];

/** 宣告式互斥對（任務指定至少要有這一對） */
export const DECLARED_CONFLICTS = [['price', 'brand']];

const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const wan = (n) => {
  const v = n / 10000;
  return (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));
};
const carName = (c) => `${c.brand} ${c.model} ${c.trim}`.trim();
const warrantyText = (w) => w
  .replace('5年不限里程', '5 年不限里程')
  .replace('3年不限里程', '3 年不限里程')
  .replace('5年15萬公里', '5 年 15 萬公里')
  .replace('3年10萬公里', '3 年 10 萬公里');

/**
 * 由 cars.json 即時建出八個立場。所有門檻值（最短保固字串、價格前三分之一的切點、
 * 承諾分中位數）都是算出來的，沒有一個硬編。
 */
export function buildStanceDefs(cars) {
  const N = cars.length;
  const commit = (c) => (WARRANTY_SCORE[c.warranty] + DEALER_SCORE[c.dealer]) / 2;
  const commitSorted = cars.map(commit).sort((a, b) => a - b);
  const commitMedian = commitSorted[Math.floor(N / 2)];
  const shortestWarranty = Object.entries(WARRANTY_SCORE)
    .sort((a, b) => a[1] - b[1])[0][0];
  const priceDesc = [...cars].sort((a, b) => b.price - a.price);
  const priceCut = priceDesc[Math.ceil(N / 3) - 1].price;

  const defs = [
    {
      id: 'hybrid', label: '我要油電',
      predicate: (c) => !isHybrid(c),
      predicateText: `淘汰所有非油電車（trim 不含 ${'Hybrid'} 或 e:HEV 者）`,
      immunes: ['fuel'],
      aspect: '油電',
    },
    {
      id: 'warranty', label: '保固比配備重要',
      predicate: (c) => c.warranty === shortestWarranty,
      predicateText: `淘汰保固為全場最短的「${shortestWarranty}」者`,
      immunes: ['equip'],
      aspect: '保固',
    },
    {
      id: 'price', label: '價格是唯一底線',
      predicate: (c) => c.price >= priceCut,
      predicateText: `淘汰價格最貴的三分之一（售價 ≥ ${fmtInt(priceCut)} 元）`,
      immunes: ['warranty'],
      aspect: '價格',
    },
    {
      id: 'brand', label: '品牌可靠度 > 配備',
      predicate: (c) => commit(c) < commitMedian,
      predicateText:
        `cars.json 沒有可靠度欄位。以「原廠承諾＝(保固分＋據點分)/2」為代理指標，`
        + `淘汰低於全場中位數 ${commitMedian.toFixed(2)} 者`,
      immunes: ['equip', 'safety'],
      aspect: '品牌可靠度',
    },
    {
      id: 'dealer', label: '服務據點對我很重要',
      predicate: (c) => c.dealer === '少',
      predicateText: '淘汰服務據點為「少」者',
      immunes: [],
      aspect: '服務據點',
    },
    {
      id: 'lowmile', label: '我一年只開八千公里',
      predicate: () => false,
      predicateText: '不淘汰任何車。只解除「油耗」指控。',
      immunes: ['fuel'],
      aspect: '油耗',
    },
    {
      id: 'noreverse', label: '我幾乎不倒車進窄位',
      predicate: () => false,
      predicateText: `不淘汰任何車。只解除停車／倒車類安全指控（${REVERSE_ITEMS.join('、')}）。`,
      immunes: ['reverse'],
      aspect: '倒車安全',
    },
    {
      id: 'rearseat', label: '後座很少載人',
      predicate: () => false,
      predicateText: '不淘汰任何車。只解除「行李廂容積」指控。',
      immunes: ['cargo'],
      aspect: '行李廂',
    },
  ];

  for (const d of defs) {
    d.eliminated = cars.filter(d.predicate).map((c) => c.id);
    d.count = d.eliminated.length;          // ★ 實算，不硬編
  }
  return defs;
}

/** 互斥對＝宣告式 ∪ 「同時成立會讓存活歸零」的計算式 */
export function buildConflictPairs(cars, defs) {
  const key = (a, b) => [a, b].sort().join('|');
  const pairs = new Map();
  for (const [a, b] of DECLARED_CONFLICTS) pairs.set(key(a, b), '任務指定的互斥立場：兩者不可並存');
  for (let i = 0; i < defs.length; i++) {
    for (let j = i + 1; j < defs.length; j++) {
      const A = defs[i]; const B = defs[j];
      const survivors = cars.filter((c) => !A.predicate(c) && !B.predicate(c));
      if (survivors.length === 0) {
        pairs.set(key(A.id, B.id), '這兩個立場同時成立，39 台會一台都不剩');
      }
    }
  }
  return pairs;
}

/**
 * 檢方指控產生器。
 * @param d          被告
 * @param cars       全部 39 台（「39 台裡有 N 台有」的分母用它）
 * @param aliveIds   目前還活著的車（Set），被告不算在內
 * @param immuneTags 已表態的立場提供的免疫標籤（Set）
 * 回傳 [{ id, type, tags, parts, cite, note }]，parts 是可含 <strong> 的 HTML 片段。
 */
export function buildAccusations(d, cars, aliveIds, immuneTags = new Set()) {
  const rivals = cars.filter((c) => c.id !== d.id && aliveIds.has(c.id));
  const out = [];
  const push = (a) => {
    if (a.tags.some((t) => immuneTags.has(t))) return;   // 已被立場擋掉
    out.push(a);
  };

  // ── ① 被完全支配（優先度最高，沒有任何選項，只能認輸）
  const doms = rivals.filter((x) => dominates(d, x));
  if (doms.length) {
    const x = doms.sort((a, b) => a.price - b.price)[0];
    push({
      id: 'dominated', type: 'dominated', tags: ['dominated'], cite: x.id, noOptions: true,
      metric: doms.length,
      title: '被完全支配',
      text: `${carName(x)} 在 ${DIMS.length} 個面向上都不輸你選的這台。`
          + `<strong>你為什麼要選被完全壓過的那台？</strong>`,
      note: `支配關係由 scoring.dominates() 計算：${DIMS.length} 維全部 ≥ 且至少一維 >。`
          + `目前還有 ${doms.length} 台完全壓過它。`,
    });
  }

  // ── ② 更便宜且不輸
  const cheaperAll = rivals
    .filter((x) => x.price < d.price && x.safetyCount >= d.safetyCount && x.comfortCount >= d.comfortCount)
    .sort((a, b) => a.price - b.price);
  const cheaper = cheaperAll[0];
  if (cheaper) {
    push({
      id: 'cheaper', type: 'cheaper', tags: ['price', 'equip'], cite: cheaper.id,
      metric: cheaperAll.length,
      title: '更便宜且不輸',
      text: `${carName(cheaper)} 便宜 ${wan(d.price - cheaper.price)} 萬，主動安全與內裝配備都不輸你選的這台。`,
      note: `主動安全 ${cheaper.safetyCount} vs ${d.safetyCount} 項、`
          + `內裝配備 ${cheaper.comfortCount} vs ${d.comfortCount} 項、`
          + `售價 ${fmtInt(cheaper.price)} vs ${fmtInt(d.price)} 元。`,
    });
  }

  // ── ③ 同價位更好（價差 ±3 萬內、配備總數更多）
  const samePriceAll = rivals
    .filter((x) => Math.abs(x.price - d.price) <= 30000
      && (x.safetyCount + x.comfortCount) > (d.safetyCount + d.comfortCount))
    .sort((a, b) => (b.safetyCount + b.comfortCount) - (a.safetyCount + a.comfortCount));
  const samePrice = samePriceAll[0];
  if (samePrice) {
    const gap = (samePrice.safetyCount + samePrice.comfortCount) - (d.safetyCount + d.comfortCount);
    push({
      id: 'samePrice', type: 'samePrice', tags: ['equip'], cite: samePrice.id,
      metric: samePriceAll.length,
      title: '同價位更好',
      text: `同樣的價錢，${carName(samePrice)} 多給你 ${gap} 項配備。`,
      note: `價差只有 ${fmtInt(Math.abs(samePrice.price - d.price))} 元（門檻 ±30,000）；`
          + `配備總數 ${samePrice.safetyCount + samePrice.comfortCount} vs ${d.safetyCount + d.comfortCount} 項。`,
    });
  }

  // ── ④ 缺關鍵安全（被告缺的每一項，各算全場有幾台有；取「有的人最多」的前三項）
  const missingAll = Object.keys(d.safety || {}).filter((k) => !d.safety[k]).length;
  const missing = Object.keys(d.safety || {})
    .filter((k) => !d.safety[k])
    .map((k) => ({
      item: k,
      all: cars.filter((c) => c.safety && c.safety[k]).length,
      aliveN: rivals.filter((c) => c.safety && c.safety[k]).length,
    }))
    .filter((m) => m.aliveN > 0)
    .sort((a, b) => b.all - a.all)
    .slice(0, 3);
  for (const m of missing) {
    const tags = ['safety'];
    if (REVERSE_ITEMS.includes(m.item)) tags.push('reverse');
    push({
      id: `safety:${m.item}`, type: 'missingSafety', tags, cite: null, item: m.item,
      metric: m.aliveN,
      title: '缺關鍵安全',
      text: `它沒有『${m.item}』。${cars.length} 台裡有 ${m.all} 台有。`
          + `你為什麼不選那 ${m.all} 台之一？`,
      note: `目前還活著的車裡，仍有 ${m.aliveN} 台配了這一項。`
          + (missingAll > 3
            ? `（它一共缺 ${missingAll} 項，檢方只逐條起訴「最多車有」的前三項。）`
            : `（它一共缺 ${missingAll} 項，全部在這裡起訴。）`),
    });
  }

  // ── ⑤ 行李廂無資料（被告自身的資料缺口，與別台無關）
  if (d.cargo == null) {
    push({
      id: 'cargo', type: 'cargo', tags: ['cargo'], cite: null, metric: 1,
      title: '行李廂無資料',
      text: `它的行李廂容積<strong>${NO_DATA}</strong>。`
          + `你連放不放得下嬰兒推車都不知道，就要買了？`,
      note: `cars.json 的 cargo 欄位為 null，代表原廠自始未曾揭露。`
          + `全場 ${cars.length} 台裡有 ${cars.filter((c) => c.cargo == null).length} 台是這樣。`
          + `這個欄位不可以寫 0、不可以估算。`,
    });
  }

  // ── ⑥ 保固短（引用全場保固最好的那台，一樣是算出來的）
  const betterWarranty = rivals
    .filter((x) => WARRANTY_SCORE[x.warranty] > WARRANTY_SCORE[d.warranty])
    .sort((a, b) => WARRANTY_SCORE[b.warranty] - WARRANTY_SCORE[a.warranty]
      || a.price - b.price);
  const best = betterWarranty[0];
  if (best) {
    push({
      id: 'warranty', type: 'warranty', tags: ['warranty'], cite: best.id,
      metric: betterWarranty.length,
      title: '保固短',
      text: `保固只有 ${warrantyText(d.warranty)}。${best.brand} ${best.model} 是 ${warrantyText(best.warranty)}。`
          + `第 37 個月出問題，你自己付。`,
      note: `保固分 ${WARRANTY_SCORE[d.warranty].toFixed(2)} vs ${WARRANTY_SCORE[best.warranty].toFixed(2)}`
          + `（scoring.WARRANTY_SCORE）。`,
    });
  }

  // ── ⑦ 稅金高（只在 tax === 17440 時出現）
  const cheaperTaxAll = rivals.filter((x) => x.tax < d.tax)
    .sort((a, b) => a.tax - b.tax
      || WARRANTY_SCORE[b.warranty] - WARRANTY_SCORE[a.warranty]);
  const cheapTax = cheaperTaxAll[0];
  if (d.tax === 17440 && cheapTax) {
    push({
      id: 'tax', type: 'tax', tags: ['tax'], cite: cheapTax.id,
      metric: cheaperTaxAll.length,
      title: '稅金高',
      text: `年稅 ${fmtInt(d.tax)}，五年 ${wan(d.tax * 5)} 萬。`
          + `${cheapTax.model} 只要 ${fmtInt(cheapTax.tax)}，五年差 ${wan((d.tax - cheapTax.tax) * 5)} 萬。`,
      note: `五年＝年稅 × 5，未計燃料費調整與稅制變動。全場最低年稅 ${fmtInt(cheapTax.tax)} 元。`,
    });
  }

  // ── ⑧ 據點少（只在 dealer === '少' 時出現）
  const betterDealer = rivals.filter((x) => DEALER_SCORE[x.dealer] > DEALER_SCORE[d.dealer]);
  if (d.dealer === '少' && betterDealer.length) {
    push({
      id: 'dealer', type: 'dealer', tags: ['dealer'], cite: null,
      metric: betterDealer.length,
      title: '據點少',
      text: `${d.brand} 的據點是全場最少的一群。保養那天你要多開 25 分鐘。`,
      note: `全場 ${cars.filter((c) => c.dealer === '少').length} 台是「少」；`
          + `目前還有 ${betterDealer.length} 台的據點比它多。`
          + `「25 分鐘」為 ${ESTIMATE_NOTE}。`,
    });
  }

  // ── ⑨ 油耗（★ 這一條不是任務給的八個模板之一，是本檔新增，見檔頭 U2）
  const thirstyAll = rivals.filter((x) => x.kml - d.kml >= 3)
    .sort((a, b) => b.kml - a.kml);
  const thirsty = thirstyAll[0];
  if (thirsty) {
    const KM_PER_YEAR = 12000;
    const litreGap = Math.round((KM_PER_YEAR / d.kml - KM_PER_YEAR / thirsty.kml) * 5);
    push({
      id: 'fuel', type: 'fuel', tags: ['fuel'], cite: thirsty.id,
      metric: thirstyAll.length,
      title: '油耗差',
      text: `${carName(thirsty)} 每公升多跑 ${(thirsty.kml - d.kml).toFixed(1)} 公里`
          + `（${thirsty.kml} vs ${d.kml} km/L）。年跑 ${fmtInt(KM_PER_YEAR)} 公里的話，`
          + `五年你多燒 ${fmtInt(litreGap)} 公升汽油。`,
      note: `年行駛 ${fmtInt(KM_PER_YEAR)} 公里為 ${ESTIMATE_NOTE}；`
          + `油耗數字取自 cars.json 的 kml 欄位（原廠平均值）。`,
    });
  }

  return out;
}

/** 由已表態的立場清單，算出免疫標籤與被淘汰的車 id 集合 */
export function stanceEffects(stanceIds, defs) {
  const immune = new Set();
  const dead = new Set();
  for (const id of stanceIds) {
    const d = defs.find((x) => x.id === id);
    if (!d) continue;
    d.immunes.forEach((t) => immune.add(t));
    d.eliminated.forEach((c) => dead.add(c));
  }
  return { immune, dead };
}

/**
 * 這一組立場能不能擋掉被告的所有指控（ending.js 也用同一套判準，
 * 但因為展廳模組不可互相 import，那邊是各自實作的同名函式）。
 */
export function survivesAllAttacks(defendant, stanceIds, cars, defs) {
  const { immune, dead } = stanceEffects(stanceIds, defs);
  const alive = new Set(cars.filter((c) => !dead.has(c.id)).map((c) => c.id));
  return buildAccusations(defendant, cars, alive, immune).length === 0;
}

/* ══════════════════════════════════════════════════════════════════
   二、展廳
   ══════════════════════════════════════════════════════════════════ */

const PLATFORM_Y_FALLBACK = 0.45;
const COURT_W_FALLBACK = 26;
const COURT_D_FALLBACK = 34;
const SINK_STAGGER = 0.040;      // ★ 每台間隔 40ms
const SINK_DUR = 0.9;
const STILL_BEFORE_VERDICT = 700; // ★ 判決前 0.7 秒靜止

const CSS = `
.b8c{position:absolute;inset:0;font:400 15px/1.65 "Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;color:#1B1E23;pointer-events:none}
.b8c *{box-sizing:border-box}
.b8c strong{font-weight:700}
.b8c-panel{position:absolute;right:28px;top:28px;bottom:28px;width:min(460px,42vw);
  background:rgba(247,248,250,.94);border:1px solid #D5DAE1;border-radius:2px;
  display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;
  box-shadow:0 18px 44px rgba(27,30,35,.10)}
.b8c-head{padding:20px 22px 14px;border-bottom:1px solid #E2E6EB;flex:0 0 auto}
.b8c-kicker{font-size:11px;letter-spacing:.22em;color:#7A8290;text-transform:uppercase}
.b8c-title{font-size:21px;font-weight:700;margin-top:6px;letter-spacing:.01em}
.b8c-sub{font-size:12.5px;color:#5B6472;margin-top:5px}
.b8c-body{flex:1 1 auto;overflow-y:auto;padding:18px 22px 8px}
.b8c-foot{flex:0 0 auto;padding:12px 22px 18px;border-top:1px solid #E2E6EB}
.b8c-count{display:flex;gap:5px;margin:0 0 14px}
.b8c-dot{height:3px;flex:1 1 0;background:#D9DEE5;transition:background 320ms ${EASE.component}}
.b8c-dot.done{background:#5C8C74}
.b8c-dot.now{background:#A63A33}
.b8c-acc{opacity:0;transform:translateY(8px);transition:opacity 360ms ${EASE.component},transform 360ms ${EASE.component}}
.b8c-acc.in{opacity:1;transform:none}
.b8c-acclabel{font-size:11px;letter-spacing:.2em;color:#A63A33}
.b8c-acctext{font-size:17px;line-height:1.75;margin-top:8px}
.b8c-note{font-size:11.5px;line-height:1.6;color:#7A8290;margin-top:10px;padding-left:10px;border-left:2px solid #DDE2E8}
.b8c-opts{margin-top:18px;display:flex;flex-direction:column;gap:8px}
.b8c-btn{width:100%;text-align:left;background:#FFF;border:1px solid #CDD4DD;border-radius:2px;
  padding:11px 13px;font:inherit;color:#1B1E23;cursor:pointer;
  transition:transform 170ms ${EASE.micro},box-shadow 170ms ${EASE.micro},border-color 170ms ${EASE.micro}}
.b8c-btn:hover:not(:disabled){transform:translateY(-1px) scale(1.012);box-shadow:0 8px 18px rgba(27,30,35,.10);border-color:#9AA5B3}
.b8c-btn:disabled{cursor:not-allowed;color:#9BA3AE;background:#F1F3F6;border-color:#E1E5EA}
.b8c-btn b{font-weight:600}
.b8c-cost{display:block;font-size:11.5px;color:#8C5C58;margin-top:3px}
.b8c-btn:disabled .b8c-cost{color:#9BA3AE}
.b8c-give{background:#1B1E23;color:#F7F8FA;border-color:#1B1E23}
.b8c-give:hover:not(:disabled){box-shadow:0 8px 18px rgba(27,30,35,.22);border-color:#1B1E23}
.b8c-give .b8c-cost{color:#C3C9D2}
.b8c-list{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.b8c-row{display:flex;justify-content:space-between;gap:10px;align-items:baseline;
  border:1px solid #DDE2E8;background:#FFF;border-radius:2px;padding:9px 11px;cursor:pointer;font:inherit;color:inherit;text-align:left;
  transition:transform 170ms ${EASE.micro},box-shadow 170ms ${EASE.micro}}
.b8c-row:hover{transform:translateY(-1px) scale(1.008);box-shadow:0 8px 16px rgba(27,30,35,.09)}
.b8c-row small{color:#7A8290;font-size:11.5px;white-space:nowrap}
.b8c-done{font-size:12.5px;color:#5C8C74;margin-top:12px;padding-left:10px;border-left:2px solid #B9D2C4}
.b8c-defs{margin-top:16px;font-size:11.5px;color:#7A8290}
.b8c-defs summary{cursor:pointer;color:#5B6472}
.b8c-defs li{margin:6px 0;list-style:none}
.b8c-defs code{font-size:11px;color:#5B6472}
.b8c-est{font-size:11px;color:#8A92A0;margin-top:8px}
.b8c-verdict{position:absolute;left:0;right:0;top:38%;text-align:center;opacity:0;
  transition:opacity 1400ms ${EASE.region};pointer-events:none}
.b8c-verdict.in{opacity:1}
.b8c-verdict h2{font-size:30px;font-weight:700;letter-spacing:.06em;margin:0}
.b8c-verdict p{font-size:14px;color:#5B6472;margin:10px auto 0;max-width:520px;line-height:1.8}
.b8c-verdict .b8c-btn{display:inline-block;width:auto;margin-top:18px;pointer-events:auto}
.b8c-hint{position:absolute;left:28px;bottom:28px;max-width:340px;font-size:12px;color:#5B6472;
  background:rgba(247,248,250,.86);border-left:2px solid #C8D0DC;padding:10px 12px;pointer-events:auto}
`;

export function createRoom(ctx) {
  const THREE = ctx.THREE;
  const cars = (ctx.cars || []).slice();
  if (cars.length && !cars[0].s) computeScores(cars);
  const byId = ctx.carsById || Object.fromEntries(cars.map((c) => [c.id, c]));

  const defs = buildStanceDefs(cars);
  const conflicts = buildConflictPairs(cars, defs);

  const group = new THREE.Group();
  group.name = 'room6_court';

  /* ── 場景 ───────────────────────────────────────────── */
  let rig = null;
  let courtGroup = null;
  try {
    courtGroup = ctx.arch?.buildCourt ? ctx.arch.buildCourt(ctx) : null;
    if (courtGroup) group.add(courtGroup);
  } catch (e) { console.warn('[room6] buildCourt 失敗：', e.message); }
  try {
    rig = ctx.lighting?.makeRig ? ctx.lighting.makeRig(ROOM_KEY) : null;
    if (rig?.group) group.add(rig.group);
  } catch (e) { console.warn('[room6] makeRig 失敗：', e.message); }

  const dim = ctx.arch?.DIMENSIONS?.court || ctx.arch?.DIMENSIONS?.[ROOM_KEY] || {};
  const platformY = dim.platformHeight ?? dim.platform?.height ?? PLATFORM_Y_FALLBACK;
  const courtW = dim.width ?? dim.w ?? COURT_W_FALLBACK;
  const courtD = dim.depth ?? dim.d ?? COURT_D_FALLBACK;

  const dock = new THREE.Group();      // 被告席上的車掛這裡
  dock.position.set(0, platformY, 0);
  group.add(dock);

  let fleet = null;
  let fleetBase = new Map();           // carId -> THREE.Vector3（陰影中的基準位置）

  /* ── 狀態 ───────────────────────────────────────────── */
  const st = {
    phase: 'select',                   // select | trial | verdict | lost
    defendantId: null,
    accusations: [],
    originalOrder: [],                 // 初始指控順序（用來畫進度點）
    resolved: new Map(),               // accId -> 說明字串
    convicted: [],                     // 已經倒下的被告
    verdictAt: 0,
  };
  const anims = [];
  let now = 0;
  let defendantMesh = null;

  /* ── DOM ────────────────────────────────────────────── */
  const el = document.createElement('div');
  el.className = 'b8c';
  const style = document.createElement('style');
  style.textContent = CSS;
  el.appendChild(style);
  const panel = document.createElement('div');
  panel.className = 'b8c-panel';
  el.appendChild(panel);
  const verdictEl = document.createElement('div');
  verdictEl.className = 'b8c-verdict';
  el.appendChild(verdictEl);
  const hintEl = document.createElement('div');
  hintEl.className = 'b8c-hint';
  hintEl.innerHTML = '被告席在天光下。其餘 <b>'
    + Math.max(cars.length - 1, 0) + '</b> 台在兩側的陰影裡——看得見，看不清。'
    + '<br>一旦表態就不能反悔：被淘汰的車會一台一台沉下去。';
  el.appendChild(hintEl);

  /* ── 立場 / 存活 ─────────────────────────────────────── */
  const takenIds = () => (STATE.stances || []).map((s) => s.id);
  const effects = () => stanceEffects(takenIds(), defs);

  function aliveIdSet() {
    const { dead } = effects();
    const base = (STATE.alive && STATE.alive.length)
      ? STATE.alive.filter((id) => byId[id])
      : cars.map((c) => c.id);
    return new Set(base.filter((id) => !dead.has(id)));
  }

  function conflictReason(id) {
    for (const other of takenIds()) {
      const k = [id, other].sort().join('|');
      if (conflicts.has(k)) {
        const o = defs.find((d) => d.id === other);
        return `與你已經說過的「${o ? o.label : other}」互斥 —— ${conflicts.get(k)}`;
      }
    }
    return null;
  }

  /* ── 指控 ───────────────────────────────────────────── */
  function rebuild() {
    const d = byId[st.defendantId];
    if (!d) { st.accusations = []; return; }
    const { immune } = effects();
    st.accusations = buildAccusations(d, cars, aliveIdSet(), immune);
  }

  /** 模擬：加上這個立場之後，acc 這條指控會不會消失 */
  function wouldClear(acc, stanceId) {
    const d = byId[st.defendantId];
    const ids = [...takenIds(), stanceId];
    const { immune, dead } = stanceEffects(ids, defs);
    if (dead.has(d.id)) return false;
    const base = (STATE.alive && STATE.alive.length) ? STATE.alive : cars.map((c) => c.id);
    const alive = new Set(base.filter((id) => !dead.has(id)));
    return !buildAccusations(d, cars, alive, immune).some((a) => a.id === acc.id);
  }

  function optionsFor(acc) {
    if (acc.noOptions) return [];       // ★ 被完全支配：沒有任何選項
    const d = byId[st.defendantId];
    const used = new Set(takenIds());
    const alive = aliveIdSet();
    const cand = [];
    for (const s of defs) {
      if (used.has(s.id)) continue;                       // ★ 用過的立場不再出現
      if (s.predicate(d)) continue;                       // 會把被告自己淘汰
      if (conflictReason(s.id)) continue;                 // ★ 衝突偵測：互斥的立場不給選
      if (!wouldClear(acc, s.id)) continue;               // 擋不掉這一條就不列出來
      const newDead = s.eliminated.filter((id) => alive.has(id) && id !== d.id).length;
      cand.push({ def: s, newDead });
    }
    cand.sort((a, b) => a.newDead - b.newDead);
    return cand.slice(0, 3);
  }

  /* ── 動畫 ───────────────────────────────────────────── */
  function addAnim(a) { anims.push(a); }

  function sinkCars(ids) {
    if (!fleet) return;
    ids.forEach((id, i) => {
      const idx = fleet.indexOf ? fleet.indexOf(id) : -1;
      if (idx < 0) return;
      const base = fleetBase.get(id);
      if (!base) return;
      try { fleet.setHighlight(idx, false); } catch (e) { /* 可選 API */ }
      addAnim({
        start: now + i * SINK_STAGGER, dur: SINK_DUR,
        tick(k) {
          const e = EASE_FN.inOutCubic(k);
          const p = base.clone(); p.y = base.y - 2.4 * e;
          fleet.setTransform(idx, p, new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0), base.userYaw || 0,
          ));
          fleet.commit();
        },
        done() { try { fleet.setVisible(idx, false); fleet.commit(); } catch (e) { /* noop */ } },
      });
    });
  }

  function dropDefendant(after) {
    const startY = dock.position.y;
    addAnim({
      start: now, dur: 1.5,
      tick(k) { dock.position.y = startY - 3.0 * EASE_FN.inOutQuint(k); },
      done() { dock.position.y = startY; clearDock(); if (after) after(); },
    });
  }

  function clearDock() {
    while (dock.children.length) {
      const c = dock.children[0];
      dock.remove(c);
      c.traverse?.((o) => { if (o.geometry) o.geometry.dispose?.(); });
    }
    defendantMesh = null;
  }

  /* ── 車輛擺位 ────────────────────────────────────────── */
  function layoutFleet(defendantId) {
    const others = cars.map((c) => c.id).filter((id) => id !== defendantId);
    try {
      if (fleet?.group) { group.remove(fleet.group); fleet.dispose?.(); }
      fleet = ctx.carModels?.createFleet ? ctx.carModels.createFleet(others) : null;
    } catch (e) { console.warn('[room6] createFleet 失敗：', e.message); fleet = null; }
    fleetBase = new Map();
    if (!fleet) return;
    group.add(fleet.group);

    const alive = aliveIdSet();
    const xs = [-(courtW / 2 - 3.2), -(courtW / 2 - 6.4), (courtW / 2 - 6.4), (courtW / 2 - 3.2)];
    const perCol = Math.ceil(others.length / xs.length);
    const z0 = -courtD / 2 + 5.5;
    const dz = Math.max(2.6, (courtD - 11) / Math.max(perCol - 1, 1));
    others.forEach((id, n) => {
      const col = Math.floor(n / perCol);
      const row = n % perCol;
      const x = xs[Math.min(col, xs.length - 1)];
      const z = z0 + row * dz;
      const yaw = x < 0 ? -Math.PI / 2 : Math.PI / 2;      // 車頭朝法庭中央
      const pos = new THREE.Vector3(x, 0, z);
      pos.userYaw = yaw;
      fleetBase.set(id, pos);
      const idx = fleet.indexOf(id);
      if (idx < 0) return;
      fleet.setTransform(idx, pos,
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
      fleet.setVisible(idx, alive.has(id));
    });
    fleet.commit();
  }

  function placeDefendant(id) {
    clearDock();
    try {
      defendantMesh = ctx.carModels?.getCarMesh ? ctx.carModels.getCarMesh(id) : null;
      if (defendantMesh) {
        defendantMesh.position.set(0, 0, 0);
        defendantMesh.rotation.y = Math.PI;     // 車頭朝向觀眾（+Z）
        dock.add(defendantMesh);
      }
    } catch (e) { console.warn('[room6] getCarMesh 失敗：', e.message); }
  }

  /* ── 行為 ───────────────────────────────────────────── */
  function chooseDefendant(id) {
    st.defendantId = id;
    STATE.chosenCarId = id;
    emit(EV.CAR_CHOSEN, { carId: id, room: ROOM_KEY });
    emit(EV.STATE_CHANGED, { keys: ['chosenCarId'] });
    layoutFleet(id);
    placeDefendant(id);
    rebuild();
    st.originalOrder = st.accusations.map((a) => a.id);
    st.resolved = new Map();
    st.phase = st.accusations.length ? 'trial' : 'verdict';
    if (st.phase === 'verdict') st.verdictAt = performance.now() + STILL_BEFORE_VERDICT;
    render();
  }

  function takeStance(stanceId) {
    const def = defs.find((d) => d.id === stanceId);
    if (!def) return;
    const aliveBefore = aliveIdSet();
    const killed = def.eliminated.filter((id) => aliveBefore.has(id) && id !== st.defendantId);

    STATE.stances.push({
      id: def.id, label: def.label, aspect: def.aspect,
      eliminated: killed.slice(), usedAt: Date.now(),
    });
    if (Array.isArray(STATE.alive) && STATE.alive.length) {
      STATE.alive = STATE.alive.filter((id) => !killed.includes(id));
    }
    emit(EV.STANCE_TAKEN, {
      room: ROOM_KEY, id: def.id, label: def.label,
      predicate: def.predicateText, eliminated: killed.slice(), count: killed.length,
    });
    for (const id of killed) emit(EV.CAR_ELIMINATED, { carId: id, room: ROOM_KEY, by: def.id });
    emit(EV.STATE_CHANGED, { keys: ['stances', 'alive'] });

    sinkCars(killed);

    const before = st.accusations.map((a) => a.id);
    rebuild();
    const after = new Set(st.accusations.map((a) => a.id));
    for (const id of before) {
      if (!after.has(id) && !st.resolved.has(id)) {
        st.resolved.set(id, killed.length
          ? `「${def.label}」擋下 —— 連帶淘汰 ${killed.length} 台。`
          : `「${def.label}」擋下 —— 沒有淘汰任何車，只是把這個面向排除在你的考量之外。`);
      }
    }
    if (!st.accusations.length) {
      st.phase = 'verdict';
      st.verdictAt = performance.now() + STILL_BEFORE_VERDICT;   // ★ 判決前靜止
    }
    render();
  }

  function giveUp() {
    st.phase = 'lost';
    st.convicted.push(st.defendantId);
    render();
    dropDefendant(() => {
      st.phase = 'select';
      st.defendantId = null;
      STATE.chosenCarId = null;
      emit(EV.STATE_CHANGED, { keys: ['chosenCarId'] });
      render();
    });
  }

  /* ── 畫面 ───────────────────────────────────────────── */
  const esc = (s) => String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));

  function defsPanelHTML() {
    const alive = aliveIdSet();
    return `<details class="b8c-defs"><summary>八個立場的 predicate 與實算淘汰台數（全部由 cars.json 即時算出）</summary><ul>`
      + defs.map((d) => `<li><b>${esc(d.label)}</b>　實算 ${d.count} 台<br>`
        + `<code>${esc(d.predicateText)}</code>　`
        + `<span>目前還活著的車裡會被它掃掉 ${d.eliminated.filter((id) => alive.has(id)).length} 台</span></li>`).join('')
      + `</ul><div>互斥對：`
      + [...conflicts.entries()].map(([k, v]) => {
        const [a, b] = k.split('|');
        const la = defs.find((d) => d.id === a)?.label || a;
        const lb = defs.find((d) => d.id === b)?.label || b;
        return `「${esc(la)}」↔「${esc(lb)}」（${esc(v)}）`;
      }).join('；')
      + `</div></details>`;
  }

  function renderSelect() {
    const alive = [...aliveIdSet()].filter((id) => !st.convicted.includes(id)).map((id) => byId[id]);
    const dead = cars.length - alive.length;
    panel.innerHTML = `
      <div class="b8c-head">
        <div class="b8c-kicker">廳六 · 法庭</div>
        <div class="b8c-title">誰站上被告席？</div>
        <div class="b8c-sub">還能選的有 <b>${alive.length}</b> 台。
          已經因為你的立場而出局：<b>${dead}</b> 台（立場不會因為換人而歸零）。</div>
      </div>
      <div class="b8c-body">
        ${STATE.stances.length ? `<div class="b8c-done">你已經說過：${
          STATE.stances.map((s) => esc(s.label)).join('、')}。這些話留著，不會收回。</div>` : ''}
        <div class="b8c-list">${alive.map((c) => `
          <button class="b8c-row" data-pick="${c.id}">
            <span>${esc(carName(c))}</span>
            <small>${fmtInt(c.price)} 元　安全 ${c.safetyCount}／配備 ${c.comfortCount}</small>
          </button>`).join('')}
        </div>
        ${defsPanelHTML()}
      </div>
      <div class="b8c-foot"><div class="b8c-est">價格為原廠公布建議售價；其餘推估值一律標註「${ESTIMATE_NOTE}」。</div></div>`;
    panel.querySelectorAll('[data-pick]').forEach((b) => {
      b.addEventListener('click', () => chooseDefendant(b.dataset.pick));
    });
  }

  function renderTrial() {
    const d = byId[st.defendantId];
    const acc = st.accusations[0];
    const opts = optionsFor(acc);
    const total = st.originalOrder.length;
    const doneN = total - st.accusations.length;
    const dots = st.originalOrder.map((id) => {
      if (st.resolved.has(id)) return '<span class="b8c-dot done"></span>';
      if (acc && id === acc.id) return '<span class="b8c-dot now"></span>';
      return '<span class="b8c-dot"></span>';
    }).join('');

    const optHTML = opts.length ? opts.map((o) => `
      <button class="b8c-btn" data-stance="${o.def.id}">
        <b>「${esc(o.def.label)}」</b>
        <span class="b8c-cost">代價：現在就淘汰 ${o.newDead} 台（這個立場的完整定義共 ${o.def.count} 台）</span>
      </button>`).join('')
      : `<div class="b8c-note">${acc.noOptions
        ? '這一條沒有任何立場可以擋。資料上它每一維都輸，說什麼都是狡辯。'
        : '你剩下的立場，沒有一個擋得掉這一條。'}</div>`;

    const unavailable = defs
      .filter((s) => !takenIds().includes(s.id))
      .map((s) => ({ s, why: s.predicate(d) ? '這個立場會把被告自己淘汰' : conflictReason(s.id) }))
      .filter((x) => x.why);

    panel.innerHTML = `
      <div class="b8c-head">
        <div class="b8c-kicker">廳六 · 法庭　被告</div>
        <div class="b8c-title">${esc(carName(d))}</div>
        <div class="b8c-sub">${fmtInt(d.price)} 元　主動安全 ${d.safetyCount}／11　內裝配備 ${d.comfortCount}／13　
          保固 ${esc(warrantyText(d.warranty))}　行李廂 ${d.cargo == null ? NO_DATA : d.cargo + ' L'}</div>
      </div>
      <div class="b8c-body">
        <div class="b8c-count">${dots}</div>
        <div class="b8c-acc" id="b8c-acc">
          <div class="b8c-acclabel">第 ${doneN + 1} 項指控 · ${esc(acc.title)}（共 ${total} 項）</div>
          <div class="b8c-acctext">${acc.text}</div>
          <div class="b8c-note">${esc(acc.note)}</div>
        </div>
        <div class="b8c-opts">
          ${optHTML}
          <button class="b8c-btn b8c-give" data-give="1">
            <b>我認輸</b>
            <span class="b8c-cost">這台車沉入平台之下，重新選一台。但你說過的話全部留著。</span>
          </button>
        </div>
        ${unavailable.length ? `<div class="b8c-note">不能用的立場：${
          unavailable.map((x) => `「${esc(x.s.label)}」（${esc(x.why)}）`).join('；')}</div>` : ''}
        ${[...st.resolved.entries()].length ? `<div class="b8c-done">已經擋下 ${st.resolved.size} 項：<br>${
          [...st.resolved.values()].map(esc).join('<br>')}</div>` : ''}
        ${defsPanelHTML()}
      </div>
      <div class="b8c-foot">
        <div class="b8c-est">一旦表態就不能反悔。用過的立場不會再出現。${ESTIMATE_NOTE}的項目已在該條指控下方標明。</div>
      </div>`;
    requestAnimationFrame(() => panel.querySelector('#b8c-acc')?.classList.add('in'));
    panel.querySelectorAll('[data-stance]').forEach((b) => {
      b.addEventListener('click', () => takeStance(b.dataset.stance));
    });
    panel.querySelector('[data-give]')?.addEventListener('click', giveUp);
  }

  function renderLost() {
    const d = byId[st.defendantId];
    panel.innerHTML = `
      <div class="b8c-head">
        <div class="b8c-kicker">廳六 · 法庭</div>
        <div class="b8c-title">${esc(carName(d))} 認輸了</div>
        <div class="b8c-sub">它沉到平台之下。你說過的 ${STATE.stances.length} 個立場全部保留，
          被它們淘汰掉的車不會回來。</div>
      </div>
      <div class="b8c-body"><div class="b8c-note">重新選一台被告——不過，你的選擇範圍已經比剛才小了。</div></div>
      <div class="b8c-foot"></div>`;
  }

  function renderVerdict() {
    const d = byId[st.defendantId];
    const alive = aliveIdSet().size;
    panel.innerHTML = `
      <div class="b8c-head">
        <div class="b8c-kicker">廳六 · 法庭　判決</div>
        <div class="b8c-title">${esc(carName(d))}</div>
        <div class="b8c-sub">撐過了 ${st.originalOrder.length} 項指控。</div>
      </div>
      <div class="b8c-body">
        <div class="b8c-done">${[...st.resolved.values()].map(esc).join('<br>') || '檢方一開始就提不出指控。'}</div>
        <div class="b8c-note">代價：你說了 ${STATE.stances.length} 個立場
          ${STATE.stances.length ? `（${STATE.stances.map((s) => esc(s.label)).join('、')}）` : ''}，
          場上從 ${cars.length} 台剩下 ${alive} 台。這些立場之後不會被清空。</div>
        ${defsPanelHTML()}
      </div>
      <div class="b8c-foot"><button class="b8c-btn b8c-give" data-end="1"><b>走向結局</b>
        <span class="b8c-cost">結算你的一夜：你去了哪裡、沒去哪裡、哪些話是為了守住這台車才說的。</span></button></div>`;
    panel.querySelector('[data-end]')?.addEventListener('click', () => {
      emit(EV.ENDING, { room: ROOM_KEY, carId: st.defendantId });
    });
    verdictEl.innerHTML = `<h2>無　罪</h2><p>它沒有被資料壓垮——但你為它付出的代價，
      會在結局裡一條一條列給你看。</p>`;
    requestAnimationFrame(() => verdictEl.classList.add('in'));
  }

  function render() {
    verdictEl.classList.remove('in');
    if (st.phase === 'verdict') verdictEl.style.display = '';
    else { verdictEl.innerHTML = ''; }
    if (st.phase === 'select') renderSelect();
    else if (st.phase === 'trial') renderTrial();
    else if (st.phase === 'lost') renderLost();
    else if (st.phase === 'verdict') {
      const wait = Math.max(0, st.verdictAt - performance.now());
      panel.innerHTML = `<div class="b8c-head"><div class="b8c-kicker">廳六 · 法庭</div>
        <div class="b8c-title">…</div></div>`;
      setTimeout(() => { if (st.phase === 'verdict') renderVerdict(); }, wait);
    }
  }

  /* ── RoomHandle ─────────────────────────────────────── */
  const handle = {
    key: ROOM_KEY,
    group,
    spawn: { pos: [0, 1.6, Math.min(11, courtD / 2 - 4)], yaw: 0 },

    enter() {
      if (!el.isConnected) (ctx.ui || document.body).appendChild(el);
      const alive = aliveIdSet();
      const chosen = STATE.chosenCarId;
      if (chosen && alive.has(chosen)) chooseDefendant(chosen);
      else { st.phase = 'select'; layoutFleet(null); render(); }
      emit(EV.ROOM_ENTER, { room: ROOM_KEY });
    },

    exit() {
      el.remove();
      emit(EV.ROOM_EXIT, { room: ROOM_KEY });
    },

    update(dt, elapsed) {
      now = elapsed;
      try { rig?.update?.(dt, elapsed); } catch (e) { /* noop */ }
      try { ctx.carModels?.update?.(dt, elapsed, ctx.camera); } catch (e) { /* noop */ }
      for (let i = anims.length - 1; i >= 0; i--) {
        const a = anims[i];
        if (elapsed < a.start) continue;
        const k = Math.min(1, (elapsed - a.start) / a.dur);
        try { a.tick(k); } catch (e) { /* noop */ }
        if (k >= 1) { try { a.done?.(); } catch (e) { /* noop */ } anims.splice(i, 1); }
      }
      if (defendantMesh) defendantMesh.rotation.y += dt * 0.05;   // 極慢的自轉，看得完整
    },

    dispose() {
      el.remove();
      anims.length = 0;
      clearDock();
      try { fleet?.dispose?.(); } catch (e) { /* noop */ }
      try { rig?.dispose?.(); } catch (e) { /* noop */ }
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose?.();
      });
      group.clear?.();
    },

    // 給 test/room6.html 檢視用（非 RoomHandle 規格的一部分）
    _debug: { defs, conflicts, buildAccusations, state: st, aliveIdSet },
  };

  return handle;
}
