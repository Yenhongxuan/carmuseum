# 第 1 階段（抓圖）成果彙整

## 結論：**全數未執行 —— 外網被沙盒白名單阻擋**

### 連線測試（2026-08-25，執行於 Claude Code 網頁版雲端沙盒）

```
$ curl -sI --max-time 8 https://www.toyota.com.tw | head -3
HTTP/1.1 403 Forbidden
Content-Type: text/plain; charset=utf-8
X-Content-Type-Options: nosniff

$ curl -sI --max-time 8 https://www.honda-taiwan.com.tw | head -3
HTTP/1.1 403 Forbidden
Content-Type: text/plain; charset=utf-8
X-Content-Type-Options: nosniff

$ curl -s "$HTTPS_PROXY/__agentproxy/status"
"recentRelayFailures": [
  { "kind": "connect_rejected",
    "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
    "host": "www.toyota.com.tw:443" },
  { "kind": "connect_rejected",
    "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
    "host": "www.honda-taiwan.com.tw:443" }
]
```

**是代理伺服器的政策拒絕（policy denial），不是 TLS 或設定問題。**
沙盒的 `noProxy` 白名單只放行套件註冊表（npmjs / pypi / crates / goproxy）與 Anthropic API，
任何車廠官網、CDN、圖庫都連不上。12 個子代理平行去試也會是同樣的 403。

### 依使用者規則的處置

> 「若被擋（403 / timeout / DNS 失敗）→ 立刻回報，並直接跳到第 2 階段，
> 39 台車全部用『依真實尺寸程序生成的示意模型』。」

**已回報並經使用者確認，直接進入第 2 階段。**

## 12 個車系的實際狀態

| 子代理 | 車系 | 資料夾 | 方法 | 影格數 | 失敗原因 |
|---|---|---|---|---|---|
| A1 | Toyota Yaris Cross | `assets/cars/yaris-cross/` | FAILED | 0 | 沙盒代理 403 policy denial |
| A2 | Toyota Corolla Cross | `assets/cars/corolla-cross/` | FAILED | 0 | 同上 |
| A3 | Honda HR-V | `assets/cars/hrv/` | FAILED | 0 | 同上 |
| A4 | Nissan Kicks | `assets/cars/kicks/` | FAILED | 0 | 同上 |
| A5 | Mazda CX-30 | `assets/cars/cx30/` | FAILED | 0 | 同上 |
| A6 | Kia Stonic | `assets/cars/stonic/` | FAILED | 0 | 同上 |
| A7 | Hyundai Venue | `assets/cars/venue/` | FAILED | 0 | 同上 |
| A8 | Hyundai Mufasa | `assets/cars/mufasa/` | FAILED | 0 | 同上 |
| A9 | Mitsubishi XForce | `assets/cars/xforce/` | FAILED | 0 | 同上 |
| A10 | MG ZS | `assets/cars/mgzs/` | FAILED | 0 | 同上 |
| A11 | Volkswagen T-Cross | `assets/cars/tcross/` | FAILED | 0 | 同上 |
| A12 | Suzuki SX4 S-Cross | `assets/cars/sx4/` | FAILED | 0 | 同上 |

**有 360 序列的車系：0 個。有多角度圖的車系：0 個。**

## 對後續的影響（誠實揭露）

- **39 台車全部使用第三層**：「依原廠公布尺寸程序生成之示意模型，非原廠 CAD 資料」。
  每台車的資訊面板都會標示這一行，`VERIFY.md` 會列出 39 台的完整清單。
- **絕對沒有**用別台車的圖冒充、沒有用其他車系的圖填補、沒有宣稱程序生成的模型是實車照片。
- `Spin360` 檢視器（第一層）與角度切換器（第二層）**程式碼仍完整實作**，
  日後若在可連外的環境補上 `assets/cars/{車系}/360/frame_*.jpg`，
  `carModels.getTier()` 會自動升級該車系到 tier 1／tier 2，無需改動其他程式。
