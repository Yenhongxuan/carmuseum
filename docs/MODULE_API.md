# MODULE_API.md — 第 2 階段子代理的唯一介面依據

> 本檔由主代理在第 0 階段單線程產出（第 2 階段前補完）。
> **子代理不得修改本檔。** 有歧義先回報主代理，不可自行假設。

## 0. 全域約定

- **單位**：1 three.js unit = **1 公尺**。所有規格表上的 mm / cm 一律換算成公尺。
- **座標**：Y 軸向上。地面在 `y = 0`。
- **車輛本地座標**：`+X` = 車輛右側，`+Y` = 上，`-Z` = **車頭前進方向**。
  原點在**四輪接地面的車身正中心**（所以 `y=0` 就是輪胎觸地面）。
- **模組載入**：原生 ES Module。three.js 由 importmap 提供：
  ```js
  import * as THREE from 'three';
  import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
  ```
  已 vendored 的版本是 **r0.185.1**（`./vendor/three/`）。**不可使用 CDN**（沙盒無外網）。
- **禁止**：`localStorage` / `sessionStorage`、`linear` 或預設 `ease` 動效、bloom、深色背景、霓虹。
- **禁止**：任何子代理寫不屬於自己的檔案。

## 1. three.js r185 的四個必知差異（寫錯會整個場景不對）

1. **燈光是物理正確單位**（r155 起 `useLegacyLights` 已移除）：
   - `PointLight` / `SpotLight` 的 `intensity` 是**燭光 (candela)**，且 `decay = 2`（平方反比）。
     室內離地 4–5 m 的軌道燈，合理值約 **80–400**，不是 1。
   - `DirectionalLight` / `AmbientLight` / `HemisphereLight` 的 `intensity` 無距離衰減，
     太陽合理值 **1.5–3.5**，環境補光 **0.2–0.8**。
2. **色彩空間**：`CanvasTexture` 預設 `NoColorSpace`。
   **Albedo / Emissive 貼圖必須手動設 `tex.colorSpace = THREE.SRGBColorSpace`；
   Roughness / Normal / AO / Metalness 貼圖必須維持 `THREE.NoColorSpace`。**
3. **`light.shadow.radius` 在 `PCFSoftShadowMap` 下無作用**（three.js 的 PCF_SOFT shader 不讀 radius）。
   本專案依規格採用 `PCFSoftShadowMap`；仍要設 `radius`，但柔和度主要靠 `mapSize` 與 `normalBias` 調。
   這一點會誠實記錄在 `VERIFY.md` 的「因技術限制而簡化」。
4. **`scene.environment` + `scene.environmentIntensity`** 由 **main.js 統一設定**，
   子代理**不可**自行指派 `scene.environment`，只能透過 `ctx.lighting` 要求切換環境。

## 2. 渲染管線（main.js 擁有；子代理只需知道，不可重設）

```js
renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace   = THREE.SRGBColorSpace;
renderer.toneMapping        = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure= 1.0;                  // 室內 1.0–1.2 / 戶外 0.8–1.0，由 lighting rig 指定
renderer.shadowMap.enabled  = true;
renderer.shadowMap.type     = THREE.PCFSoftShadowMap;
```
相機：`PerspectiveCamera(52, aspect, 0.05, 800)`，眼高 **1.60 m**（坐下時 1.10 m）。

## 3. 檔案所有權（一格都不可越界）

| 代理 | 只能寫 |
|---|---|
| B1 | `src/world/architecture.js` |
| B2 | `src/world/materials.js` |
| B3 | `src/world/lighting.js` |
| B4 | `src/world/carModels.js` |
| B5 | `src/rooms/room1_elimination.js`, `src/rooms/room2_parking.js`, `test/room1.html`, `test/room2.html` |
| B6 | `src/rooms/room3_void.js`, `src/rooms/room4_fiveyears.js`, `test/room3.html`, `test/room4.html` |
| B7 | `src/rooms/room5_circuit.js`, `test/room5.html` |
| B8 | `src/rooms/room6_court.js`, `src/rooms/ending.js`, `test/room6.html`, `test/ending.html` |
| 主代理（第 3 階段） | `index.html`, `src/main.js`, `src/testkit.js`, `VERIFY.md` |

## 4. `ctx` —— 所有 builder / room 收到的唯一參數

```js
ctx = {
  THREE,                    // three.js 命名空間
  renderer, scene, camera,  // 主場景物件
  cars,                     // Array<Car>，39 台，已由 scoring.computeScores() 掛上 .s
  carsById,                 // Record<string, Car>
  materials,                // B2 的 MaterialLibrary（見 §5）
  lighting,                 // B3 的 LightingSystem（見 §6）
  arch,                     // B1 的建築模組命名空間（見 §7）
  carModels,                // B4 的車輛模組命名空間（見 §8）
  ui,                       // HTMLElement，展廳可自由掛 DOM 的 overlay 容器
  STATE, EVENTS, EV, ROOMS, // 直接來自 contract.js
  scoring,                  // scoring.js 的命名空間
}
```

**單獨測試時**：`test/*.html` 自行組出一個最小 ctx 即可（見 §9）。

## 5. B2 `src/world/materials.js` 必須匯出

```js
export function createMaterialLibrary(ctx): MaterialLibrary
export const MATERIAL_NAMES: string[]

interface MaterialLibrary {
  get(name: string): THREE.Material          // 找不到必須 throw，不可回 undefined
  has(name: string): boolean
  texture(name: string): { map, roughnessMap, normalMap, aoMap? }
  setGrayscale(on: boolean): void            // ★ 灰階檢驗：Albedo 全換 #808080，保留 rough/normal
  isGrayscale(): boolean
  setDust(amount01: number): void            // ★ 廳四積灰 0→1，只影響 car.paint / car.tire
  dispose(): void
}
```

**必須提供的材質名稱（一個都不可少，名稱一字不可改）：**

美術館：`floor.oak` `wall.paint` `ceiling` `skirting` `frame.wood` `frame.glass`
`track.rail` `track.head` `track.reflector` `bench.wood` `plinth` `label.card`

其餘五景：`asphalt` `roadline` `concrete.wall` `curb` `tunnel.tile` `tunnel.grime`
`kerb.redwhite` `barrier.concrete` `barrier.metal` `grass.blade` `soil` `sky`
`court.platform` `court.stone` `chainlink` `lightpole` `daycell` `daycell.dim`

車輛：`car.paint` `car.glass` `car.tire` `car.wheel` `car.lamp` `car.trim` `car.shadow`

**每一種材質都必須有 Roughness Map ＋ Normal Map ＋ 含髒污的 Albedo**（`sky` 與
`car.shadow` 例外，它們是純 Albedo）。貼圖用 Canvas 2D 程序生成後包成 `THREE.CanvasTexture`。

## 6. B3 `src/world/lighting.js` 必須匯出

```js
export function createLightingSystem(ctx): LightingSystem
export const ENV_KINDS = ['gallery','alley','lot','tunnel','circuit','court'];

interface LightingSystem {
  makeRig(roomKey: string): LightRig        // roomKey 用 ROOMS.* 常數
  setEnvironment(kind: string): void        // 換 scene.environment（PMREM）與 environmentIntensity
  dispose(): void
}
interface LightRig {
  group: THREE.Group        // 所有燈與燈具模型都掛在這裡，room 只要 add(rig.group)
  exposure: number          // 該場景建議的 toneMappingExposure，main.js 會套用
  envKind: string           // 進入該廳時要切換的環境貼圖種類
  update(dt: number, elapsed: number): void
  setTimeOfDay?(t01: number): void
  dispose(): void
}
```
六個 rig 對應 `ROOMS.GALLERY / PARKING / VOID / FIVE_YEARS / CIRCUIT / COURT`。
**軌道燈的軌道與燈具本體要建模**（材質向 `ctx.materials` 拿 `track.*`，不可自己 new Material）。

## 7. B1 `src/world/architecture.js` 必須匯出

```js
export function buildGallery(ctx): THREE.Group     // 廳一 美術館
export function buildAlley(ctx): THREE.Group       // 廳二 窄巷
export function buildLot(ctx): THREE.Group         // 廳三 空無停車場
export function buildTunnel(ctx): THREE.Group      // 廳四 五年隧道
export function buildCircuit(ctx): CircuitBuild    // 廳五 賽道
export function buildCourt(ctx): THREE.Group       // 廳六 法庭
export const DIMENSIONS: Record<string, object>    // ★ 每個場景的實際尺寸，供 VERIFY.md 逐項對照

interface CircuitBuild {
  group: THREE.Group
  curve: THREE.CatmullRomCurve3   // 賽道中心線（封閉）
  width: number                   // 賽道寬（公尺）
  lengthM: number                 // 一圈長度（公尺）
  sampleAt(u: number): { pos: THREE.Vector3, tangent: THREE.Vector3, up: THREE.Vector3, bank: number }
}
```
所有材質一律 `ctx.materials.get(...)`，**B1 不可自己 new 任何 Material**。
所有燈光一律 `ctx.lighting.makeRig(...)`，**B1 不可自己 new 任何 Light**。
**每個場景都要有明確邊界、踢腳板/收邊、至少 3 個「只有真實世界才有」的雜物、地面不可完全水平。**

## 8. B4 `src/world/carModels.js` 必須匯出

```js
export function createCarModels(ctx): CarModels

interface CarModels {
  getCarMesh(carId: string): THREE.Group      // LOD0 完整單台（近看／被告席／駕駛座用）
  createFleet(carIds: string[]): Fleet        // ★ 39 台同場時必須走這條（InstancedMesh + LOD）
  getTier(carId): { tier: 1|2|3, label: string, note: string }
  getFootprint(carId): { length, width, height, wheelbase }   // 公尺
  getEyePoint(carId): THREE.Vector3           // ★ 駕駛座眼點，依真實車高決定
  createSpin360(frames: string[], el: HTMLElement): Spin360   // 第一層；本次無素材，仍須實作
  update(dt, elapsed, camera): void
  dispose(): void
}
interface Fleet {
  group: THREE.Group
  setTransform(i: number, pos: THREE.Vector3, quat: THREE.Quaternion): void
  setHighlight(i: number, on: boolean): void
  setVisible(i: number, on: boolean): void
  indexOf(carId: string): number
  commit(): void        // 一次性 flush instanceMatrix.needsUpdate
}
```

**tier 標籤字串（一字不可改）：**
- tier 1 → `原廠官網 360 環景（N 張）`
- tier 2 → `原廠官網照片（N 個角度）`
- tier 3 → `依原廠公布尺寸程序生成之示意模型，非原廠 CAD 資料`

**本次全部 39 台皆為 tier 3**（外網被白名單擋，見 `assets/SUMMARY.md`）。
`createSpin360` 仍須完整實作（預載、去背羽化、隨角度變形的落地陰影、閒置慢轉、慣性），
以便日後補素材即可升級。

**車頂線分段依實際車高（不依品牌名單）：**
`height > 1620mm` → 平直車頂 / 直立後窗 ｜ `1560–1620mm` → 中間值 ｜ `< 1560mm` → 下斜車頂 / 大傾角後窗
輪距與輪徑照規格：`前輪中心 = (車長-軸距)/2*0.95`、`後輪中心 = 前輪中心+軸距`、`輪徑 = 車高*0.17`

## 9. B5–B8 展廳模組必須匯出

```js
export const ROOM_KEY: string           // 用 ROOMS.* 常數
export function createRoom(ctx): RoomHandle

interface RoomHandle {
  key: string
  group: THREE.Group                    // 場景內容（含 arch build 出來的 group 與 lighting rig）
  spawn: { pos: [x,y,z], yaw: number }  // 進入時相機起始位置與朝向
  enter(): void                         // 掛 DOM、啟動時間軸
  exit(): void                          // 收 DOM、暫停
  update(dt: number, elapsed: number, camera: THREE.Camera): void
  dispose(): void
}
```

**鐵則：**
- 展廳模組**只可 import** `../contract.js`、`../scoring.js`，**不可 import 任何 `world/` 或別的 `rooms/` 模組**。
  建築、材質、光照、車模一律從 `ctx.arch / ctx.materials / ctx.lighting / ctx.carModels` 取得（依賴注入）。
- 跨展廳通訊只走 `EVENTS`（`contract.js` 的 `emit` / `on`）。
- 每個展廳自己的 DOM 掛在 `ctx.ui` 底下，`exit()` 時必須移除。
- **檔案開頭註解：假設了什麼、依賴什麼。**
- **各附一個最小測試入口 `test/roomN.html`**，可用 `python3 -m http.server 8000` 後單獨開啟。

### `test/roomN.html` 的最小樣板（子代理照抄後改 import 路徑即可）

```html
<!doctype html><meta charset="utf-8"><title>room N test</title>
<style>html,body{margin:0;height:100%;background:#EDEEF0}#ui{position:fixed;inset:0;pointer-events:none}
#ui>*{pointer-events:auto}</style>
<script type="importmap">{"imports":{
 "three":"../vendor/three/build/three.module.js",
 "three/addons/":"../vendor/three/addons/"}}</script>
<div id="ui"></div>
<script type="module">
import * as THREE from 'three';
import { makeTestCtx } from '../src/testkit.js';   // 主代理於第 3 階段提供
import { createRoom } from '../src/rooms/roomN_xxx.js';
const ctx = await makeTestCtx({ mount: document.body, ui: document.getElementById('ui') });
const room = createRoom(ctx); ctx.scene.add(room.group); room.enter();
ctx.startLoop((dt, t) => room.update(dt, t, ctx.camera));
</script>
```
> `src/testkit.js` 由**主代理**在第 3 階段提供（負責組出 renderer / scene / camera / materials /
> lighting / arch / carModels / cars 的最小 ctx，並提供 `startLoop`）。
> 子代理**只需照這個樣板寫 test html**，不必自己實作 testkit。

## 10. 決策記錄（使用者已裁決，不可再改）

- **抓圖階段跳過**：車廠官網被沙盒白名單擋（403 policy denial），39 台全部走 tier 3 示意模型。
- **廳四受衝擊台數以「資料實算」為準（使用者選 A）**：
  文案條件不變，台數一律**由 cars.json 即時算出**，**不可硬編**。
  已知實算值：第 3 月 12｜第 8 月 **5**｜第 14 月 22｜第 19 月 14｜第 24 月 **17**｜
  第 31 月 **14**｜第 37 月 29｜第 42 月 **13**｜第 50 月 7｜第 58 月 39。
- 20 條減速帶的命中數已與資料**全數吻合**，照原表即可（仍建議即時算）。
