/**
 * lighting.js — B3 六個場景的光照（第 2 階段子代理產出）
 *
 * 假設（全部列出。每個 rig 都把用到的尺寸放在 rig.layout 上供對照；若 B1 的實際尺寸不同，
 * 可用各 rig 自帶的調整方法微調：VOID 的 setShadowExtent()、CIRCUIT 的 followShadow()、
 * FIVE_YEARS 的 setMouthZ()/setExitZ()、COURT 的 setShaftPosition()）：
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

/* ────────────────────────────── LightRig 基底 ────────────────────────────── */

/**
 * 建立一個空的 rig 骨架。所有 rig 共用同一組介面，第 3 階段可以用同一套程式驗證六個廳。
 * 共同的 debug 圖層名稱（每個 rig 都有，缺席的層 toggle 會回 false）：
 *   'sky'     主光（天光／太陽／隧道口日光／法庭光柱）
 *   'track'   場景內的局部燈具（軌道燈／巷內補光／隧道燈…）
 *   'ambient' 環境反射（HemisphereLight + AmbientLight + 反彈燈）
 */
function makeRigBase(ctx, o) {
  const THREE = ctx.THREE;
  const group = new THREE.Group();
  group.name = 'lightRig:' + o.roomKey;

  const own = { geo: [], mat: [], tex: [] };   // 本 rig 自己建立、必須自己 dispose 的資源
  const layers = new Map();

  const rig = {
    roomKey: o.roomKey,
    group,
    exposure: o.exposure,
    envKind: o.envKind,
    colorTempK: o.colorTempK,     // ★ 主光色溫，供第 3 階段驗證場景間差異
    fillTempK: o.fillTempK,       // 補光／反射光的色溫（真正拉開場景差異的那一半）
    lights: [],
    notes: [],
    layout: o.layout || {},
    _own: own,
    _layers: layers,
    _extra: [],                   // 額外的 dispose 回呼

    /** 註冊到 debug 圖層 */
    _reg(name, obj) {
      if (!layers.has(name)) layers.set(name, []);
      layers.get(name).push(obj);
      return obj;
    },
    /** 加一盞燈：掛進 group、記錄、註冊圖層 */
    _add(layer, light, target) {
      group.add(light);
      if (target) { group.add(target); light.target = target; }
      rig.lights.push(light);
      rig._reg(layer, light);
      return light;
    },
    debugLayers() { return [...layers.keys()]; },
    /** ★ rig.debugToggle('sky'|'track'|'ambient', on) —— 關掉某一層來驗證「缺一層就假」 */
    debugToggle(name, on) {
      const arr = layers.get(name);
      if (!arr) return false;
      for (const obj of arr) obj.visible = !!on;
      return true;
    },
    /** 統計目前有幾盞燈在投影（效能自檢用） */
    shadowCasterCount() { return rig.lights.filter((l) => l.castShadow && l.visible).length; },

    /**
     * ★ 輕量 AO 替代：回傳一個可以直接放在物件底下的漸層落地陰影平面。
     * three 沒有內建 SSAO（在 postprocessing，不屬本檔），牆角／踢腳板上緣／畫框內緣的
     * 暗角請 B1/B2 用 aoMap 處理；物件與地面之間的接觸陰影用這個。
     * @param {number|[number,number]} size 邊長（公尺），可給 [w,d]
     * @param {number} opacity 0–1
     */
    makeContactShadow(size = 3, opacity = 0.45) {
      const w = Array.isArray(size) ? size[0] : size;
      const d = Array.isArray(size) ? size[1] : size;
      const geo = new THREE.PlaneGeometry(w, d, 1, 1);
      own.geo.push(geo);
      const base = ctx.materials.get('car.shadow');
      const mat = base.clone();                 // ★ 每個實例要獨立的 opacity，故 clone
      own.mat.push(mat);
      mat.transparent = true;
      mat.opacity = clamp(opacity, 0, 1);
      mat.depthWrite = false;
      if ('polygonOffset' in mat) { mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2; }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.004;                  // 離地 4 mm，避免 z-fighting
      mesh.renderOrder = 2;
      mesh.receiveShadow = false;
      mesh.castShadow = false;
      mesh.name = 'contactShadow';
      return mesh;
    },

    update(/* dt, elapsed */) {},

    dispose() {
      for (const fn of rig._extra) { try { fn(); } catch (e) { /* noop */ } }
      for (const l of rig.lights) {
        if (l.shadow && l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
        if (l.dispose) l.dispose();
        if (l.parent) l.parent.remove(l);
      }
      group.traverse((n) => { if (n.isMesh && n.geometry && own.geo.indexOf(n.geometry) < 0) own.geo.push(n.geometry); });
      for (const g of own.geo) g.dispose && g.dispose();
      for (const m of own.mat) m.dispose && m.dispose();
      for (const t of own.tex) t.dispose && t.dispose();
      own.geo.length = 0; own.mat.length = 0; own.tex.length = 0;
      rig.lights.length = 0;
      layers.clear();
      if (group.parent) group.parent.remove(group);
      group.clear();
    },
  };
  // 混合色溫（主光 × keyWeight + 補光 × (1−keyWeight)）——
  // 三個白天場景的主光色溫被規格鎖在 5500–6000K，靠這個混合值才看得出彼此的差異。
  const _kw = (o.keyWeight === undefined) ? 0.6 : o.keyWeight;
  Object.defineProperty(rig, 'sceneTempK', {
    enumerable: true,
    get() { return Math.round(rig.colorTempK * _kw + rig.fillTempK * (1 - _kw)); },
  });
  return rig;
}

/** 小工具：建立一個 light target 物件並放到指定位置 */
function targetAt(THREE, x, y, z) {
  const t = new THREE.Object3D();
  t.position.set(x, y, z);
  return t;
}

/* ══════════════════ 廳一 美術館 ROOMS.GALLERY ══════════════════
 * 三層光，缺一層就假：
 *   1 天光   高側窗斜射、6000K 冷、★ 在地板投下明確的窗形光斑（SpotLight + 窗格 cookie）
 *   2 軌道燈 每幅畫上方一盞、3000K 暖、橢圓光斑略大於畫，★ 軌道與燈具本體有建模
 *   3 環境反射 地板反射打上牆的下半部、牆面反射讓陰影不會全黑
 * 驗證：debugToggle('sky', false) → 畫仍被軌道燈照亮
 *       debugToggle('track', false) → 空間仍明亮
 * ════════════════════════════════════════════════════════════ */
function buildGalleryRig(ctx) {
  const THREE = ctx.THREE;
  const layout = {
    halfX: 8.0, halfZ: 11.0, ceiling: 5.6,
    pictureX: 7.9, pictureY: 1.55,
    picZ: [-7.2, -3.6, 0, 3.6, 7.2],     // 每側 5 幅
    railX: 6.6, railY: 5.35,
  };
  const rig = makeRigBase(ctx, {
    roomKey: ROOMS.GALLERY, envKind: 'gallery',
    exposure: 1.10, colorTempK: 6000, fillTempK: 3000, keyWeight: 0.55,
    layout,
  });
  const own = rig._own;

  /* ── 第 1 層：天光（高側窗）───────────────────────────────────
   * candela 推算：SpotLight decay = 2，地板照度 ≈ intensity / d²。
   * 燈心在 (7.4, 5.0, 1.5)、地板落點約 (−1.5, 0, 1.5) → d ≈ 10.2 m。
   * 目標照度 ≈ 12 → intensity ≈ 12 × 104 ≈ 1250。
   * （規格表的 80–400 是離地 4–5 m 的軌道燈；平方反比下不同距離必須換算。）
   */
  const winTex = makeWindowCookie(THREE, 3, 2);
  if (winTex) own.tex.push(winTex);
  const skySpot = new THREE.SpotLight(0xffffff, 1250, 0, 0.46, 0.30, 2);
  applyKelvin(THREE, skySpot.color, 6000);
  skySpot.position.set(7.4, 5.0, 1.5);
  if (winTex) skySpot.map = winTex;
  setupShadow(THREE, skySpot, { mapSize: 2048, near: 1.0, far: 26 });
  skySpot.name = 'gallery.skylight';
  rig._add('sky', skySpot, targetAt(THREE, -2.0, 0, 1.5));

  // 第二道窗（另一段牆），不投影，讓地板上有兩塊窗斑
  const skySpot2 = new THREE.SpotLight(0xffffff, 900, 0, 0.42, 0.34, 2);
  applyKelvin(THREE, skySpot2.color, 5900);
  skySpot2.position.set(7.4, 5.0, -6.5);
  if (winTex) skySpot2.map = winTex;
  skySpot2.castShadow = false;
  skySpot2.name = 'gallery.skylight2';
  rig._add('sky', skySpot2, targetAt(THREE, -2.0, 0, -6.5));

  // 天光的方向性補充（無衰減，讓整個空間有一致的主光方向）
  const skyDir = new THREE.DirectionalLight(0xffffff, 0.85);
  applyKelvin(THREE, skyDir.color, 6000);
  skyDir.position.set(9, 7.5, 3);
  skyDir.castShadow = false;                 // 投影燈已用滿（1 天光 + 2 軌道燈）
  skyDir.name = 'gallery.skyDirectional';
  rig._add('sky', skyDir, targetAt(THREE, -2, 0, 0));

  /* ── 第 2 層：軌道燈（軌道與燈具本體要建模）──────────────────
   * 材質一律 ctx.materials.get('track.*')，本檔不 new 任何表面材質。
   */
  const railMat = ctx.materials.get('track.rail');
  const headMat = ctx.materials.get('track.head');
  const reflMat = ctx.materials.get('track.reflector');

  const railGeo = new THREE.BoxGeometry(0.05, 0.062, layout.halfZ * 2 - 2.0);
  const stemGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.16, 8);
  const yokeGeo = new THREE.BoxGeometry(0.062, 0.05, 0.05);
  const bodyGeo = new THREE.CylinderGeometry(0.052, 0.062, 0.20, 18, 1, false);
  const reflGeo = new THREE.CylinderGeometry(0.070, 0.050, 0.055, 18, 1, true);
  own.geo.push(railGeo, stemGeo, yokeGeo, bodyGeo, reflGeo);

  const trackFixtures = new THREE.Group();
  trackFixtures.name = 'gallery.trackFixtures';
  rig.group.add(trackFixtures);
  rig._reg('trackFixtures', trackFixtures);

  let spotIndex = 0;
  for (const side of [1, -1]) {
    const rail = new THREE.Mesh(railGeo, railMat);
    rail.position.set(side * layout.railX, layout.railY, 0);
    rail.castShadow = false; rail.receiveShadow = false;
    trackFixtures.add(rail);

    for (const pz of layout.picZ) {
      const px = side * layout.pictureX;
      const from = new THREE.Vector3(side * layout.railX, layout.railY - 0.30, pz);
      const to = new THREE.Vector3(px * 0.985, layout.pictureY, pz);
      const dist = from.distanceTo(to);          // ≈ 3.97 m

      // ─ 燈具本體 ─
      const fix = new THREE.Group();
      fix.position.copy(from);
      const stem = new THREE.Mesh(stemGeo, railMat);
      stem.position.y = 0.22;
      fix.add(stem);
      const yoke = new THREE.Mesh(yokeGeo, headMat);
      yoke.position.y = 0.13;
      fix.add(yoke);
      const body = new THREE.Mesh(bodyGeo, headMat);
      fix.add(body);
      const refl = new THREE.Mesh(reflGeo, reflMat);
      refl.position.y = -0.125;
      fix.add(refl);
      // 讓圓筒燈頭真的指向畫（-Y 是燈口方向）
      const dir = to.clone().sub(from).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      fix.quaternion.copy(q);
      fix.castShadow = false;
      trackFixtures.add(fix);

      // ─ 光源 ─
      // 目標照度 ≈ 14；d ≈ 3.97 → intensity ≈ 14 × 15.8 ≈ 220（落在規格 80–400 內）
      // 光斑半徑目標 0.78 m（略大於畫）→ angle = atan(0.78 / 3.97) ≈ 0.194
      // 因為是斜射到牆面，圓錐截在牆上自然就是橢圓 → 規格要的「橢圓光斑」由入射角產生
      const sp = new THREE.SpotLight(0xffffff, 220, 0, 0.205, 0.42, 2);
      applyKelvin(THREE, sp.color, 3000);
      sp.position.copy(from);
      sp.name = 'gallery.track.' + (side > 0 ? 'A' : 'B') + layout.picZ.indexOf(pz);
      // ★ 只讓每側中間那盞投影 → 全場 castShadow 共 3 盞（1 天光 + 2 軌道燈）
      if (pz === 0) {
        setupShadow(THREE, sp, { mapSize: 2048, near: 0.5, far: 12 });
      } else {
        sp.castShadow = false;
      }
      rig._add('track', sp, targetAt(THREE, to.x, to.y, to.z));
      spotIndex++;
    }
  }

  /* ── 第 3 層：環境反射光 ──────────────────────────────────── */
  const hemi = new THREE.HemisphereLight(0xF2F5FA, 0xD8C9AC, 0.55);   // 天空白 / 橡木地板暖
  hemi.position.set(0, 4, 0);
  hemi.name = 'gallery.hemi';
  rig._add('ambient', hemi);

  const amb = new THREE.AmbientLight(0xC9D2DC, 0.18);                  // 讓陰影不會全黑
  amb.name = 'gallery.ambient';
  rig._add('ambient', amb);

  // 地板反射打在牆的下半部：兩盞貼地的低強度點光（暖橡木色）
  for (const bz of [-5.5, 5.5]) {
    const bounce = new THREE.PointLight(0xE4D2B4, 46, 0, 2);
    bounce.position.set(0, 0.38, bz);
    bounce.castShadow = false;
    bounce.name = 'gallery.floorBounce' + bz;
    rig._add('ambient', bounce);
  }

  rig.notes.push(
    '接觸陰影：請 B1 把畫框離牆 0.03–0.04 m（框背面加墊塊），軌道燈的入射角約 71° ' +
    '會在框的下緣與側緣打出 1–2 px 的極深細影 —— 這是「掛在牆上」而非「貼上去」的唯一證明。',
    'AO：牆角／踢腳板上緣／畫框內緣／天花板凹槽請 B2 以 aoMap 處理（three 無內建 SSAO）；' +
    '物件與地面的接觸請用 rig.makeContactShadow(size, opacity)。',
    '驗證：debugToggle("sky", false) 後畫仍被 10 盞軌道燈照亮；debugToggle("track", false) 後' +
    '天光 + 環境層仍讓空間明亮。'
  );

  /** 高側窗的日照角度（t01: 0 = 早晨低角度暖一點，1 = 午後高角度冷一點） */
  rig.setTimeOfDay = function (t01) {
    const t = clamp(t01, 0, 1);
    const k = 5500 + t * 700;                      // 5500K → 6200K
    const el = 0.55 + t * 0.55;                    // 仰角
    const r = 10.5;
    for (const sp of [skySpot, skySpot2]) {
      applyKelvin(THREE, sp.color, k);
      sp.position.x = Math.cos(el) * r;
      sp.position.y = 1.2 + Math.sin(el) * r * 0.52;
    }
    applyKelvin(THREE, skyDir.color, k);
    skyDir.intensity = 0.65 + t * 0.35;
    rig.colorTempK = Math.round(k);
  };

  return rig;
}

/* ══════════════════ 廳二 窄巷 ROOMS.PARKING ══════════════════
 * 主光：上方斜射日光 5500K，被兩側牆遮擋 → 巷底較暗
 * 補光：牆面反射（水泥 → 偏灰）
 * ★ 牆的陰影邊界落在地面上 —— 這是「有牆」的證明（需 B1 的牆 castShadow = true）
 * ★ 巷子深處的環境光比入口低 40%：沿巷深放 3 盞遞減補光，另附建議的 fog
 * ════════════════════════════════════════════════════════════ */
function buildAlleyRig(ctx) {
  const THREE = ctx.THREE;
  const layout = { halfX: 1.6, wallH: 7.0, entranceZ: 0, deepZ: -24 };
  const rig = makeRigBase(ctx, {
    roomKey: ROOMS.PARKING, envKind: 'alley',
    exposure: 1.00, colorTempK: 5500, fillTempK: 7200, keyWeight: 0.6,
    layout,
  });

  /* 主光：從 +X 高處斜射進來。仰角約 52°、方位偏向入口那一側，
     所以只有靠入口的一段地面吃得到直射光，越深越暗。 */
  const sun = new THREE.DirectionalLight(0xffffff, 2.8);
  applyKelvin(THREE, sun.color, 5500);
  sun.position.set(11.0, 14.0, 7.0);
  setupShadow(THREE, sun, { mapSize: 2048, extent: 16, near: 1.0, far: 60 });
  sun.name = 'alley.sun';
  rig._add('sky', sun, targetAt(THREE, 0, 0, -6.0));

  /* 天空補光：窄天空帶是冷藍，地面是水泥灰 */
  const hemi = new THREE.HemisphereLight(0xBFD4EA, 0x9C968C, 0.45);
  hemi.position.set(0, 4, -8);
  hemi.name = 'alley.hemi';
  rig._add('ambient', hemi);

  const amb = new THREE.AmbientLight(0xC6CDD6, 0.16);
  amb.name = 'alley.ambient';
  rig._add('ambient', amb);

  /* ★ 明暗梯度：沿巷深 3 盞遞減的水泥反射補光（點光、decay 2、無投影）
     入口 90 cd → 中段 54 cd → 巷底 32 cd（每段 −40%），
     加上平方反比，巷底的環境亮度明顯低於入口 40% 以上。 */
  const bounceSpec = [
    { z: -3.0,  i: 90, k: 6800 },
    { z: -11.0, i: 54, k: 6400 },
    { z: -19.0, i: 32, k: 6100 },
  ];
  const bounces = [];
  for (const b of bounceSpec) {
    const p = new THREE.PointLight(0xffffff, b.i, 0, 2);
    applyKelvin(THREE, p.color, b.k);
    p.position.set(0.55, 2.3, b.z);
    p.castShadow = false;
    p.name = 'alley.wallBounce' + b.z;
    rig._add('track', p);
    bounces.push(p);
  }

  /* 背光側牆的微弱回彈，讓陰影側不是死灰 */
  const back = new THREE.PointLight(0xB9BEC4, 26, 0, 2);
  back.position.set(-1.0, 1.6, -7.5);
  back.castShadow = false;
  back.name = 'alley.backWallBounce';
  rig._add('ambient', back);

  /* fog 是 scene 層級的東西，不由本檔擅自指派（scene 由 main.js 擁有）。
     這裡只提供建議值與一組 apply/remove，由展廳自行決定要不要用。 */
  rig.suggestedFog = { color: 0xD2D7DD, near: 6, far: 34 };
  let _prevFog = null, _fog = null;
  rig.applyFog = function (scene) {
    if (!scene) return null;
    _prevFog = scene.fog;
    _fog = new THREE.Fog(rig.suggestedFog.color, rig.suggestedFog.near, rig.suggestedFog.far);
    scene.fog = _fog;
    rig._extra.push(() => { if (scene.fog === _fog) scene.fog = _prevFog; });
    return _fog;
  };
  rig.removeFog = function (scene) {
    if (scene && scene.fog === _fog) scene.fog = _prevFog;
    _fog = null;
  };

  rig.notes.push(
    '★ 地面上的「牆的陰影邊界」需要 B1 的巷牆 mesh 設 castShadow = true、地面設 receiveShadow = true，' +
    '否則只會看到均勻日光。主光方位角刻意偏向入口，陰影邊界會斜切過巷道地面。',
    '巷底比入口暗：三盞補光 90 / 54 / 32 cd 遞減，再加 rig.applyFog(scene) 的灰霧（可選）。'
  );

  rig.setTimeOfDay = function (t01) {
    const t = clamp(t01, 0, 1);
    const az = -0.35 + t * 0.9;
    const el = 0.72 + Math.sin(t * Math.PI) * 0.35;
    const r = 18;
    sun.position.set(Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(az) * Math.cos(el) * r);
    sun.intensity = 2.2 + Math.sin(t * Math.PI) * 0.9;
  };

  return rig;
}

/* ══════════════════ 廳三 空無停車場 ROOMS.VOID ══════════════════
 * 太陽 5700K 固定角度（規格：不需隨滑桿變），投下所有物件的長影子
 * 天光 HemisphereLight：天空色 #9FC5E8 / 地面反射色 #8A8578（規格指定色）
 * ★ 瀝青地面把暖灰打回車底 —— 車才不會像貼在地上
 * ★ 1,825 個日格的灰丘要有自陰影 → 陰影相機涵蓋 ±18 m（> 12×12 m 日格區）
 * ══════════════════════════════════════════════════════════════ */
function buildVoidRig(ctx) {
  const THREE = ctx.THREE;
  const layout = { cellField: 12, shadowExtent: 18 };
  const rig = makeRigBase(ctx, {
    roomKey: ROOMS.VOID, envKind: 'lot',
    exposure: 0.90, colorTempK: 5700, fillTempK: 6900, keyWeight: 0.65,
    layout,
  });

  /* 太陽：仰角約 27°（低到足以拉出長影子，高到還照得進灰丘之間的縫）。
     固定角度，不提供 setTimeOfDay（規格明說不需隨滑桿變）。 */
  const sun = new THREE.DirectionalLight(0xffffff, 3.0);
  applyKelvin(THREE, sun.color, 5700);
  sun.position.set(-15.0, 8.6, 10.5);          // 仰角 = atan(8.6 / 18.3) ≈ 25.2°
  // ★ 陰影相機必須涵蓋 12×12 m 的日格區；±18 m / 2048 → 1.76 cm 一個 texel
  setupShadow(THREE, sun, { mapSize: 2048, extent: layout.shadowExtent, near: 1.0, far: 80 });
  sun.name = 'void.sun';
  rig._add('sky', sun, targetAt(THREE, 0, 0, 0));

  /* 天光：規格指定的兩個顏色 */
  const hemi = new THREE.HemisphereLight(0x9FC5E8, 0x8A8578, 0.75);
  hemi.position.set(0, 10, 0);
  hemi.name = 'void.hemi';
  rig._add('ambient', hemi);

  const amb = new THREE.AmbientLight(0xBFCBD8, 0.12);
  amb.name = 'void.ambient';
  rig._add('ambient', amb);

  /* ★ 地面回彈：一盞從「地底下」往上打的方向光（無衰減、無投影），
     顏色用規格的地面反射色 #8A8578 —— 這就是打回車底的暖灰。 */
  const bounce = new THREE.DirectionalLight(0x8A8578, 0.42);
  bounce.position.set(6.0, -7.0, -4.0);
  bounce.castShadow = false;
  bounce.name = 'void.groundBounce';
  rig._add('track', bounce, targetAt(THREE, 0, 0.5, 0));

  /* 灰丘的側向補光：一盞與太陽反向的極弱方向光，讓自陰影裡還看得出堆積物的形狀 */
  const rim = new THREE.DirectionalLight(0xD6E2F0, 0.28);
  rim.position.set(14.0, 5.0, -11.0);
  rim.castShadow = false;
  rim.name = 'void.skyRim';
  rig._add('track', rim, targetAt(THREE, 0, 0.4, 0));

  rig.notes.push(
    '太陽角度固定（仰角 ≈ 25°、方位在 −X/+Z），刻意不提供 setTimeOfDay —— 規格明訂不隨滑桿變。',
    '★ 日格灰丘的自陰影：請 B6 讓每個 daycell instance 同時 castShadow 與 receiveShadow；' +
    '陰影相機為 ±18 m，涵蓋 12×12 m 的日格區還有餘裕。',
    '車底不貼地：void.groundBounce（#8A8578, 0.42）由下往上打，配合 IBL 的 lot 環境（地平線下暖灰）。'
  );

  /** 若第 3 階段需要把陰影相機收緊到某個區域，可呼叫這個（例如只看日格區） */
  rig.setShadowExtent = function (e) {
    const cam = sun.shadow.camera;
    cam.left = -e; cam.right = e; cam.top = e; cam.bottom = -e;
    cam.updateProjectionMatrix();
    layout.shadowExtent = e;
  };

  return rig;
}

/* ══════════════════ 廳四 五年隧道 ROOMS.FIVE_YEARS ══════════════════
 * ★ 隧道燈每 10 m 一盞、橘黃 2900K，壁面與地面各有明確的橢圓光斑，光斑之間有明顯暗區
 * ★ 只用 8 盞 SpotLight 循環復用（不是真的 new 幾百盞），由 rig.setTravel(m) 沿 Z 搬移
 * ★ 隧道口的冷日光（5500K）與隧道內的橘黃燈形成強烈對比
 * 效能：隧道燈一律不投影，光斑靠 cookie 貼圖；全場只有隧道口那盞投影
 * ══════════════════════════════════════════════════════════════════ */
function buildTunnelRig(ctx) {
  const THREE = ctx.THREE;
  const LAMP_COUNT = 8;
  const SPACING = 10;          // 每 8–12 m 一盞 → 取 10
  const BEHIND = 20;           // 觀察者後方保留 20 m 的燈
  const layout = {
    halfX: 4.0, ceiling: 5.2, lampY: 4.70, lampX: 3.20,
    lampCount: LAMP_COUNT, spacing: SPACING, behind: BEHIND,
    mouthZ: 8, exitZ: -320,
  };
  const rig = makeRigBase(ctx, {
    roomKey: ROOMS.FIVE_YEARS, envKind: 'tunnel',
    exposure: 1.15, colorTempK: 2850, fillTempK: 5500, keyWeight: 0.7,
    layout,
  });
  const own = rig._own;

  const cookie = makeEllipseCookie(THREE, 1.45);
  if (cookie) own.tex.push(cookie);

  const headMat = ctx.materials.get('track.head');
  const reflMat = ctx.materials.get('track.reflector');
  const housGeo = new THREE.BoxGeometry(0.62, 0.16, 0.30);
  const lensGeo = new THREE.BoxGeometry(0.52, 0.03, 0.22);
  const armGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
  own.geo.push(housGeo, lensGeo, armGeo);

  /* ── 8 盞循環復用的隧道燈 ──
   * candela：燈心離地 4.7 m，目標照度 ≈ 14 → I ≈ 14 × 4.7² ≈ 310。
   * angle 0.52 → 地面光斑半徑 ≈ 4.7 × tan(0.52) ≈ 2.8 m（直徑 5.6 m），
   * 間距 10 m → 中間留下 4.4 m 的暗區，這個「明暗交替」就是隧道的識別。
   */
  const lamps = [];
  for (let i = 0; i < LAMP_COUNT; i++) {
    const holder = new THREE.Group();
    holder.name = 'tunnel.lamp' + i;
    rig.group.add(holder);

    const arm = new THREE.Mesh(armGeo, headMat);
    arm.position.set(0, 0.14, 0);
    holder.add(arm);
    const hous = new THREE.Mesh(housGeo, headMat);
    holder.add(hous);
    const lens = new THREE.Mesh(lensGeo, reflMat);
    lens.position.y = -0.085;
    holder.add(lens);

    const sp = new THREE.SpotLight(0xffffff, 310, 22, 0.52, 0.55, 2);
    applyKelvin(THREE, sp.color, 2850);
    if (cookie) sp.map = cookie;
    sp.castShadow = false;                     // ★ 隧道燈一律不投影（太貴）
    sp.name = 'tunnel.spot' + i;
    const tgt = targetAt(THREE, 0, 0, 0);
    rig.group.add(tgt);
    sp.target = tgt;
    rig.group.add(sp);
    rig.lights.push(sp);
    rig._reg('track', sp);
    rig._reg('trackFixtures', holder);

    lamps.push({ holder, light: sp, target: tgt, baseIntensity: 310, n: i, side: 1 });
  }

  /* ── 隧道口的日光（冷）──
   * 位在隧道口外面、朝內打。decay = 2 讓它隨深度快速衰減 →
   * 靠洞口冷白、越深越只剩橘黃，強烈對比自然發生。
   */
  const mouth = new THREE.SpotLight(0xffffff, 4200, 90, 0.50, 0.55, 2);
  applyKelvin(THREE, mouth.color, 5500);
  mouth.position.set(0, 5.6, layout.mouthZ + 16);
  setupShadow(THREE, mouth, { mapSize: 2048, near: 2, far: 70 });
  mouth.name = 'tunnel.mouthDaylight';
  rig._add('sky', mouth, targetAt(THREE, 0, 0.6, layout.mouthZ - 14));

  /* 遠處出口的冷光（讓「終點」有方向感）。預設放在很遠處，B6 可用 setExitZ() 調。 */
  const exit = new THREE.SpotLight(0xffffff, 3600, 90, 0.46, 0.6, 2);
  applyKelvin(THREE, exit.color, 5600);
  exit.position.set(0, 4.4, layout.exitZ - 16);
  exit.castShadow = false;
  exit.name = 'tunnel.exitDaylight';
  rig._add('sky', exit, targetAt(THREE, 0, 0.6, layout.exitZ + 14));

  /* 環境層：暖灰的漫射，讓暗區「暗」但不是黑 */
  const hemi = new THREE.HemisphereLight(0xC8B394, 0x8C837A, 0.38);
  hemi.position.set(0, 4, 0);
  hemi.name = 'tunnel.hemi';
  rig._add('ambient', hemi);

  const amb = new THREE.AmbientLight(0xB6A897, 0.12);
  amb.name = 'tunnel.ambient';
  rig._add('ambient', amb);

  /* ── setTravel：燈組沿 Z 循環復用 ──
   * 約定：d = 車輛自世界原點沿 −Z 已行進的公尺數（車輛世界座標 z = −d）。
   * 燈固定長在世界座標 z = −n × SPACING（n 為整數），只是「哪 8 個 n 被實體化」會滾動，
   * 所以視覺上燈是靜止的、車穿過它們 —— 光斑會依序掠過車身。
   */
  rig.setTravel = function (distanceMeters) {
    const d = Number.isFinite(distanceMeters) ? distanceMeters : 0;
    const nStart = Math.ceil((d - BEHIND) / SPACING);
    for (let i = 0; i < LAMP_COUNT; i++) {
      const L = lamps[i];
      const n = nStart + i;
      const z = -n * SPACING;
      const side = (n % 2 === 0) ? 1 : -1;       // 左右交錯，節奏更明顯
      L.n = n; L.side = side;
      L.holder.position.set(side * layout.lampX, layout.lampY, z);
      L.light.position.set(side * layout.lampX, layout.lampY, z);
      // 往下、略往內打 → 圓錐斜切地面自然形成橢圓光斑，壁面也吃到一塊
      L.target.position.set(-side * 0.9, 0, z + side * 0.6);
    }
    rig.travel = d;
    return d;
  };
  rig.travel = 0;
  rig.setTravel(0);

  rig.setMouthZ = function (z) {
    layout.mouthZ = z;
    mouth.position.z = z + 16;
    mouth.target.position.z = z - 14;
  };
  rig.setExitZ = function (z) {
    layout.exitZ = z;
    exit.position.z = z - 16;
    exit.target.position.z = z + 14;
  };

  /* 老舊隧道燈的輕微不穩（只挑兩盞，幅度很小，不做成閃爍特效） */
  rig.update = function (dt, elapsed) {
    const t = elapsed || 0;
    lamps[3].light.intensity = 310 * (1 + 0.035 * Math.sin(t * 7.3) * Math.sin(t * 2.1));
    lamps[6].light.intensity = 310 * (1 + 0.028 * Math.sin(t * 5.1 + 1.7));
  };

  rig.notes.push(
    '★ setTravel(m)：m = 車輛沿 −Z 行進的公尺數；燈在世界座標 z = −n×10 m，只是循環復用 8 盞實體。' +
    '若 B6 讓車停在原點、改用「世界往後流」的做法，請改為每幀 rig.group.position.z = 車的世界 z，' +
    '並仍照實傳入 travel（兩者相消，燈仍會正確掠過車身）。',
    '效能：隧道燈 8 盞全部 castShadow = false，光斑靠 SpotLight.map 的橢圓 cookie；' +
    '全場只有 tunnel.mouthDaylight 一盞投影。',
    '燈具本體（housing / lens）沿用 ctx.materials 的 track.head 與 track.reflector —— ' +
    'B2 的材質表沒有隧道燈具專用名稱，本檔不自行 new 表面材質。因此燈具本身不會自發光，' +
    '「亮」是由真實光源與 IBL 造成的。'
  );

  return rig;
}

/* ══════════════════ 廳五 賽道 ROOMS.CIRCUIT ══════════════════
 * 太陽 5800K、角度較低（午後），投下長影子；天空顏色與主光色溫一致（IBL 的 circuit 環境）
 * ★ 路面反射天空的冷色 → 陰影不會全黑
 * ★ 車輛過彎時車身高光會滑過：靠 IBL（環境穹頂 + 小太陽球的高光點）+ 主光即可
 * ══════════════════════════════════════════════════════════════ */
function buildCircuitRig(ctx) {
  const THREE = ctx.THREE;
  const layout = { shadowExtent: 35, followExtent: 22 };
  const rig = makeRigBase(ctx, {
    roomKey: ROOMS.CIRCUIT, envKind: 'circuit',
    exposure: 0.85, colorTempK: 5800, fillTempK: 7600, keyWeight: 0.65,
    layout,
  });

  /* 主光：仰角約 16°（午後），方位在 −X/+Z → 長影子橫過賽道 */
  const sun = new THREE.DirectionalLight(0xffffff, 3.2);
  applyKelvin(THREE, sun.color, 5800);
  const SUN_OFFSET = new THREE.Vector3(-42, 13, 27);   // 仰角 = atan(13 / 50) ≈ 14.6°
  sun.position.copy(SUN_OFFSET);
  setupShadow(THREE, sun, { mapSize: 2048, extent: layout.shadowExtent, near: 1.0, far: 160 });
  sun.name = 'circuit.sun';
  const sunTarget = targetAt(THREE, 0, 0, 0);
  rig._add('sky', sun, sunTarget);

  /* 天光：路面（暗灰）反射天空的冷色，讓陰影是冷灰而不是黑 */
  const hemi = new THREE.HemisphereLight(0xA8C8E8, 0x7E7B76, 0.72);
  hemi.position.set(0, 20, 0);
  hemi.name = 'circuit.hemi';
  rig._add('ambient', hemi);

  const amb = new THREE.AmbientLight(0xC3D2E2, 0.12);
  amb.name = 'circuit.ambient';
  rig._add('ambient', amb);

  /* 反向的天空補光（無投影）：陰影面仍讀得出車身曲面 */
  const skyFill = new THREE.DirectionalLight(0xD4E4F6, 0.36);
  applyKelvin(THREE, skyFill.color, 7600);
  skyFill.position.set(36, 16, -30);
  skyFill.castShadow = false;
  skyFill.name = 'circuit.skyFill';
  rig._add('track', skyFill, targetAt(THREE, 0, 0.5, 0));

  /* 路面回彈：由下往上的極弱暖灰，讓車底不是死黑 */
  const bounce = new THREE.DirectionalLight(0x8E8B84, 0.30);
  bounce.position.set(-8, -9, 6);
  bounce.castShadow = false;
  bounce.name = 'circuit.roadBounce';
  rig._add('track', bounce, targetAt(THREE, 0, 0.6, 0));

  /**
   * ★ 賽道很長，2048 的陰影圖攤在 ±35 m 上只有 3.4 cm/texel。
   * B7 應每幀呼叫 rig.followShadow(carWorldPos) 把陰影相機跟著車走並收到 ±22 m（2.1 cm/texel）。
   */
  const _tmp = new THREE.Vector3();
  rig.followShadow = function (targetPos, extent) {
    if (!targetPos) return;
    _tmp.set(targetPos.x || 0, targetPos.y || 0, targetPos.z || 0);
    sunTarget.position.copy(_tmp);
    sunTarget.updateMatrixWorld();
    sun.position.copy(_tmp).add(SUN_OFFSET);
    const e = extent !== undefined ? extent : layout.followExtent;
    const cam = sun.shadow.camera;
    if (cam.right !== e) {
      cam.left = -e; cam.right = e; cam.top = e; cam.bottom = -e;
      cam.updateProjectionMatrix();
      layout.shadowExtent = e;
    }
  };

  /** t01: 0 = 清晨（偏冷、東側低角度）, 1 = 午後（略暖、西側低角度） */
  rig.setTimeOfDay = function (t01) {
    const t = clamp(t01, 0, 1);
    const k = 5300 + t * 700;                       // 5300K → 6000K
    applyKelvin(THREE, sun.color, k);
    const az = Math.PI * (0.15 + t * 0.70);
    const el = 0.20 + Math.sin(t * Math.PI) * 0.28; // 兩端低、中午略高，永遠是長影子
    const r = 50;
    SUN_OFFSET.set(Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(az) * Math.cos(el) * r);
    sun.position.copy(sunTarget.position).add(SUN_OFFSET);
    sun.intensity = 2.6 + Math.sin(t * Math.PI) * 0.8;
    rig.colorTempK = Math.round(k);
  };

  rig.notes.push(
    '天空色與主光色溫一致：主光 5800K，circuit 環境穹頂用同一個色溫算出的天頂／地平線色。',
    '★ B7 請每幀呼叫 rig.followShadow(carWorldPos)，否則 ±35 m 的陰影圖會太糊。',
    '未實作：遠處熱空氣扭曲（需要 postprocessing / 自訂 shader pass，渲染管線不屬本檔）。'
  );

  return rig;
}

/* ══════════════════ 廳六 法庭 ROOMS.COURT ══════════════════
 * ★ 一道從上方灑下的柔和光柱，正對被告席（對應天花板 3×3 m 的方形開口）
 * ★ 光柱中有 600 顆懸浮微塵，緩慢飄動，只在光柱範圍內
 * ★ 光柱本體：加法混合的錐體 Mesh（BackSide + depthWrite:false），不使用 bloom
 * 環境光是美術館的 70%，兩側真的暗下來 —— 但「暗」仍是明亮的灰藍 #C8D0DC，不是黑
 * ══════════════════════════════════════════════════════════ */
function buildCourtRig(ctx) {
  const THREE = ctx.THREE;
  const layout = { openingSize: 3.0, openingY: 6.0, shaftTopR: 1.55, shaftBottomR: 2.55, moteCount: 600 };
  const rig = makeRigBase(ctx, {
    roomKey: ROOMS.COURT, envKind: 'court',
    exposure: 1.05, colorTempK: 5200, fillTempK: 6500, keyWeight: 0.62,
    layout,
  });
  const own = rig._own;

  /* ── 主光：天窗光柱 ──
   * 燈心在 y = 11.5，地面落點 y = 0 → d ≈ 11.5 m。
   * 目標照度 ≈ 15 → intensity ≈ 15 × 132 ≈ 1980，取 1900。
   * 方形 cookie 讓地面的亮斑是「方的」—— 對應 3×3 m 的方形開口。
   */
  const sqTex = makeSquareCookie(THREE);
  if (sqTex) own.tex.push(sqTex);
  const shaftLight = new THREE.SpotLight(0xffffff, 1900, 0, 0.215, 0.62, 2);
  applyKelvin(THREE, shaftLight.color, 5200);
  shaftLight.position.set(0, 11.5, 0);
  if (sqTex) shaftLight.map = sqTex;
  setupShadow(THREE, shaftLight, { mapSize: 2048, near: 4.0, far: 20 });
  shaftLight.name = 'court.shaft';
  rig._add('sky', shaftLight, targetAt(THREE, 0, 0, 0));

  /* ── 光柱本體：加法混合的截頭錐 ──
   * BackSide + depthWrite:false + AdditiveBlending，逐頂點做上亮下淡的漸層。
   * 這是「光」不是表面，B2 的材質表沒有對應名稱，由本檔自建並自行 dispose。
   */
  const H = layout.openingY;
  const shaftGeo = new THREE.CylinderGeometry(layout.shaftTopR, layout.shaftBottomR, H, 48, 14, true);
  {
    const pos = shaftGeo.attributes.position;
    const arr = new Float32Array(pos.count * 3);
    const top = new THREE.Color(0xF4F7FC), bot = new THREE.Color(0xDCE4F0);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = clamp((pos.getY(i) + H / 2) / H, 0, 1);      // 0 = 地面, 1 = 開口
      const k = 0.10 + Math.pow(t, 1.55) * 0.82;             // 上濃下淡
      c.copy(bot).lerp(top, t).multiplyScalar(k);
      arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
    }
    shaftGeo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  const shaftMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.085,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
    toneMapped: true,
  });
  own.geo.push(shaftGeo); own.mat.push(shaftMat);
  const shaftMesh = new THREE.Mesh(shaftGeo, shaftMat);
  shaftMesh.position.set(0, H / 2, 0);
  shaftMesh.renderOrder = 8;
  shaftMesh.name = 'court.shaftVolume';
  rig.group.add(shaftMesh);
  rig._reg('shaft', shaftMesh);

  /* ── 懸浮微塵：600 顆 Points，只在光柱範圍內緩慢飄動 ── */
  const N = layout.moteCount;
  const moteGeo = new THREE.BufferGeometry();
  const mpos = new Float32Array(N * 3);
  const mA = new Float32Array(N);      // 基準角度
  const mR = new Float32Array(N);      // 半徑比例 0–1
  const mY = new Float32Array(N);      // 高度
  const mV = new Float32Array(N);      // 垂直速度（可正可負）
  const mS = new Float32Array(N);      // 旋轉角速度
  const mP = new Float32Array(N);      // 擺動相位
  const radiusAt = (y) => layout.shaftBottomR + (layout.shaftTopR - layout.shaftBottomR) * clamp(y / H, 0, 1);
  for (let i = 0; i < N; i++) {
    mA[i] = Math.random() * Math.PI * 2;
    mR[i] = Math.sqrt(Math.random()) * 0.90;
    mY[i] = 0.10 + Math.random() * (H - 0.25);
    mV[i] = (Math.random() - 0.42) * 0.075;
    mS[i] = (Math.random() - 0.5) * 0.09;
    mP[i] = Math.random() * Math.PI * 2;
    const r = mR[i] * radiusAt(mY[i]);
    mpos[i * 3] = Math.cos(mA[i]) * r;
    mpos[i * 3 + 1] = mY[i];
    mpos[i * 3 + 2] = Math.sin(mA[i]) * r;
  }
  moteGeo.setAttribute('position', new THREE.BufferAttribute(mpos, 3));
  const moteTex = makeMoteSprite(THREE);
  if (moteTex) own.tex.push(moteTex);
  const moteMat = new THREE.PointsMaterial({
    color: 0xFFFDF6,
    size: 0.022,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    map: moteTex || null,
    alphaTest: 0.0,
    toneMapped: true,
  });
  own.geo.push(moteGeo); own.mat.push(moteMat);
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.renderOrder = 9;
  motes.frustumCulled = false;
  motes.name = 'court.dustMotes';
  rig.group.add(motes);
  rig._reg('dust', motes);

  /* ── 環境層：美術館的 70%，兩側真的暗下來，但「暗」是明亮的灰藍 ── */
  const hemi = new THREE.HemisphereLight(0xC8D0DC, 0xB4B8BE, 0.385);   // 0.55 × 0.7
  hemi.position.set(0, 5, 0);
  hemi.name = 'court.hemi';
  rig._add('ambient', hemi);

  const amb = new THREE.AmbientLight(0xC8D0DC, 0.126);                 // 0.18 × 0.7
  amb.name = 'court.ambient';
  rig._add('ambient', amb);

  /* 兩側的極弱補光：讓陰影區有形狀，避免變成全黑 */
  for (const sx of [-1, 1]) {
    const side = new THREE.PointLight(0xC8D0DC, 44, 0, 2);
    side.position.set(sx * 4.6, 2.4, -2.2);
    side.castShadow = false;
    side.name = 'court.sideFill' + (sx > 0 ? 'R' : 'L');
    rig._add('track', side);
  }
  // 被告席正面的輪廓補光（很弱，只為了讓車頭有一條可讀的邊）
  const rim = new THREE.PointLight(0xD8DEE8, 34, 0, 2);
  rim.position.set(0, 1.9, 5.2);
  rim.castShadow = false;
  rim.name = 'court.frontRim';
  rig._add('track', rim);

  /* ── 微塵動畫 ── */
  const attr = moteGeo.attributes.position;
  rig.update = function (dt, elapsed) {
    const d = Math.min(dt || 0, 0.1);
    const t = elapsed || 0;
    const a = attr.array;
    for (let i = 0; i < N; i++) {
      let y = mY[i] + mV[i] * d;
      if (y > H - 0.12) { y = 0.08; }
      else if (y < 0.06) { y = H - 0.15; }
      mY[i] = y;
      const ang = mA[i] + mS[i] * t;
      const r = mR[i] * radiusAt(y);
      a[i * 3]     = Math.cos(ang) * r + 0.055 * Math.sin(t * 0.62 + mP[i]);
      a[i * 3 + 1] = y;
      a[i * 3 + 2] = Math.sin(ang) * r + 0.055 * Math.cos(t * 0.47 + mP[i]);
    }
    attr.needsUpdate = true;
    // 光柱呼吸感：極輕微，不做成閃爍
    shaftMat.opacity = 0.085 + 0.008 * Math.sin(t * 0.35);
  };

  /** 光柱與天窗如果不在原點，整組（燈 + 錐體 + 微塵）一起搬 */
  rig.setShaftPosition = function (x, z) {
    shaftLight.position.set(x, 11.5, z);
    shaftLight.target.position.set(x, 0, z);
    shaftMesh.position.set(x, H / 2, z);
    motes.position.set(x, 0, z);
  };

  rig.notes.push(
    '★ 光柱不使用 bloom：只有一個加法混合的截頭錐 + 600 顆微塵，全部 depthWrite = false。',
    '陰影區的最暗值刻意壓在 #C8D0DC 附近（hemi 與 ambient 都用這個顏色），不做成全黑。',
    '光柱錐體材質與微塵 PointsMaterial 由本檔自建（B2 材質表無對應名稱），dispose() 時一併釋放。',
    'debugToggle 額外層：\'shaft\'（光柱錐體）、\'dust\'（微塵）。'
  );

  return rig;
}

/* ════════════════════════════ LightingSystem ════════════════════════════ */

/**
 * @param {object} ctx MODULE_API §4 的 ctx（需要 THREE / renderer / scene / materials）
 * @returns {{makeRig(roomKey:string):object, setEnvironment(kind:string):void, dispose():void}}
 */
export function createLightingSystem(ctx) {
  if (!ctx || !ctx.THREE) throw new Error('lighting: ctx.THREE 是必要的（本模組不在頂層 import three）');
  const THREE = ctx.THREE;

  const rigs = new Map();          // roomKey -> rig
  const envCache = new Map();      // kind -> { texture, rt }
  let pmrem = null;
  let currentEnv = null;
  let disposed = false;

  function getPMREM() {
    if (!ctx.renderer) return null;
    if (!pmrem) {
      pmrem = new THREE.PMREMGenerator(ctx.renderer);
      pmrem.compileEquirectangularShader && pmrem.compileEquirectangularShader();
    }
    return pmrem;
  }

  /** 把一個臨時 envScene 燒成 PMREM 貼圖，並釋放 envScene 內所有自建資源 */
  function bake(envScene, own, sigma) {
    const gen = getPMREM();
    if (!gen) return null;
    let rt = null;
    try {
      rt = gen.fromScene(envScene, sigma);
    } catch (err) {
      console.warn('[lighting] PMREM 產生失敗：', err);
      return null;
    } finally {
      if (own) {
        for (const g of own.geo) g.dispose && g.dispose();
        for (const m of own.mat) m.dispose && m.dispose();
        own.geo.length = 0; own.mat.length = 0;
      }
      envScene.clear && envScene.clear();
    }
    return rt;
  }

  /** 六種 kind 的 envScene 工廠（全部程序生成，不需要任何外部檔案） */
  function buildEnvScene(kind) {
    const own = { geo: [], mat: [], tex: [] };
    let scene = null, sigma = 0.04;
    switch (kind) {
      case 'gallery':
        scene = envGalleryFallback(THREE, own); sigma = 0.05; break;
      case 'alley':
        scene = envAlley(THREE, own); sigma = 0.06; break;
      case 'lot':
        // 戶外：天頂藍 → 地平線淺 → 地面暖灰。車頂反射天空的藍、車底反射地面的暖灰。
        scene = envSkyDome(THREE, own, {
          zenith: '#5B8CC6', horizon: '#DFE8F2', ground: '#8A8578',
          zenithI: 1.15, horizonI: 1.95, groundI: 0.62,
          sunDir: [-0.62, 0.36, 0.44], sunColor: '#FFF4E4', sunI: 15, sunSize: 2.6,
        });
        sigma = 0.02; break;
      case 'circuit':
        // 天空顏色必須與主光 5800K 一致 → 略冷一階的藍
        scene = envSkyDome(THREE, own, {
          zenith: '#4F84C4', horizon: '#D8E4F2', ground: '#7E7B76',
          zenithI: 1.25, horizonI: 1.85, groundI: 0.55,
          sunDir: [-0.80, 0.25, 0.52], sunColor: '#FFF0DC', sunI: 20, sunSize: 2.2,
        });
        sigma = 0.02; break;
      case 'tunnel':
        scene = envTunnel(THREE, own); sigma = 0.06; break;
      case 'court':
        scene = envCourt(THREE, own); sigma = 0.05; break;
      default:
        return null;
    }
    return { scene, own, sigma };
  }

  /** gallery 優先用 three 的 RoomEnvironment；失敗就用自建的白盒（已先同步套上）。 */
  let galleryUpgradeTried = false;
  async function tryUpgradeGalleryEnv() {
    if (galleryUpgradeTried) return;
    galleryUpgradeTried = true;
    const gen = getPMREM();
    if (!gen) return;
    let RoomEnvironment = null;
    try {
      const mod = await import('three/addons/environments/RoomEnvironment.js');
      RoomEnvironment = mod && (mod.RoomEnvironment || mod.default);
    } catch (err) {
      console.warn('[lighting] RoomEnvironment 載入失敗，沿用自建的 gallery 環境：', err && err.message);
      return;
    }
    if (!RoomEnvironment || disposed) return;
    let rt = null;
    const room = new RoomEnvironment();
    try {
      rt = gen.fromScene(room, 0.04);
    } catch (err) {
      console.warn('[lighting] RoomEnvironment 燒 PMREM 失敗，沿用自建環境：', err && err.message);
      return;
    } finally {
      room.traverse && room.traverse((n) => {
        if (n.isMesh) {
          n.geometry && n.geometry.dispose && n.geometry.dispose();
          const mats = Array.isArray(n.material) ? n.material : [n.material];
          for (const m of mats) m && m.dispose && m.dispose();
        }
      });
      room.clear && room.clear();
    }
    if (!rt || disposed) return;
    const old = envCache.get('gallery');
    envCache.set('gallery', { texture: rt.texture, rt, source: 'RoomEnvironment' });
    if (currentEnv === 'gallery' && ctx.scene) ctx.scene.environment = rt.texture;
    if (old && old.rt) old.rt.dispose();
  }

  function ensureEnv(kind) {
    if (envCache.has(kind)) return envCache.get(kind);
    const built = buildEnvScene(kind);
    if (!built) throw new Error('lighting.setEnvironment: 未知的 envKind「' + kind + '」');
    const rt = bake(built.scene, built.own, built.sigma);
    const entry = rt ? { texture: rt.texture, rt, source: 'procedural' }
                     : { texture: null, rt: null, source: 'none' };
    envCache.set(kind, entry);
    return entry;
  }

  const system = {
    ENV_KINDS,
    rigs,

    /** 目前套用的環境種類 */
    get currentEnvironment() { return currentEnv; },

    /**
     * 切換 scene.environment（PMREM）與 scene.environmentIntensity。
     * 同一個 kind 只會生成一次（envCache）。
     */
    setEnvironment(kind) {
      if (disposed) return;
      if (ENV_KINDS.indexOf(kind) < 0) {
        throw new Error('lighting.setEnvironment: kind 必須是 ' + ENV_KINDS.join(' / ') + '，收到「' + kind + '」');
      }
      const entry = ensureEnv(kind);
      currentEnv = kind;
      if (ctx.scene) {
        if (entry.texture) ctx.scene.environment = entry.texture;
        ctx.scene.environmentIntensity = ENV_INTENSITY[kind];
      }
      // gallery 另外非同步嘗試升級成 three 官方的 RoomEnvironment（失敗就維持自建版本）
      if (kind === 'gallery' && entry.source === 'procedural') tryUpgradeGalleryEnv();
    },

    /** 想在轉場前先燒好貼圖可以呼叫這個（可選） */
    async preloadEnvironment(kind) {
      if (ENV_KINDS.indexOf(kind) < 0) return null;
      ensureEnv(kind);
      if (kind === 'gallery') await tryUpgradeGalleryEnv();
      return envCache.get(kind);
    },

    /** 該 kind 的 environmentIntensity（室內 0.8–1.0 / 戶外 1.0–1.3） */
    envIntensityFor(kind) { return ENV_INTENSITY[kind]; },

    /**
     * 取得（必要時先生成）某個 kind 的 PMREM 貼圖，但**不**指派到 scene。
     * MODULE_API §1.4 說 scene.environment 由 main.js 統一設定；若主代理希望自己動手，
     * 就用這個取貼圖 + envIntensityFor() 取強度，不必呼叫 setEnvironment()。
     */
    getEnvironmentTexture(kind) {
      if (ENV_KINDS.indexOf(kind) < 0) return null;
      return ensureEnv(kind).texture;
    },

    /** roomKey → envKind */
    envKindFor(roomKey) { return ROOM_ENV_KIND[roomKey] || null; },

    /**
     * 建立（或取回）某個展廳的燈組。
     * @param {string} roomKey ROOMS.* 常數字串
     */
    makeRig(roomKey) {
      if (rigs.has(roomKey)) return rigs.get(roomKey);
      let rig;
      switch (roomKey) {
        case ROOMS.GALLERY:    rig = buildGalleryRig(ctx); break;   // 'room1_elimination'
        case ROOMS.PARKING:    rig = buildAlleyRig(ctx);   break;   // 'room2_parking'
        case ROOMS.VOID:       rig = buildVoidRig(ctx);    break;   // 'room3_void'
        case ROOMS.FIVE_YEARS: rig = buildTunnelRig(ctx);  break;   // 'room4_fiveyears'
        case ROOMS.CIRCUIT:    rig = buildCircuitRig(ctx); break;   // 'room5_circuit'
        case ROOMS.COURT:      rig = buildCourtRig(ctx);   break;   // 'room6_court'
        default:
          throw new Error(
            'lighting.makeRig: 未知的 roomKey「' + roomKey + '」，必須是 ' +
            Object.values(ROOMS).join(' / ')
          );
      }
      const baseDispose = rig.dispose;
      rig.dispose = function () { rigs.delete(roomKey); baseDispose.call(rig); };
      rigs.set(roomKey, rig);
      return rig;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const rig of [...rigs.values()]) rig.dispose();
      rigs.clear();
      for (const e of envCache.values()) { if (e.rt) e.rt.dispose(); }
      envCache.clear();
      if (ctx.scene && currentEnv) ctx.scene.environment = null;
      currentEnv = null;
      if (pmrem) { pmrem.dispose(); pmrem = null; }
    },
  };

  return system;
}

export default createLightingSystem;
