/**
 * ending.js — B8 結局（第 2 階段子代理產出）
 *
 * 這不是一個 3D 場景，是覆蓋在畫面上的一層 DOM（掛在 ctx.ui 底下）。
 * 它做四件事，而且四件都必須誠實：
 *   ① 揭露你的一夜是怎麼過的（時間分配全部由 STATE.visited 即時算）
 *   ② 指出哪些立場是「為了守住這台車才說的」（isConvenient / survivesAllAttacks）
 *   ③ 開一張 2–3 台的試駕清單，每台寫明現場要確認什麼
 *   ④ 承認資料的邊界
 *
 * ── 假設（全部列出）──────────────────────────────────────────────
 *  A1 ctx 依 MODULE_API.md §4 提供；STATE.visited 由 main.js 累積成
 *     { [roomKey]: { enters:number, ms:number } }，ms 為停留毫秒。
 *     STATE.visited 為空（單獨測試、或玩家真的沒進過任何廳）時，
 *     本檔顯示「一夜的紀錄是空的」而不是編一組百分比出來。
 *  A2 STATE.chosenCarId 為 null（法庭上沒有被告）時，改用 scoring.rank(STATE.weights)
 *     的第一名當「你最後停在的那台」，並在畫面上明講這是排序結果不是你的選擇。
 *  A3 廳六的指控產生器在本檔「重寫了一份一模一樣的」——因為 MODULE_API.md §9 鐵則
 *     禁止展廳模組互相 import。兩份必須同步維護（room6_court.js 的 buildAccusations）。
 *  A4 五年持有成本的每一個數字（成交折讓、殘值率、油價、年里程、保險、保養）
 *     都是使用者假設值，一律以較小字級標註 contract.js 的 ESTIMATE_NOTE，
 *     且逐條列出假設本身，讓人可以不同意。
 *  A5 cargo === null 一律印 contract.js 的 NO_DATA，絕不寫 0、不留白、不估算。
 *
 * ── 立場 predicate（與 room6_court.js 同一份定義，實算台數）─────────
 *   我要油電 32｜保固比配備重要 26｜價格是唯一底線 13｜品牌可靠度 > 配備 14｜
 *   服務據點對我很重要 7｜我一年只開八千公里 0｜我幾乎不倒車進窄位 0｜後座很少載人 0
 *   （表格值為 30 / 26 / 13 / 7 / 7 / 0 / 0 / 0；第 1、4 條依實算為準，見 room6_court.js 檔頭）
 *
 * ── 依賴（依賴注入，不 import）──────────────────────────────────
 *   ctx.ui（DOM 掛載點）、ctx.cars / ctx.carsById、ctx.STATE。
 *   本檔只 import ../contract.js 與 ../scoring.js，不碰 three.js，也不 import 任何 rooms/。
 *
 * ── 未達成的規格（誠實列出）──────────────────────────────────────
 *   U1 「你把 62% 的時間花在賽道上」這一段的句型是即時生成的，
 *      但「賽道」只是目前停留最久的那一廳，不保證是賽道。
 *   U2 五年持有成本沒有任何一項是原廠或政府公告值（年稅除外，取自 cars.json），
 *      因此整塊都掛著推估註記；不打算假裝它精確。
 *   U3 isConvenient 只在「這組立場真的擋得住所有指控」時才有意義；
 *      若被告本來就擋不住（例如被完全支配），本檔不會把每個立場都標成「為了守住它而說」，
 *      而是直接講明「沒有任何立場救得了它」。
 */

import {
  STATE, EV, on, EASE, NO_DATA, ESTIMATE_NOTE, ROOMS,
} from '../contract.js';
import {
  DIMS, WARRANTY_SCORE, DEALER_SCORE, dominates, rank, computeScores,
} from '../scoring.js';

/* ══════════════════════════════════════════════════════════════════
   一、與 room6_court.js 同步的純邏輯（見檔頭 A3）
   ══════════════════════════════════════════════════════════════════ */

const HYBRID_RE = /Hybrid|e:HEV/i;
const isHybrid = (c) => HYBRID_RE.test(c.trim || '');
const REVERSE_ITEMS = ['倒車主動煞停', '後方橫向車流警示', '後停車雷達', '前停車雷達', '360度環景'];
const DECLARED_CONFLICTS = [['price', 'brand']];

const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const wan = (n) => {
  const v = n / 10000;
  return (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));
};
const carName = (c) => `${c.brand} ${c.model} ${c.trim}`.trim();
const warrantyText = (w) => w
  .replace('5年不限里程', '5 年不限里程').replace('3年不限里程', '3 年不限里程')
  .replace('5年15萬公里', '5 年 15 萬公里').replace('3年10萬公里', '3 年 10 萬公里');

export function buildStanceDefs(cars) {
  const N = cars.length;
  const commit = (c) => (WARRANTY_SCORE[c.warranty] + DEALER_SCORE[c.dealer]) / 2;
  const commitMedian = cars.map(commit).sort((a, b) => a - b)[Math.floor(N / 2)];
  const shortestWarranty = Object.entries(WARRANTY_SCORE).sort((a, b) => a[1] - b[1])[0][0];
  const priceCut = [...cars].sort((a, b) => b.price - a.price)[Math.ceil(N / 3) - 1].price;
  const defs = [
    { id: 'hybrid', label: '我要油電', aspect: '油電', immunes: ['fuel'], predicate: (c) => !isHybrid(c), predicateText: '淘汰所有非油電車（trim 不含 Hybrid 或 e:HEV 者）' },
    { id: 'warranty', label: '保固比配備重要', aspect: '保固', immunes: ['equip'], predicate: (c) => c.warranty === shortestWarranty, predicateText: `淘汰保固為全場最短的「${shortestWarranty}」者` },
    { id: 'price', label: '價格是唯一底線', aspect: '價格', immunes: ['warranty'], predicate: (c) => c.price >= priceCut, predicateText: `淘汰價格最貴的三分之一（售價 ≥ ${fmtInt(priceCut)} 元）` },
    { id: 'brand', label: '品牌可靠度 > 配備', aspect: '品牌可靠度', immunes: ['equip', 'safety'], predicate: (c) => commit(c) < commitMedian, predicateText: `以「原廠承諾＝(保固分＋據點分)/2」為代理指標，淘汰低於全場中位數 ${commitMedian.toFixed(2)} 者（cars.json 沒有可靠度欄位）` },
    { id: 'dealer', label: '服務據點對我很重要', aspect: '服務據點', immunes: [], predicate: (c) => c.dealer === '少', predicateText: '淘汰服務據點為「少」者' },
    { id: 'lowmile', label: '我一年只開八千公里', aspect: '油耗', immunes: ['fuel'], predicate: () => false, predicateText: '不淘汰任何車，只解除油耗指控' },
    { id: 'noreverse', label: '我幾乎不倒車進窄位', aspect: '倒車安全', immunes: ['reverse'], predicate: () => false, predicateText: '不淘汰任何車，只解除停車／倒車類安全指控' },
    { id: 'rearseat', label: '後座很少載人', aspect: '行李廂', immunes: ['cargo'], predicate: () => false, predicateText: '不淘汰任何車，只解除行李廂指控' },
  ];
  for (const d of defs) {
    d.eliminated = cars.filter(d.predicate).map((c) => c.id);
    d.count = d.eliminated.length;
  }
  return defs;
}

export function buildAccusations(d, cars, aliveIds, immuneTags = new Set()) {
  const rivals = cars.filter((c) => c.id !== d.id && aliveIds.has(c.id));
  const out = [];
  const push = (a) => { if (!a.tags.some((t) => immuneTags.has(t))) out.push(a); };

  const doms = rivals.filter((x) => dominates(d, x));
  if (doms.length) {
    const x = doms.sort((a, b) => a.price - b.price)[0];
    push({
      id: 'dominated', tags: ['dominated'], noOptions: true, title: '被完全支配', aspect: '整體',
      text: `${carName(x)} 在 ${DIMS.length} 個面向上都不輸你選的這台。你為什麼要選被完全壓過的那台？`,
    });
  }
  const cheaper = rivals.filter((x) => x.price < d.price
    && x.safetyCount >= d.safetyCount && x.comfortCount >= d.comfortCount)
    .sort((a, b) => a.price - b.price)[0];
  if (cheaper) {
    push({
      id: 'cheaper', tags: ['price', 'equip'], title: '更便宜且不輸', aspect: '價格',
      text: `${carName(cheaper)} 便宜 ${wan(d.price - cheaper.price)} 萬，主動安全與內裝配備都不輸你選的這台。`,
    });
  }
  const sp = rivals.filter((x) => Math.abs(x.price - d.price) <= 30000
    && (x.safetyCount + x.comfortCount) > (d.safetyCount + d.comfortCount))
    .sort((a, b) => (b.safetyCount + b.comfortCount) - (a.safetyCount + a.comfortCount))[0];
  if (sp) {
    push({
      id: 'samePrice', tags: ['equip'], title: '同價位更好', aspect: '配備',
      text: `同樣的價錢，${carName(sp)} 多給你 ${(sp.safetyCount + sp.comfortCount) - (d.safetyCount + d.comfortCount)} 項配備。`,
    });
  }
  Object.keys(d.safety || {}).filter((k) => !d.safety[k])
    .map((k) => ({
      item: k,
      all: cars.filter((c) => c.safety && c.safety[k]).length,
      aliveN: rivals.filter((c) => c.safety && c.safety[k]).length,
    }))
    .filter((m) => m.aliveN > 0)
    .sort((a, b) => b.all - a.all)
    .slice(0, 3)
    .forEach((m) => {
      const tags = ['safety'];
      if (REVERSE_ITEMS.includes(m.item)) tags.push('reverse');
      push({
        id: `safety:${m.item}`, tags, title: '缺關鍵安全', aspect: '主動安全', item: m.item,
        text: `它沒有『${m.item}』。${cars.length} 台裡有 ${m.all} 台有。你為什麼不選那 ${m.all} 台之一？`,
      });
    });
  if (d.cargo == null) {
    push({
      id: 'cargo', tags: ['cargo'], title: '行李廂無資料', aspect: '行李廂',
      text: `它的行李廂容積${NO_DATA}。你連放不放得下嬰兒推車都不知道，就要買了？`,
    });
  }
  const best = rivals.filter((x) => WARRANTY_SCORE[x.warranty] > WARRANTY_SCORE[d.warranty])
    .sort((a, b) => WARRANTY_SCORE[b.warranty] - WARRANTY_SCORE[a.warranty] || a.price - b.price)[0];
  if (best) {
    push({
      id: 'warranty', tags: ['warranty'], title: '保固短', aspect: '保固',
      text: `保固只有 ${warrantyText(d.warranty)}。${best.brand} ${best.model} 是 ${warrantyText(best.warranty)}。第 37 個月出問題，你自己付。`,
    });
  }
  const cheapTax = rivals.filter((x) => x.tax < d.tax).sort((a, b) => a.tax - b.tax)[0];
  if (d.tax === 17440 && cheapTax) {
    push({
      id: 'tax', tags: ['tax'], title: '稅金高', aspect: '稅金',
      text: `年稅 ${fmtInt(d.tax)}，五年 ${wan(d.tax * 5)} 萬。${cheapTax.model} 只要 ${fmtInt(cheapTax.tax)}，五年差 ${wan((d.tax - cheapTax.tax) * 5)} 萬。`,
    });
  }
  const betterDealer = rivals.filter((x) => DEALER_SCORE[x.dealer] > DEALER_SCORE[d.dealer]);
  if (d.dealer === '少' && betterDealer.length) {
    push({
      id: 'dealer', tags: ['dealer'], title: '據點少', aspect: '服務據點',
      text: `${d.brand} 的據點是全場最少的一群。保養那天你要多開 25 分鐘。`,
    });
  }
  const thirsty = rivals.filter((x) => x.kml - d.kml >= 3).sort((a, b) => b.kml - a.kml)[0];
  if (thirsty) {
    push({
      id: 'fuel', tags: ['fuel'], title: '油耗差', aspect: '油耗',
      text: `${carName(thirsty)} 每公升多跑 ${(thirsty.kml - d.kml).toFixed(1)} 公里（${thirsty.kml} vs ${d.kml} km/L）。`,
    });
  }
  return out;
}

export function stanceEffects(stanceIds, defs) {
  const immune = new Set(); const dead = new Set();
  for (const id of stanceIds) {
    const d = defs.find((x) => x.id === id);
    if (!d) continue;
    d.immunes.forEach((t) => immune.add(t));
    d.eliminated.forEach((c) => dead.add(c));
  }
  return { immune, dead };
}

/** ★ 這組立場能不能擋掉被告的每一條指控。完整實作，不是 stub。 */
export function survivesAllAttacks(defendant, stances, cars, defs) {
  const ids = stances.map((s) => (typeof s === 'string' ? s : s.id));
  const { immune, dead } = stanceEffects(ids, defs);
  if (dead.has(defendant.id)) return false;            // 你的立場把自己選的車也殺了
  const alive = new Set(cars.filter((c) => !dead.has(c.id)).map((c) => c.id));
  return buildAccusations(defendant, cars, alive, immune).length === 0;
}

/** ★ 拿掉這個立場，被告就守不住 → 這個立場是「為了守住它才說的」 */
export function isConvenient(stance, defendant, allStances, cars, defs) {
  const without = allStances.filter((s) => s.id !== stance.id);
  return !survivesAllAttacks(defendant, without, cars, defs);
}

/* ══════════════════════════════════════════════════════════════════
   二、廳名與敘述
   ══════════════════════════════════════════════════════════════════ */

const ROOM_INFO = {
  [ROOMS.GALLERY]: {
    name: '美術館', ord: '廳一',
    was: (i) => `在那裡你看的是 ${i.fleet} 台車的價目與規格。`,
    missed: (i) => `你沒去美術館。${i.fleet} 台車的價目表整晚掛在那裡，你一張都沒有走近看。`,
  },
  [ROOMS.PARKING]: {
    name: '車位廳', ord: '廳二',
    was: () => '你在那裡量過自家車位。',
    missed: (i) => `<strong>你也沒去車位廳。</strong>你選的這台車長 ${fmtInt(i.car.length)}mm`
      + `——<strong>你不知道它進不進得去你家。</strong>`
      + `（你設定的車位長 ${i.slot.len} 公分＝${fmtInt(i.slot.len * 10)}mm，`
      + `${i.car.length <= i.slot.len * 10
        ? `帳面上前後剩 ${((i.slot.len * 10 - i.car.length) / 10).toFixed(1)} 公分`
        : `帳面上就短了 ${((i.car.length - i.slot.len * 10) / 10).toFixed(1)} 公分`}，但你沒有親眼看過。）`,
  },
  [ROOMS.VOID]: {
    name: '空無停車場', ord: '廳三',
    was: () => '那裡一台車都沒有，只有你自己的十個權重。',
    missed: () => '你沒去空無停車場。那裡沒有車，只有你自己的權重長什麼樣子——你沒有看過自己的形狀。',
  },
  [ROOMS.FIVE_YEARS]: {
    name: '五年隧道', ord: '廳四',
    was: () => '你在那裡開過了 58 個月的減速帶。',
    missed: () => '你沒進五年隧道。第 37 個月那道減速帶——保固到期的那一道——你到現在還不知道它有多顛。',
  },
  [ROOMS.CIRCUIT]: {
    name: '賽道', ord: '廳五',
    was: () => '你在那裡讓你的權重實際跑了一圈。',
    missed: () => '你沒上賽道。你給的十個權重，從頭到尾沒有被跑過一次。',
  },
  [ROOMS.COURT]: {
    name: '法庭', ord: '廳六',
    was: (i) => `你在那裡聽完了檢方的指控（依現在的資料重算，它身上有 ${i.accCount} 項）。`,
    missed: (i) => `<strong>但你一次都沒走進法庭</strong>——那裡有 <strong>${i.accCount}</strong> 項指控等著你，`
      + `<strong>你選擇不面對。</strong>`,
  },
};
const ROOM_ORDER = [ROOMS.GALLERY, ROOMS.PARKING, ROOMS.VOID, ROOMS.FIVE_YEARS, ROOMS.CIRCUIT, ROOMS.COURT];

/* ══════════════════════════════════════════════════════════════════
   三、試駕清單
   ══════════════════════════════════════════════════════════════════ */

function checksFor(c, cars, slot) {
  const out = [];
  if (c.cargo == null) {
    out.push(/HR-V/i.test(c.model)
      ? `<b>${c.model} 系列的行李廂容積，原廠從未公布，只能現場實測。</b>`
        + `帶你平常會放的東西去：嬰兒推車、行李箱、你買菜的那兩個袋子，直接塞進去看。`
      : `行李廂容積${NO_DATA}——現場自己量，或把你要放的東西直接放進去試。規格表幫不了你。`);
  } else {
    out.push(`行李廂帳面 ${c.cargo} L，但開口高度與底板深度規格表沒寫。現場把後座倒下看看是不是平的。`);
  }
  const missReverse = REVERSE_ITEMS.filter((k) => c.safety && !c.safety[k]);
  if (missReverse.length) {
    out.push(`它沒有『${missReverse.join('』『')}』。找一個窄車位，倒進去一次，看你受不受得了。`);
  }
  const shortest = Object.entries(WARRANTY_SCORE).sort((a, b) => a[1] - b[1])[0][0];
  if (c.warranty === shortest) {
    out.push(`保固 ${warrantyText(c.warranty)}，是全場最短的一種。當場問業務：第 37 個月之後的延長保固怎麼買、多少錢、含哪些件。`);
  }
  if (c.dealer === '少') {
    out.push(`服務據點是全場最少的一群。出發前先查清楚離你家最近的 ${c.brand} 保養廠在哪、實際開過去要多久。`);
  }
  if (c.tax === Math.max(...cars.map((x) => x.tax))) {
    out.push(`年稅 ${fmtInt(c.tax)} 元是全場最高的一級，五年 ${wan(c.tax * 5)} 萬。這筆錢跟你開不開它沒有關係。`);
  }
  const hpSorted = [...cars].map((x) => x.hp).sort((a, b) => a - b);
  if (c.hp <= hpSorted[Math.floor(cars.length / 4)]) {
    out.push(`馬力 ${c.hp} 匹，在 ${cars.length} 台裡屬於偏低的一群。請試：滿載上坡起步、以及路口起步的頓挫。`);
  }
  if (slot && c.length > slot.len * 10 - 200) {
    out.push(`車長 ${fmtInt(c.length)}mm，你的車位長 ${fmtInt(slot.len * 10)}mm，前後只剩 `
      + `${((slot.len * 10 - c.length) / 10).toFixed(1)} 公分。拿捲尺去量你家車位，不要相信直覺。`);
  }
  return out.slice(0, 4);
}

/* ══════════════════════════════════════════════════════════════════
   四、樣式
   ══════════════════════════════════════════════════════════════════ */

const CSS = `
.b8e{position:absolute;inset:0;overflow-y:auto;background:#EDEEF0;color:#1B1E23;
  font:400 16px/1.85 "Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;
  opacity:0;transition:opacity 1600ms ${EASE.region};pointer-events:auto}
.b8e.in{opacity:1}
.b8e *{box-sizing:border-box}
.b8e-wrap{max-width:720px;margin:0 auto;padding:10vh 28px 22vh}
.b8e h1{font-size:15px;font-weight:400;letter-spacing:.3em;color:#7A8290;margin:0 0 6px}
.b8e h2{font-size:13px;font-weight:700;letter-spacing:.24em;color:#8A5F5B;margin:0 0 14px;text-transform:uppercase}
.b8e .car{font-size:32px;font-weight:700;line-height:1.35;letter-spacing:.01em;margin:0 0 10px}
.b8e .lede{font-size:14px;color:#5B6472;margin:0}
.b8e section{margin-top:52px;padding-top:26px;border-top:1px solid #D9DEE5;
  opacity:0;transform:translateY(14px);
  transition:opacity 900ms ${EASE.component},transform 900ms ${EASE.component}}
.b8e section.in{opacity:1;transform:none}
.b8e p{margin:0 0 12px}
.b8e strong{font-weight:700}
.b8e .big{font-size:19px;line-height:1.85}
.b8e .fixed{border-left:3px solid #C8D0DC;padding-left:16px}
.b8e .small{font-size:11.5px;line-height:1.7;color:#8A92A0}
.b8e .bar{display:flex;height:8px;border:1px solid #D5DAE1;background:#FFF;margin:14px 0 10px;overflow:hidden}
.b8e .bar i{display:block;height:100%;transition:flex-grow 1200ms ${EASE.region}}
.b8e .legend{display:flex;flex-wrap:wrap;gap:10px 18px;font-size:12px;color:#5B6472;margin-bottom:18px}
.b8e .legend span::before{content:'';display:inline-block;width:8px;height:8px;margin-right:6px;transform:translateY(-1px)}
.b8e .card{background:#F7F8FA;border:1px solid #DDE2E8;border-radius:2px;padding:16px 18px;margin:12px 0}
.b8e .card h3{margin:0 0 4px;font-size:18px;font-weight:700}
.b8e .card .meta{font-size:12.5px;color:#7A8290;margin-bottom:10px}
.b8e .card ul{margin:0;padding-left:18px}
.b8e .card li{margin:6px 0}
.b8e .stance{border:1px solid #DDE2E8;background:#FFF;padding:13px 15px;margin:10px 0;border-radius:2px}
.b8e .stance.conv{border-color:#C9A9A5;background:#FBF6F5}
.b8e .stance .lab{font-weight:700}
.b8e table{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}
.b8e td{padding:7px 0;border-bottom:1px solid #E4E8ED}
.b8e td:last-child{text-align:right;font-variant-numeric:tabular-nums}
.b8e .edge{opacity:0;transform:translateY(18px);
  transition:opacity 1500ms ${EASE.region},transform 1500ms ${EASE.region}}
.b8e .edge.in{opacity:1;transform:none}
.b8e .edge .big{font-size:20px}
.b8e .close{position:fixed;top:20px;right:24px;background:#FFF;border:1px solid #CDD4DD;border-radius:2px;
  padding:8px 14px;font:inherit;font-size:13px;color:#1B1E23;cursor:pointer;
  transition:transform 180ms ${EASE.micro},box-shadow 180ms ${EASE.micro}}
.b8e .close:hover{transform:translateY(-1px) scale(1.02);box-shadow:0 8px 18px rgba(27,30,35,.12)}
`;

/* ══════════════════════════════════════════════════════════════════
   五、createEnding
   ══════════════════════════════════════════════════════════════════ */

export function createEnding(ctx) {
  const cars = (ctx.cars || []).slice();
  if (cars.length && !cars[0].s) computeScores(cars);
  const byId = ctx.carsById || Object.fromEntries(cars.map((c) => [c.id, c]));
  const defs = buildStanceDefs(cars);

  const el = document.createElement('div');
  el.className = 'b8e';
  el.style.display = 'none';
  const style = document.createElement('style');
  style.textContent = CSS;
  el.appendChild(style);
  const wrap = document.createElement('div');
  wrap.className = 'b8e-wrap';
  el.appendChild(wrap);
  (ctx.ui || document.body).appendChild(el);

  const timers = [];
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  const clearTimers = () => { timers.forEach(clearTimeout); timers.length = 0; };
  const esc = (s) => String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));

  const offEnding = on(EV.ENDING, () => api.show());

  /* ── 內容組裝 ─────────────────────────────────────── */

  function pickDefendant() {
    if (STATE.chosenCarId && byId[STATE.chosenCarId]) {
      return { car: byId[STATE.chosenCarId], chosen: true };
    }
    const r = rank(cars, STATE.weights);
    return { car: r[0].car, chosen: false };
  }

  function nightHTML(car, accCount) {
    const v = STATE.visited || {};
    const rows = ROOM_ORDER.map((k) => ({
      key: k, info: ROOM_INFO[k], ms: Math.max(0, v[k]?.ms || 0), enters: v[k]?.enters || 0,
    }));
    const total = rows.reduce((a, b) => a + b.ms, 0);
    const visited = rows.filter((r) => r.enters > 0 || r.ms > 0);
    // 沒去的廳：法庭與車位廳先講（它們是這一夜最貴的兩個缺席），其餘照展廳順序
    const MISS_FIRST = [ROOMS.COURT, ROOMS.PARKING];
    const missed = rows.filter((r) => !(r.enters > 0 || r.ms > 0))
      .sort((a, b) => {
        const ia = MISS_FIRST.indexOf(a.key); const ib = MISS_FIRST.indexOf(b.key);
        return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib);
      });

    if (!total && !visited.length) {
      return `<h2>你的一夜</h2>
        <p class="big">這一夜的紀錄是空的——<strong>六個廳，你一個都沒有進去過。</strong></p>
        <p class="big"><strong>因為六廳是自由探索的，你沒去的地方是你的選擇，不是系統的疏漏。</strong></p>
        <p class="small">時間分配取自 STATE.visited；目前它是空的，所以這裡不會編一組百分比給你看。</p>`;
    }

    const pct = (r) => (total ? (r.ms / total) * 100 : 0);
    const info = { accCount, car, slot: STATE.slot, fleet: cars.length };
    const top = [...rows].sort((a, b) => b.ms - a.ms)[0];
    const COLORS = ['#8FA6BE', '#A8B9A0', '#C2A98F', '#9E9BB5', '#B79196', '#8FB0AE'];

    let html = `<h2>你的一夜</h2>`;
    html += `<p class="big"><strong>你把 ${pct(top).toFixed(0)}% 的時間花在${esc(top.info.name)}上。</strong>`
      + `（${(top.ms / 1000 / 60).toFixed(1)} 分鐘，進出 ${top.enters} 次。）</p>`;
    html += `<div class="bar">${rows.map((r, i) => (r.ms > 0
      ? `<i style="flex:${r.ms} 1 0;background:${COLORS[i]}"></i>` : '')).join('')}</div>`;
    html += `<div class="legend">${rows.map((r, i) => '<span>'
      + `<span style="display:inline-block;width:8px;height:8px;background:${COLORS[i]}"></span> `
      + `${esc(r.info.ord)} ${esc(r.info.name)} ${pct(r).toFixed(0)}%`
      + `${r.enters ? '' : '（沒去）'}</span>`).join('')}</div>`;

    for (const r of visited) {
      if (r === top) continue;
      html += `<p>你在${esc(r.info.name)}待了 ${pct(r).toFixed(0)}%（${(r.ms / 1000 / 60).toFixed(1)} 分鐘、`
        + `進出 ${r.enters} 次）。${esc(r.info.was(info))}</p>`;
    }
    for (const r of missed) {
      html += `<p class="big">${r.info.missed(info)}</p>`;
    }
    html += `<p class="big"><strong>因為六廳是自由探索的，你沒去的地方是你的選擇，不是系統的疏漏。</strong></p>`;
    html += `<p class="small">百分比＝該廳停留毫秒 ÷ 六廳停留毫秒總和（STATE.visited，即時計算）。`
      + `法庭那一句的指控數，是用你這台車現在的資料重跑一次檢方產生器算出來的。`
      + `車長取自 cars.json。</p>`;
    return html;
  }

  function stancesHTML(car) {
    const stances = (STATE.stances || []).map((s) => ({ ...s }));
    if (!stances.length) {
      return `<h2>你說過的話</h2>
        <p class="big">你一個立場都沒有說過。</p>
        <p>這代表兩件事：你沒有為了守住任何一台車而改口，
        但你也沒有替自己劃下任何一條線——最後這台車是被留下的，不是被選擇的。</p>`;
    }
    const survives = survivesAllAttacks(car, stances, cars, defs);
    const conv = survives
      ? stances.filter((s) => isConvenient(s, car, stances, cars, defs))
      : [];

    let html = `<h2>你說過的話</h2>`;
    html += `<p>你一共說了 <strong>${stances.length}</strong> 個立場，`
      + `它們替你淘汰了 <strong>${new Set(stances.flatMap((s) => s.eliminated || [])).size}</strong> 台車。`
      + `這些話沒有被清空過，也不能收回。</p>`;

    for (const s of stances) {
      const def = defs.find((d) => d.id === s.id);
      const isConv = conv.some((c) => c.id === s.id);
      html += `<div class="stance${isConv ? ' conv' : ''}">
        <div class="lab">「${esc(s.label || def?.label || s.id)}」　
          <span class="small">淘汰 ${(s.eliminated || []).length} 台</span></div>
        <div class="small">${esc(def ? def.predicateText : '（這個立場不在本檔認得的八個之內）')}</div>
        ${isConv ? `<p style="margin-top:8px">${conv.length === 1
          ? '<strong>這是你唯一一個「為了守住它而說」的立場。</strong>'
          : `<strong>這是你為了守住它才說的 ${conv.length} 個立場之一。</strong>`}<br>`
          + `<strong>如果你其實在意${esc(def?.aspect || s.aspect || '這件事')}，這台車守不住。</strong></p>` : ''}
      </div>`;
    }

    if (!survives) {
      html += `<p class="big"><strong>而且就算把這些話全部算進去，它還是擋不住檢方。</strong>`
        + `沒有任何一個立場救得了它——所以這裡不標「哪一句是為了它而說」，那樣講就太便宜了。</p>`;
    } else if (!conv.length) {
      html += `<p class="big">沒有任何一個立場是「為了守住它而說」的：把其中任何一句拿掉，這台車還是站得住。</p>`;
    }
    html += `<p class="small">判準：把某一個立場拿掉之後，重跑一次檢方的指控產生器；`
      + `若被告因此擋不住了，那一句就是為了守住它才說的（isConvenient / survivesAllAttacks）。</p>`;
    return html;
  }

  function driveHTML(car) {
    const r = rank(cars, STATE.weights);
    const others = r.map((x) => x.car).filter((c) => c.id !== car.id).slice(0, 2);
    const list = [car, ...others];
    let html = `<h2>去試駕這 ${list.length} 台</h2>`;
    html += `<p>名單＝你選的那一台，加上在你目前權重下排最前面的 ${others.length} 台。
      下面每一條都是<strong>現場才能確認</strong>的事。</p>`;
    for (const c of list) {
      html += `<div class="card">
        <h3>${esc(carName(c))}${c.id === car.id ? '　<span class="small">你選的這台</span>' : ''}</h3>
        <div class="meta">${fmtInt(c.price)} 元　${c.hp} 匹　${c.kml} km/L　
          車長 ${fmtInt(c.length)}mm　軸距 ${fmtInt(c.wheelbase)}mm　
          行李廂 ${c.cargo == null ? NO_DATA : `${c.cargo} L`}　保固 ${esc(warrantyText(c.warranty))}</div>
        <ul>${checksFor(c, cars, STATE.slot).map((t) => `<li>${t}</li>`).join('')}</ul>
      </div>`;
    }
    const top2 = r.slice(0, 2);
    if (top2.length === 2 && top2[0].v > 0) {
      const gap = (top2[0].v - top2[1].v) / top2[0].v;
      if (gap < 0.03) {
        html += `<p class="big">${esc(carName(top2[0].car))} 與 ${esc(carName(top2[1].car))} 的加權總分只差 `
          + `${(gap * 100).toFixed(1)}%。<br>這兩台在你的權重下實質相當。<strong>建議依實際試駕決定。</strong></p>`;
      } else {
        html += `<p class="small">前兩名（${esc(carName(top2[0].car))}、${esc(carName(top2[1].car))}）`
          + `的加權總分差 ${(gap * 100).toFixed(1)}%，超過 3%，所以這裡沒有「兩台實質相當」那句話。</p>`;
      }
    }
    return html;
  }

  function costHTML(car) {
    const A = {
      discount: 0.05, resid: 0.55, fuelPrice: 30, kmPerYear: 12000,
      insurancePerYear: 30000, servicePerYear: 12000, years: 5,
    };
    const deal = car.price * (1 - A.discount);
    const resale = car.price * A.resid;
    const depreciation = deal - resale;
    const fuel = (A.kmPerYear / car.kml) * A.fuelPrice * A.years;
    const tax = car.tax * A.years;
    const ins = A.insurancePerYear * A.years;
    const svc = A.servicePerYear * A.years;
    const total = depreciation + fuel + tax + ins + svc;
    const row = (k, v, note) => `<tr><td>${k}${note ? `<br><span class="small">${note}</span>` : ''}</td>`
      + `<td>${fmtInt(v)} 元</td></tr>`;
    return `<h2>五年，這台車大概要花你多少</h2>
      <table>
        ${row('成交價（推估）', deal, `原廠建議售價 ${fmtInt(car.price)} 元 × 折讓 ${A.discount * 100}%`)}
        ${row('五年後殘值（推估）', resale, `假設殘值率 ${A.resid * 100}%`)}
        ${row('五年折舊（推估）', depreciation, '成交價 − 殘值')}
        ${row('五年油錢（推估）', fuel, `年跑 ${fmtInt(A.kmPerYear)} 公里 ÷ ${car.kml} km/L × ${A.fuelPrice} 元`)}
        ${row('五年牌照＋燃料稅', tax, `年稅 ${fmtInt(car.tax)} 元 × 5（此欄取自 cars.json，不是推估）`)}
        ${row('五年保險（推估）', ins, `假設每年 ${fmtInt(A.insurancePerYear)} 元`)}
        ${row('五年保養（推估）', svc, `假設每年 ${fmtInt(A.servicePerYear)} 元`)}
        <tr><td><strong>五年持有成本合計（推估）</strong></td><td><strong>${fmtInt(total)} 元</strong></td></tr>
      </table>
      <p class="small">除年稅之外，上表每一個數字都是<strong>${ESTIMATE_NOTE}</strong>。
        折讓、殘值率、油價、年里程、保險與保養都是我替你假設的，你完全可以不同意——
        把假設換掉，結論就會換。行李廂等原廠未公布的欄位一律寫「${NO_DATA}」，不折算、不補 0。</p>`;
  }

  const EDGE_HTML = `
    <p class="big"><strong>我能告訴你的都說完了。</strong></p>
    <p class="big">但有三件事，<strong>資料永遠答不了</strong>，你必須親自去確認：</p>
    <p class="big"><strong>① 座椅</strong>——合不合你的背？只有坐十分鐘才知道。</p>
    <p class="big"><strong>② 後座</strong>——請你爸媽實際坐一次。規格表上的軸距，不會告訴你他的膝蓋離前座多遠。</p>
    <p class="big"><strong>③ 變速箱</strong>——低速起步的頓挫你受不受得了？</p>
    <p class="big"><strong>這不是我偷懶。這是資料的邊界。</strong></p>`;

  function render() {
    const { car, chosen } = pickDefendant();
    const accCount = buildAccusations(
      car, cars, new Set(cars.map((c) => c.id)), new Set(),
    ).length;

    wrap.innerHTML = `
      <header>
        <h1>結局</h1>
        <div class="car">${esc(carName(car))}</div>
        <p class="lede">${fmtInt(car.price)} 元　主動安全 ${car.safetyCount}／11　內裝配備 ${car.comfortCount}／13　
          行李廂 ${car.cargo == null ? NO_DATA : `${car.cargo} L`}　保固 ${esc(warrantyText(car.warranty))}
          <br>${chosen ? '這是你自己送上被告席的那一台。'
        : '你沒有選定任何一台——這是照你現在的十個權重排出來的第一名，不是你的選擇。'}</p>
      </header>
      <section data-s>${nightHTML(car, accCount)}</section>
      <section data-s>${stancesHTML(car)}</section>
      <section data-s>${driveHTML(car)}</section>
      <section data-s>${costHTML(car)}</section>
      <section data-s class="fixed"><div class="edge" data-edge>${EDGE_HTML}</div></section>`;

    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '回到展場';
    close.addEventListener('click', () => api.hide());
    wrap.appendChild(close);

    // 逐段浮現（元件轉場 300–400ms 的節奏，區段之間錯開）
    const secs = [...wrap.querySelectorAll('[data-s]')];
    secs.forEach((s, i) => later(() => s.classList.add('in'), 260 + i * 340));

    // ★ 「資料的邊界」之前留 0.7 秒靜止
    const edge = wrap.querySelector('[data-edge]');
    if (!edge) return;
    const revealEdge = () => later(() => edge.classList.add('in'), 700);
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver((ents) => {
        for (const e of ents) {
          if (e.isIntersecting) { io.disconnect(); revealEdge(); }
        }
      }, { threshold: 0.25 });
      io.observe(edge);
      later(() => { io.disconnect(); edge.classList.add('in'); }, 30000);  // 保險：不看也要看得到
    } else {
      later(revealEdge, 260 + secs.length * 340);
    }
  }

  /* ── 對外 ─────────────────────────────────────────── */
  const api = {
    el,
    show() {
      clearTimers();
      el.style.display = '';
      el.scrollTop = 0;
      render();
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
    },
    hide() {
      clearTimers();
      el.classList.remove('in');
      later(() => { el.style.display = 'none'; }, 1600);
    },
    dispose() {
      clearTimers();
      offEnding();
      el.remove();
      wrap.innerHTML = '';
    },
    // 給 test/ending.html 檢視用（非規格的一部分）
    _debug: { defs, buildAccusations, survivesAllAttacks, isConvenient, render },
  };
  return api;
}
