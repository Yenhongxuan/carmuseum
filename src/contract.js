/**
 * contract.js — 介面契約（第 0 階段，單線程產出）
 *
 * 假設：
 *   - 所有模組以原生 ES Module 載入（<script type="module">），不經打包器。
 *   - three.js 由 main.js 透過 importmap 提供，模組內以 `import * as THREE from 'three'` 取得。
 * 依賴：無（本檔不可 import 任何其他專案模組，避免循環相依）。
 *
 * 鐵則：跨模組通訊一律只走 EVENTS，任何模組不得直接 import 另一個模組的內部狀態。
 */

/**
 * 場景 API。由 main.js 在第 3 階段以真實實作覆寫（Object.assign(SCENE_API, impl)）。
 * 子代理只可「呼叫」，不可重新賦值整個物件。
 *
 * addRoom(name: string, config: RoomConfig) -> void
 *      RoomConfig = { build(ctx): RoomHandle }
 *      ctx        = { THREE, scene, renderer, camera, materials, lighting, cars, api }
 *      RoomHandle = { group: THREE.Group, enter(), exit(), update(dt, t), dispose() }
 * getCarMesh(carId: string) -> THREE.Object3D | null   （B4 提供的三層降級模型）
 * getMaterial(name: string) -> THREE.Material | null   （只能由 B2 材質庫提供）
 * onEnterRoom(name, cb) / onExitRoom(name, cb) -> () => void（回傳解除註冊函式）
 */
export const SCENE_API = {
  addRoom(name, config) { _rooms.set(name, config); return config; },
  getRoom(name) { return _rooms.get(name) || null; },
  listRooms() { return [..._rooms.keys()]; },
  getCarMesh(/* carId */) { return null; },
  getMaterial(/* name */) { return null; },
  onEnterRoom(name, cb) { return _on('room:enter', name, cb); },
  onExitRoom(name, cb) { return _on('room:exit', name, cb); },
};

const _rooms = new Map();

/**
 * 全域狀態。所有模組共讀共寫同一個物件參考。
 * 修改後必須 emit('state:changed', {keys:[...]})，否則其他模組不會知道。
 */
export const STATE = {
  // 十個權重，0–10 步進 0.1
  weights: { price:1, safety:1, equip:1, fuel:1, power:1, space:1, park:1, tax:1, warranty:1, dealer:1 },
  alive: [],        // string[]  尚未被淘汰的 car id
  visited: {},      // { [roomName]: { enters:number, ms:number } }
  stances: [],      // 廳六用過的立場 { id, label, eliminated:string[], usedAt:number }
  slot: { len:500, wid:240, hei:200 },   // 使用者自家車位（公分）
  useDaysPerYear: 52,
  chosenCarId: null,   // 被告席上的車
  removedRegrets: [],  // 廳五已移除的減速帶編號
};

/** 跨模組通訊唯一管道 */
export const EVENTS = new EventTarget();

/** emit('room:enter', {room:'gallery'}) */
export function emit(type, detail = {}) {
  EVENTS.dispatchEvent(new CustomEvent(type, { detail }));
}
/** on('state:changed', cb) -> off() */
export function on(type, cb) {
  EVENTS.addEventListener(type, cb);
  return () => EVENTS.removeEventListener(type, cb);
}
function _on(type, name, cb) {
  const h = (e) => { if (!name || e.detail?.room === name) cb(e.detail); };
  EVENTS.addEventListener(type, h);
  return () => EVENTS.removeEventListener(type, h);
}

/** 六個展廳的正式名稱（room key），所有模組一律使用這些字串。 */
export const ROOMS = {
  GALLERY:     'room1_elimination',   // 廳一 美術館 · 淘汰
  PARKING:     'room2_parking',       // 廳二 窄巷 · 車位
  VOID:        'room3_void',          // 廳三 空無 · 停車場
  FIVE_YEARS:  'room4_fiveyears',     // 廳四 五年 · 隧道
  CIRCUIT:     'room5_circuit',       // 廳五 賽道
  COURT:       'room6_court',         // 廳六 法庭
};

/** 事件名稱表（避免各模組拼錯字串） */
export const EV = {
  STATE_CHANGED: 'state:changed',
  WEIGHTS_CHANGED: 'weights:changed',
  ROOM_ENTER: 'room:enter',
  ROOM_EXIT: 'room:exit',
  CAR_ELIMINATED: 'car:eliminated',
  CAR_REVIVED: 'car:revived',
  CAR_CHOSEN: 'car:chosen',
  SLOT_CHANGED: 'slot:changed',
  USEDAYS_CHANGED: 'usedays:changed',
  REGRET_REMOVED: 'regret:removed',
  STANCE_TAKEN: 'stance:taken',
  ENDING: 'ending:show',
};

/** 全域視覺紀律：動效曲線一律自訂 cubic-bezier，禁用 linear 與預設 ease。 */
export const EASE = {
  micro:      'cubic-bezier(0.32, 0.72, 0.28, 1.00)',   // 150–200ms 微互動
  component:  'cubic-bezier(0.22, 0.61, 0.24, 1.00)',   // 300–400ms 元件轉場
  region:     'cubic-bezier(0.65, 0.02, 0.15, 1.00)',   // 1200–2000ms 區域轉場
  inOutQuint: 'cubic-bezier(0.83, 0.00, 0.17, 1.00)',
};
/** JS 版本的同名曲線（給 three.js 的補間用），t ∈ [0,1] */
export const EASE_FN = {
  inOutQuint: (t) => t < 0.5 ? 16*t*t*t*t*t : 1 - Math.pow(-2*t + 2, 5) / 2,
  outCubic:   (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2,
};

/** 缺資料時全站唯一的顯示字串。不可寫 0、不可留白、不可估算。 */
export const NO_DATA = '原廠從未公布';
/** 所有推估值的標註字串（必須以較小字級呈現） */
export const ESTIMATE_NOTE = '使用者假設值／推估，非原廠資料';

/** 讀取 39 台車。回傳陣列，並已由 scoring.js 掛上 .s 正規化分數。 */
export async function loadCars(url = './data/cars.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cars.json 載入失敗：${res.status}`);
  const json = await res.json();
  return json;
}
