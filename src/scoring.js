/**
 * scoring.js — 十維正規化評分與支配關係（第 0 階段，單線程產出）
 *
 * 假設：
 *   - 輸入為 data/cars.json 的 cars 陣列（39 台）。
 *   - cargo 為 null 代表「原廠從未公布」，不是 0；計算一律給中位數 0.5。
 *   - torque 為 null（油電車原廠未列）同樣給中位數 0.5，不可當 0。
 * 依賴：無（純函式，不 import 任何模組，可單獨在 node 中測試）。
 */

/** 十個維度的正式順序。所有排序、雷達圖、支配比較一律照這個順序。 */
export const DIMS = ['price','safety','equip','fuel','power','space','park','tax','warranty','dealer'];

export const DIM_LABEL = {
  price:'價格', safety:'主動安全', equip:'內裝配備', fuel:'油耗', power:'動力',
  space:'空間', park:'好停', tax:'稅金', warranty:'保固', dealer:'服務據點',
};

export const WARRANTY_SCORE = {
  '5年不限里程': 1.00,
  '5年15萬公里': 0.85,
  '3年不限里程': 0.55,
  '3年10萬公里': 0.40,
};
export const DEALER_SCORE = { '多': 1.00, '中': 0.60, '少': 0.30 };

/** 無資料時一律使用的中位數。不可改成 0。 */
export const MEDIAN = 0.5;

const rng = (v, min, max) => (max - min) === 0 ? MEDIAN : (v - min) / (max - min);
const inv = (v, min, max) => (max - min) === 0 ? MEDIAN : (max - v) / (max - min);

/**
 * 計算全體的極值。只取有資料者參與極值計算（null 不得拉低 min）。
 */
export function bounds(cars) {
  const num = (k) => cars.map(c => c[k]).filter(v => typeof v === 'number');
  const mm = (a) => ({ min: Math.min(...a), max: Math.max(...a) });
  return {
    price: mm(num('price')), kml: mm(num('kml')), hp: mm(num('hp')),
    torque: mm(num('torque')), wheelbase: mm(num('wheelbase')),
    cargo: mm(num('cargo')), length: mm(num('length')), width: mm(num('width')),
    tax: mm(num('tax')),
  };
}

/**
 * 為每台車計算 .s（十個維度，皆為「越大越好」的 0–1 分數）並就地掛上。
 * 回傳同一個 cars 陣列。
 */
export function computeScores(cars) {
  const b = bounds(cars);
  for (const c of cars) {
    const s = {};
    s.price  = inv(c.price, b.price.min, b.price.max);
    s.safety = c.safetyCount / 11;
    s.equip  = c.comfortCount / 13;
    s.fuel   = rng(c.kml, b.kml.min, b.kml.max);
    s.power  = 0.70 * rng(c.hp, b.hp.min, b.hp.max)
             + 0.30 * (c.torque != null ? rng(c.torque, b.torque.min, b.torque.max) : MEDIAN);
    s.space  = 0.55 * rng(c.wheelbase, b.wheelbase.min, b.wheelbase.max)
             + 0.45 * (c.cargo != null ? rng(c.cargo, b.cargo.min, b.cargo.max) : MEDIAN);
    s.park   = 0.65 * inv(c.length, b.length.min, b.length.max)
             + 0.35 * inv(c.width,  b.width.min,  b.width.max);
    s.tax    = inv(c.tax, b.tax.min, b.tax.max);
    s.warranty = WARRANTY_SCORE[c.warranty];
    s.dealer   = DEALER_SCORE[c.dealer];
    if (s.warranty === undefined) throw new Error(`未知保固字串：${c.warranty}（${c.id}）`);
    if (s.dealer === undefined)   throw new Error(`未知據點字串：${c.dealer}（${c.id}）`);
    for (const k of DIMS) s[k] = Math.min(1, Math.max(0, s[k]));
    c.s = s;
    // 缺資料標記：畫面上必須顯示 NO_DATA，計算上用了中位數，兩者不可混淆
    c.imputed = { space: c.cargo == null, power: c.torque == null };
  }
  return cars;
}

/** 加權總分。weights 全為 0 時分母保護為 1。 */
export function score(car, weights) {
  const tot = Object.values(weights).reduce((a,b) => a+b, 0) || 1;
  return DIMS.reduce((a,k) => a + car.s[k] * weights[k], 0) / tot;
}

/** b 支配 a：b 每一維都不輸 a，且至少一維嚴格勝過。 */
export function dominates(a, b, dims = DIMS) {
  return dims.every(d => b.s[d] >= a.s[d]) && dims.some(d => b.s[d] > a.s[d]);
}

/** 權重為 0 的維度不參與支配比較（權重歸零時支配關係要重算）。 */
export function activeDims(weights) {
  const act = DIMS.filter(d => weights[d] > 0);
  return act.length ? act : DIMS;
}

/** 回傳 [{ car, by:[支配它的車] }]，只列出至少被一台完全支配者。 */
export function dominatedSet(cars, weights = null) {
  const dims = weights ? activeDims(weights) : DIMS;
  const out = [];
  for (const a of cars) {
    const by = cars.filter(b => b !== a && dominates(a, b, dims));
    if (by.length) out.push({ car: a, by, dims });
  }
  return out;
}

/** 依加權總分由高到低排序，回傳 [{car, v, rank}]。 */
export function rank(cars, weights) {
  return cars.map(c => ({ car: c, v: score(c, weights) }))
             .sort((x,y) => y.v - x.v)
             .map((x,i) => ({ ...x, rank: i+1 }));
}

/** 兩台車在哪些維度上有差異（給廳一「輸在哪」用）。 */
export function diffDims(a, b, eps = 1e-9) {
  return DIMS.filter(d => Math.abs(a.s[d] - b.s[d]) > eps)
             .map(d => ({ dim: d, label: DIM_LABEL[d], a: a.s[d], b: b.s[d], delta: b.s[d]-a.s[d] }))
             .sort((x,y) => Math.abs(y.delta) - Math.abs(x.delta));
}

/** 配備完全相同的雙胞胎（安全 11 碼與便利 13 碼皆相同） */
export function twins(cars) {
  const map = new Map();
  for (const c of cars) {
    const k = `${c.safetyCode}|${c.comfortCode}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(c);
  }
  const pairs = [];
  for (const group of map.values()) {
    for (let i=0;i<group.length;i++) for (let j=i+1;j<group.length;j++)
      pairs.push({ a: group[i], b: group[j], priceGap: Math.abs(group[i].price - group[j].price) });
  }
  return pairs;
}
