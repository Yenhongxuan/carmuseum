/**
 * lighting.js — B3 六個場景的光照（第 2 階段子代理產出）
 *
 * 假設（全部列出，B1/B5–B8 若尺寸不同請以 rig.layout 覆寫後呼叫 rig.relayout()）：
 *   1. 1 unit = 1 m，Y 向上，地面 y = 0（MODULE_API §0）。
 *   2. 廳一 美術館：室內淨空間約 16 m(X) × 22 m(Z)、天花板 5.6 m；
 *      畫掛在 x = ±7.9 的兩道長牆上，畫心高 y = 1.55 m，沿 Z 每 3.6 m 一幅（每側 5 幅）。
 *      高側窗在 +X 牆的上緣（y ≈ 4.4–5.3 m），光由 +X 上方斜射入內。
 *   3. 廳二 窄巷：巷道沿 −Z 延伸，入口在 z = 0、巷底在 z = −24；牆在 x = ±1.6、牆高 7 m。
 *   4. 廳三 空無停車場：日格灰丘區以原點為中心 12 × 12 m；陰影相機涵蓋 ±18 m。
 *   5. 廳四 五年隧道：行進方向 −Z，內壁 x = ±4，拱頂 5.2 m；隧道燈間距 10 m、共 8 盞循環復用；
 *      setTravel(d) 的 d 是「車輛自世界原點沿 −Z 已行進的公尺數」（車輛世界座標 z = −d）。
 *   6. 廳五 賽道：賽道中心在原點附近；預設陰影相機 ±35 m，B7 應每幀呼叫 rig.followShadow(carPos)
 *      把陰影相機收到 ±22 m 以取得可用的陰影解析度。
 *   7. 廳六 法庭：天花板 3 × 3 m 方形開口，中心在 (0, 6.0, 0)；被告席平台在原點。
 *   8. ctx.materials 一定存在且提供 MODULE_API §5 的全部名稱（track.rail / track.head /
 *      track.reflector / car.shadow 是本檔會用到的四個）。
 *
 * 依賴：ctx.THREE（不在模組頂層 import three）、ctx.renderer、ctx.scene、
 *       ctx.materials（只拿燈具外殼與落地陰影材質）。本檔只 import ../contract.js 取 ROOMS 常數。
 *
 * 已知限制（誠實記錄）：
 *   - `light.shadow.radius` 在 `PCFSoftShadowMap` 下無作用（three 的 PCF_SOFT shader 不讀 radius）。
 *     本檔仍照規格設上 radius = 3，實際柔和度靠 mapSize 2048 + normalBias 0.02 取得。
 *   - 未使用 RectAreaLight：它需要 addon `RectAreaLightUniformsLib.init()`，而 MODULE_API §2 的
 *     渲染管線由 main.js 擁有且未初始化該表；未初始化時 RectAreaLight 會全黑。故窗光採方案 (a)
 *     SpotLight + light.map 窗格 cookie。
 *   - 三個白天場景（廳一 6000K／廳三 5700K／廳五 5800K）的主光色溫依規格被鎖在 5500–6000K
 *     區間內，彼此差距不大；真正的「換了地方」靠 rig.fillTempK（3000K↔7600K）、exposure
 *     與 environmentIntensity 拉開。rig 同時提供 fillTempK 與 sceneTempK 供第 3 階段驗證。
 *   - 廳五「遠處熱空氣扭曲」未實作：需要 postprocessing / 自訂 shader pass，而渲染管線不屬本檔。
 *   - 未觸碰 scene.background（那是 B1 的 `sky` 材質天空球負責），只動 scene.environment /
 *     scene.environmentIntensity。
 *   - 環境貼圖（IBL）用的發光面材質、法庭光柱的加法混合材質、微塵的 PointsMaterial、
 *     以及 SpotLight 的 cookie 貼圖，都是「光」而不是「表面材質」，B2 的材質表沒有對應名稱，
 *     因此由本檔自行建立並自行 dispose。所有真正的**表面**材質（軌道、燈頭、反射罩、落地陰影）
 *     一律 ctx.materials.get(...)，本檔不 new 任何表面材質。
 *   - makeContactShadow() 會 clone('car.shadow') 以取得每個實例獨立的 opacity；clone 的材質由 rig 自行 dispose。
 */

import { ROOMS } from '../contract.js';

export const ENV_KINDS = ['gallery', 'alley', 'lot', 'tunnel', 'circuit', 'court'];

/** 每個 roomKey 對應的環境貼圖種類 */
export const ROOM_ENV_KIND = {
  [ROOMS.GALLERY]:    'gallery',
  [ROOMS.PARKING]:    'alley',
  [ROOMS.VOID]:       'lot',
  [ROOMS.FIVE_YEARS]: 'tunnel',
  [ROOMS.CIRCUIT]:    'circuit',
  [ROOMS.COURT]:      'court',
};

/** 各環境的 scene.environmentIntensity（室內 0.8–1.0、戶外 1.0–1.3） */
const ENV_INTENSITY = {
  gallery: 0.85,
  alley:   0.90,
  lot:     1.20,
  tunnel:  0.75,
  circuit: 1.10,
  court:   0.80,
};

/* ────────────────────────────── 通用小工具 ────────────────────────────── */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
/** 永遠回傳 [0, m) 的取模（JS 的 % 對負數會回負值） */
const mod = (n, m) => ((n % m) + m) % m;

/**
 * 色溫 (K) → RGB（sRGB 空間、0–1）。
 * 自寫的 Tanner Helland 近似式，不依賴任何外部套件。
 * ★ 回傳值已正規化為 max(r,g,b) = 1 —— 色溫只決定「色相」，亮度一律交給 light.intensity 決定，
 *   否則低色溫會連帶把燈變暗，難以對照規格上的 candela 值。
 */
export function kelvinToRGB(kelvin) {
  const t = clamp(kelvin, 1000, 40000) / 100;
  let r, g, b;
  if (t <= 66) r = 255;
  else r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
  if (t <= 66) g = 99.4708025861 * Math.log(t) - 161.1195681661;
  else g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  r = clamp(r, 0, 255) / 255;
  g = clamp(g, 0, 255) / 255;
  b = clamp(b, 0, 255) / 255;
  const m = Math.max(r, g, b) || 1;
  return { r: r / m, g: g / m, b: b / m };
}

/** 把色溫套到一個 THREE.Color 上（值以 sRGB 解讀，three 會自動轉到 working color space）。 */
function applyKelvin(THREE, color, kelvin) {
  const c = kelvinToRGB(kelvin);
  color.setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace);
  return color;
}
/** 直接產生一個色溫色 */
function kelvinColor(THREE, kelvin) {
  return applyKelvin(THREE, new THREE.Color(), kelvin);
}

/**
 * 陰影統一設定。規格要求每一盞會投影的燈都要這五行。
 * ★ shadow.radius 在 PCFSoftShadowMap 下無作用，仍照規格設上（見檔頭）。
 */
function setupShadow(THREE, light, opt = {}) {
  light.castShadow = true;
  const ms = opt.mapSize || 2048;
  light.shadow.mapSize.set(ms, ms);
  light.shadow.bias = opt.bias !== undefined ? opt.bias : -0.0005;
  light.shadow.normalBias = opt.normalBias !== undefined ? opt.normalBias : 0.02;
  light.shadow.radius = opt.radius !== undefined ? opt.radius : 3;
  const cam = light.shadow.camera;
  if (light.isDirectionalLight) {
    const e = opt.extent !== undefined ? opt.extent : 20;
    cam.left = -e; cam.right = e; cam.top = e; cam.bottom = -e;
    cam.near = opt.near !== undefined ? opt.near : 0.5;
    cam.far = opt.far !== undefined ? opt.far : 140;
  } else if (light.isSpotLight) {
    cam.near = opt.near !== undefined ? opt.near : 0.5;
    cam.far = opt.far !== undefined ? opt.far : 40;
  } else {
    cam.near = opt.near !== undefined ? opt.near : 0.2;
    cam.far = opt.far !== undefined ? opt.far : 30;
  }
  cam.updateProjectionMatrix();
  return light;
}

/** 沙盒 / 無 DOM 環境（例如 node --check 或單元測試）時安全回傳 null */
function makeCanvas(w, h) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/**
 * 窗格 cookie —— 方案 (a)：SpotLight.map。
 * 黑 = 不透光的窗框，白 = 玻璃。投到地板上就是明確的矩形窗格亮斑。
 * ★ light.map 是「顏色調變」，依 MODULE_API §1.2 必須是 SRGBColorSpace。
 */
function makeWindowCookie(THREE, cols = 3, rows = 2) {
  const S = 512;
  const cv = makeCanvas(S, S);
  if (!cv) return null;
  const g = cv.getContext('2d');
  g.fillStyle = '#000000';
  g.fillRect(0, 0, S, S);
  // 窗洞整體只佔中間 84%，四周留黑 → 光斑邊界收得住
  const pad = S * 0.08;
  const W = S - pad * 2, H = S - pad * 2;
  const mull = S * 0.018;             // 窗櫺寬度
  const pw = (W - mull * (cols - 1)) / cols;
  const ph = (H - mull * (rows - 1)) / rows;
  g.fillStyle = '#ffffff';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = pad + c * (pw + mull);
      const y = pad + r * (ph + mull);
      g.fillRect(x, y, pw, ph);
    }
  }
  // 玻璃本身略有不均（老玻璃），避免死板的純白
  g.globalCompositeOperation = 'multiply';
  const grd = g.createLinearGradient(0, 0, S, S);
  grd.addColorStop(0.0, '#ffffff');
  grd.addColorStop(0.5, '#f0f0f0');
  grd.addColorStop(1.0, '#ffffff');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  // 徑向 vignette：光斑邊緣柔和收掉
  const vig = g.createRadialGradient(S / 2, S / 2, S * 0.18, S / 2, S / 2, S * 0.62);
  vig.addColorStop(0.0, '#ffffff');
  vig.addColorStop(0.75, '#c9c9c9');
  vig.addColorStop(1.0, '#000000');
  g.fillStyle = vig;
  g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 柔和橢圓 cookie —— 隧道燈的光斑（沿 X 略拉長） */
function makeEllipseCookie(THREE, stretchX = 1.45) {
  const S = 256;
  const cv = makeCanvas(S, S);
  if (!cv) return null;
  const g = cv.getContext('2d');
  g.fillStyle = '#000000';
  g.fillRect(0, 0, S, S);
  g.save();
  g.translate(S / 2, S / 2);
  g.scale(stretchX, 1 / stretchX);
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, S * 0.46);
  grd.addColorStop(0.00, '#ffffff');
  grd.addColorStop(0.42, '#e8e8e8');
  grd.addColorStop(0.74, '#6e6e6e');
  grd.addColorStop(1.00, '#000000');
  g.fillStyle = grd;
  g.beginPath();
  g.arc(0, 0, S * 0.46, 0, Math.PI * 2);
  g.fill();
  g.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 柔邊方形 cookie —— 法庭天窗（3×3 m 方形開口的形狀證明） */
function makeSquareCookie(THREE) {
  const S = 256;
  const cv = makeCanvas(S, S);
  if (!cv) return null;
  const g = cv.getContext('2d');
  g.fillStyle = '#000000';
  g.fillRect(0, 0, S, S);
  const pad = S * 0.20;
  g.fillStyle = '#ffffff';
  g.fillRect(pad, pad, S - pad * 2, S - pad * 2);
  // 四邊各做一道線性漸層把邊緣化開（不用 filter，相容性較穩）
  g.globalCompositeOperation = 'multiply';
  const edge = S * 0.13;
  const sides = [
    [0, 0, edge, 0], [S, 0, S - edge, 0], [0, 0, 0, edge], [0, S, 0, S - edge],
  ];
  for (const [x0, y0, x1, y1] of sides) {
    const grd = g.createLinearGradient(x0, y0, x1, y1);
    grd.addColorStop(0, '#000000');
    grd.addColorStop(1, '#ffffff');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
  }
  g.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 微塵用的圓形柔邊 sprite */
function makeMoteSprite(THREE) {
  const S = 64;
  const cv = makeCanvas(S, S);
  if (!cv) return null;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.65)');
  grd.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ──────────────────── IBL：六種環境的程序生成 envScene ────────────────────
 * 為什麼 IBL 最重要：白牆、白車、白地板若沒有環境反射，會全部長得一模一樣。
 * IBL 讓每個表面依它「看到的環境」反射不同的顏色與亮度 —— 車頂反射天空的藍、
 * 車底反射地面的暖灰，白色場景的立體感才出得來。
 * 做法：組一個小 THREE.Scene，放幾個「發光面」（MeshBasicMaterial，顏色可 > 1 當作 HDR），
 *       餵給 PMREMGenerator.fromScene()。每個 kind 只生成一次（見 _envCache）。
 * ──────────────────────────────────────────────────────────────────────── */

/** 一片發光面（環境場景專用，不是場景表面材質） */
function envPanel(THREE, own, opts) {
  const {
    w = 1, h = 1, d = 0.02, pos = [0, 0, 0], rot = [0, 0, 0],
    color = '#ffffff', intensity = 1,
  } = opts;
  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color).multiplyScalar(intensity),
    toneMapped: false,
  });
  own.geo.push(geo); own.mat.push(mat);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(pos[0], pos[1], pos[2]);
  m.rotation.set(rot[0], rot[1], rot[2]);
  return m;
}

/** 一個內面發光的盒子（室內環境的底色） */
function envBox(THREE, own, w, h, d, color, intensity) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color).multiplyScalar(intensity),
    side: THREE.BackSide,
    toneMapped: false,
  });
  own.geo.push(geo); own.mat.push(mat);
  return new THREE.Mesh(geo, mat);
}

/**
 * 戶外天空穹頂：天頂藍 → 地平線淺 → 地面暖灰的連續漸層（用逐頂點色，不需要任何貼圖）。
 * 再加一顆小太陽球給金屬與清漆一個明確的高光點。
 */
function envSkyDome(THREE, own, o) {
  const {
    zenith = '#5E8FC7', horizon = '#DCE6F0', ground = '#8A8578',
    zenithI = 1.2, horizonI = 1.9, groundI = 0.62,
    sunDir = [-0.55, 0.42, 0.72], sunColor = '#FFF3E2', sunI = 16, sunSize = 2.6,
  } = o;
  const R = 60;
  const geo = new THREE.SphereGeometry(R, 40, 24);
  const pos = geo.attributes.position;
  const cz = new THREE.Color(zenith).multiplyScalar(zenithI);
  const ch = new THREE.Color(horizon).multiplyScalar(horizonI);
  const cg = new THREE.Color(ground).multiplyScalar(groundI);
  const arr = new Float32Array(pos.count * 3);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / R;
    if (y >= 0) tmp.copy(ch).lerp(cz, smoothstep(y * 1.35));
    else tmp.copy(ch).lerp(cg, smoothstep(-y * 3.0));   // 地平線下很快收斂成地面暖灰
    arr[i * 3] = tmp.r; arr[i * 3 + 1] = tmp.g; arr[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, toneMapped: false,
  });
  own.geo.push(geo); own.mat.push(mat);
  const dome = new THREE.Mesh(geo, mat);

  const sgeo = new THREE.SphereGeometry(sunSize, 16, 12);
  const smat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(sunColor).multiplyScalar(sunI), toneMapped: false,
  });
  own.geo.push(sgeo); own.mat.push(smat);
  const sun = new THREE.Mesh(sgeo, smat);
  const dir = new THREE.Vector3(sunDir[0], sunDir[1], sunDir[2]).normalize().multiplyScalar(R * 0.82);
  sun.position.copy(dir);

  const s = new THREE.Scene();
  s.add(dome); s.add(sun);
  return s;
}

/** gallery 的自建備援（RoomEnvironment 載入失敗時用）：白盒 + 高側窗亮帶 */
function envGalleryFallback(THREE, own) {
  const s = new THREE.Scene();
  s.add(envBox(THREE, own, 16, 6.2, 22, '#F2F3F5', 0.62));
  // 高側窗：+X 牆上緣一整條亮帶（冷白）
  s.add(envPanel(THREE, own, {
    w: 0.05, h: 0.95, d: 18, pos: [7.7, 2.15, 0], color: '#DCE8FA', intensity: 5.2,
  }));
  // 對牆的反射帶（被窗光打亮的白牆下半部）
  s.add(envPanel(THREE, own, {
    w: 0.05, h: 1.6, d: 18, pos: [-7.7, -0.9, 0], color: '#FFFFFF', intensity: 1.35,
  }));
  // 天花板洗牆的漫射面
  s.add(envPanel(THREE, own, {
    w: 13, h: 0.05, d: 19, pos: [0, 2.95, 0], color: '#FFFFFF', intensity: 1.05,
  }));
  // 橡木地板的暖反射
  s.add(envPanel(THREE, own, {
    w: 14, h: 0.05, d: 20, pos: [0, -2.95, 0], color: '#D9C7A8', intensity: 0.55,
  }));
  return s;
}

/** alley：上方一條窄天空帶，兩側灰水泥（模擬被牆夾住） */
function envAlley(THREE, own) {
  const s = new THREE.Scene();
  s.add(envBox(THREE, own, 3.4, 8, 30, '#9A9DA0', 0.30));      // 兩側水泥的整體底色
  s.add(envPanel(THREE, own, {                                  // 頭頂那條窄天空
    w: 2.2, h: 0.05, d: 28, pos: [0, 3.9, 0], color: '#BCD6F0', intensity: 4.4,
  }));
  s.add(envPanel(THREE, own, {                                  // 被日光打到的一側牆上半部
    w: 0.05, h: 3.2, d: 28, pos: [1.65, 1.9, 0], color: '#C4C0B8', intensity: 1.15,
  }));
  s.add(envPanel(THREE, own, {                                  // 背光側牆（灰、暗但不黑）
    w: 0.05, h: 3.2, d: 28, pos: [-1.65, 1.4, 0], color: '#8E9296', intensity: 0.42,
  }));
  s.add(envPanel(THREE, own, {                                  // 柏油地面的回彈
    w: 3.2, h: 0.05, d: 28, pos: [0, -3.9, 0], color: '#7E7A74', intensity: 0.34,
  }));
  return s;
}

/** tunnel：橘黃色的低亮度環境（隧道燈的總和） + 遠處一個冷色的洞口 */
function envTunnel(THREE, own) {
  const s = new THREE.Scene();
  s.add(envBox(THREE, own, 9, 5.6, 40, '#8C7358', 0.30));       // 髒磁磚的整體橘褐
  s.add(envPanel(THREE, own, {                                  // 拱頂的一排橘黃燈（連續化）
    w: 2.4, h: 0.05, d: 34, pos: [0, 2.55, 0], color: '#FFB760', intensity: 3.1,
  }));
  s.add(envPanel(THREE, own, {                                  // 兩側壁面被燈打亮的帶
    w: 0.05, h: 1.5, d: 34, pos: [4.3, 1.3, 0], color: '#E8B683', intensity: 0.85,
  }));
  s.add(envPanel(THREE, own, {
    w: 0.05, h: 1.5, d: 34, pos: [-4.3, 1.3, 0], color: '#E8B683', intensity: 0.85,
  }));
  s.add(envPanel(THREE, own, {                                  // 路面回彈
    w: 8, h: 0.05, d: 34, pos: [0, -2.7, 0], color: '#8A7E72', intensity: 0.36,
  }));
  s.add(envPanel(THREE, own, {                                  // ★ 遠處的洞口日光（冷 5500K）
    w: 7, h: 4.4, d: 0.05, pos: [0, 0.2, -19.6], color: '#DDEAF8', intensity: 7.5,
  }));
  return s;
}

/** court：室內，上方一個亮方塊（天窗），四周偏暗的藍灰（但仍是明亮的灰藍，不做成黑） */
function envCourt(THREE, own) {
  const s = new THREE.Scene();
  s.add(envBox(THREE, own, 14, 7, 16, '#C8D0DC', 0.34));        // ★ 陰影區的灰藍 #C8D0DC
  s.add(envPanel(THREE, own, {                                  // 3×3 m 天窗
    w: 3, h: 0.05, d: 3, pos: [0, 3.35, 0], color: '#FFFFFF', intensity: 9.0,
  }));
  s.add(envPanel(THREE, own, {                                  // 天窗周圍被漏光染亮的天花
    w: 7, h: 0.05, d: 7, pos: [0, 3.3, 0], color: '#E7EDF6', intensity: 0.9,
  }));
  s.add(envPanel(THREE, own, {                                  // 石材地面的回彈（略暖）
    w: 12, h: 0.05, d: 14, pos: [0, -3.4, 0], color: '#B9B4AC', intensity: 0.40,
  }));
  return s;
}
