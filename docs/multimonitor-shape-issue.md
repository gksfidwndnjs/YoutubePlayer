# Electron 투명창: 보조 모니터 vs `setShape` 부드러운 펼침 — 자문 요청

## 한 줄 요약
프레임리스 + 투명 Electron 창에서 **(A) `setShape` 기반의 부드러운 "제자리" 펼침/접힘**과
**(B) 보조 모니터에서의 정상 동작**이 양립하지 않는다. 둘을 모두 달성할 방법, 또는 더 나은
대안 아키텍처에 대한 자문을 구한다.

---

## 1. 앱 개요
- **무엇:** 화면 우하단에 도킹되는 컴팩트 YouTube 음악 플레이어 위젯 (Electron).
- **창 특성:** `frame: false`, `transparent: true`, `resizable: false`, `backgroundColor: '#00000000'`.
- **둥근 모서리 + 접이식 재생목록:** 평소엔 "접힘"(플레이어 바 + 헤더만, 높이 ~130 디자인 px),
  토글하면 "펼침"(아래에 재생목록 큐가 슬라이드되어 나타남, 추가 높이 최대 280 디자인 px).
- **스택:** Electron 35 (Chromium 134), `nodeIntegration: true`, `contextIsolation: false`.

## 2. 환경
- **OS:** Windows 11 + WSL2 (WSLg). Electron은 Windows용 `electron.exe`로 실행됨(WSL 경로에서 구동).
- **모니터:** 듀얼 모니터, **둘 다 DPI scaleFactor = 2.0 (200%)**.
  - 주 모니터: workArea 높이 ≈ 1032 (DIP)
  - 보조 모니터: workArea 960×592 (DIP), 주 모니터 왼쪽에 위치
- 즉 DPI는 동일하고 **논리 해상도(작업영역 크기)만 다름**.

## 3. 목표 (두 가지)
1. **모니터 비율/해상도가 달라도 앱 크기를 일관·자연스럽게 유지** (원래 요구사항).
2. **재생목록 펼침/접힘이 부드러울 것** — 사용자는 "창 자체가 늘었다 줄었다 하는 것"을 싫어함.
   창 크기는 그대로 두고 콘텐츠만 제자리에서 부드럽게 오르내리길 원함.

## 4. 현재 아키텍처

### 4-1. 일관 사이징 (`uiScale` + page zoom) — 이 부분은 잘 동작함
- 메인 프로세스가 대상 디스플레이 **높이** 기준으로 단일 스케일 계산:
  ```js
  const DESIGN_WIDTH = 384;       // 1080p에서 1920/5 와 동일(기존 룩 보존)
  const REFERENCE_HEIGHT = 1080;
  const SCALE_MIN = 0.75, SCALE_MAX = 1.6;
  computeUiScale(display) = clamp(display.workArea.height / REFERENCE_HEIGHT, SCALE_MIN, SCALE_MAX);
  ```
- 콘텐츠 스케일링은 **`webContents.setZoomFactor(uiScale)`** 로 적용.
  - 검증됨: Electron 35의 page zoom은 `getBoundingClientRect`/`window.innerHeight`를 바꾸지 않음
    → 렌더러는 항상 "디자인 px"로 측정·보고하고, 메인이 `* uiScale`로 DIP 창 크기 산출.
  - 창 너비 = `DESIGN_WIDTH * uiScale`, 높이 = (디자인 높이) * uiScale.
- **두 배율이 공존:**
  - `sf` = OS DPI scaleFactor (DIP→물리px). `setShape`가 물리px를 받으므로 필요.
  - `uiScale` = 논리 스케일 (디자인 px→DIP).
  - 규칙: `getBounds()` 값은 이미 uiScale 반영된 DIP라 `sf`만 곱함. 렌더러가 보고한 디자인 px는
    `* uiScale * sf`.

### 4-2. 펼침/접힘 (`setShape` 클리핑) — 문제의 핵심
원래 디자인 의도:
- **창은 항상 "펼침(최대)" 높이로 고정**되어 생성됨 (`maxH = collapsedH + 280`, * uiScale).
- 접힘 상태에선 **`win.setShape(region)`** 로 창의 **아래쪽 보이는 영역만** 남기고 나머지(위쪽
  빈 영역)를 클리핑한다. region은 둥근 사각형(rounded-rect)을 1px 직사각형 배열로 구성한 것.
- 펼칠 때: 렌더러가 `update-shape({visibleHeight: window.innerHeight})`를 보내 **전체 창을
  보이게** 하고, CSS `#queue-list { transition: max-height 0.3s ease }` 로 큐가 슬라이드됨.
- 접을 때: CSS로 큐가 0으로 슬라이드된 뒤 300ms 후 `update-shape({visibleHeight: collapsedH})`로
  다시 아래쪽만 남기고 클리핑.

**`setShape`가 두 가지 역할을 동시에 수행:**
1. 둥근 모서리(투명 영역의 모서리 클리핑).
2. 고정 높이 창에서 **접힘 시 위쪽 빈 영역을 숨기고 클릭 통과(click-through)** 시킴.

**왜 이 방식이 "부드럽다"고 느껴지나:** OS 창 크기(bounds)가 전혀 변하지 않기 때문이다.
펼침/접힘은 순수하게 CSS 콘텐츠 슬라이드(클립된 뷰포트 안에서)로만 보이고, 창 레벨의
아티팩트(작업표시줄 썸네일 변화, 그림자 점프, 투명 빈틈)가 전혀 없다.

핵심 코드(메인 프로세스):
```js
function roundedRectShape(width, height, radius) { /* 1px 직사각형 배열로 둥근 사각형 구성 */ }

function setWinShape(win, w, h) {              // w,h = DIP
  const sf = getWinScaleFactor(win);
  const radius = Math.round(WIN_RADIUS * mainUiScale * sf);
  win.setShape(roundedRectShape(Math.round(w*sf), Math.round(h*sf), radius));
}

ipcMain.on('update-shape', (event, { visibleHeight }) => { // visibleHeight = 디자인 px
  mainWinVisibleHeight = visibleHeight;
  const win = BrowserWindow.fromWebContents(event.sender);
  const { width, height } = win.getBounds();
  const sf = getWinScaleFactor(win);
  const visDip = visibleHeight * mainUiScale;
  const offsetY = Math.round((height - visDip) * sf);
  const radius = Math.round(WIN_RADIUS * mainUiScale * sf);
  win.setShape(
    roundedRectShape(Math.round(width*sf), Math.round(visDip*sf), radius)
      .map(r => ({ ...r, y: r.y + offsetY }))   // 아래쪽 정렬
  );
});
```

## 5. 증상 / 문제
1. **창이 보조 모니터에서 사라짐:** 창을 보조 모니터로 드래그하면 보이지 않게 됨. 주 모니터로
   되돌리면 다시 보임. 즉 보조 모니터에 있는 동안만 렌더(컴포지팅)되지 않음.
2. **드래그 순간이동:** 보조(왼쪽) 모니터로 드래그하여 **마우스 커서가 모니터 경계를 넘는 순간**,
   창이 왼쪽으로 자기 너비만큼 순간이동된 채 잡혀버려 커서를 따라 넘어오지 못함.

## 6. 진단을 위해 시도한 것과 결과 (중요)
- **모든 `setShape` 호출 비활성화(DISABLE_SHAPE)** → **보조 모니터에서 창이 정상적으로 보임.**
  (둥근 모서리/클리핑은 사라지지만 사라짐 버그는 없음.) → **원인은 `setShape`로 확정.**
- **`app.disableHardwareAcceleration()` 추가 + `setShape` 유지** → **여전히 사라짐.** (HW 가속
  비활성화로도 해결 안 됨.)
- 좌표/크기 로깅 결과, 사라질 때도 **창의 bounds는 보조 모니터 작업영역 안에 정상 값**이었음
  (예: `{x:2157, y:211, width:288, height:381}`, 작업영역 `960×592`). 즉 기하 문제가 아니라
  **렌더링/컴포지팅 문제**.
- 줌(`setZoomFactor`)을 이동 시 적용하지 않도록 빼봐도 사라짐은 그대로 → 줌은 원인 아님.
- `transparent` 창을 콘텐츠 크기에 정확히 맞추는 방식(아래 7-B)으로 바꾸면 보조 모니터 정상.

## 7. 검토한 대안과 트레이드오프
### A. 현재(`setShape` 유지)
- 장점: 펼침/접힘이 매우 부드러움(창 크기 불변).
- 단점: 보조 모니터에서 사라짐 + 드래그 순간이동. (이 환경에서 미해결.)

### B. `setShape` 제거 + "콘텐츠 크기에 맞춰 창 리사이즈"
- 창을 항상 콘텐츠 높이에 정확히 맞춤(둥근 모서리는 `#player-area`의 CSS
  `border-radius` + `overflow:hidden`로, 투명창이라 모서리 밖은 자동 투명).
- 펼침/접힘 = 창 높이를 실제로 리사이즈.
- 장점: 보조 모니터 정상, 순간이동 없음, 작업표시줄 썸네일에 빈 영역 안 보임.
- 단점/거부 사유:
  - **즉시 리사이즈** → 펼침이 "뚝딱"거려 사용자가 싫어함.
  - **창 높이 애니메이션(60fps `setBounds`)** → 사용자가 "창이 늘었다 줄었다 하는 느낌"이라며 거부.
    또한 `setBounds`를 매 프레임 호출하는 게 투명창에서 다소 버벅임.
  - "창 크기를 바꾸지 않고 콘텐츠만 제자리에서 펼치는" 부드러움(=A)을 재현 못 함.
- (시도했던 보정) 렌더러가 `resize` 이벤트로 콘텐츠를 실제 창 크기에 맞춰 채워 빈틈/잘림은
  없앴지만, "창이 리사이즈된다"는 본질은 그대로라 거부됨.

### C. 하이브리드 (미구현 아이디어)
- 주 모니터에선 A(`setShape`), 보조 모니터로 가면 B(콘텐츠 크기)로 자동 전환.
- 장점: 일상 사용(주 모니터)에서 부드러움 유지 + 보조 모니터 기능 유지.
- 단점: 복잡, 모니터마다 펼침 동작이 달라짐(일관성↓), 모드 전환 시 글리치 우려.

## 8. 자문 받고 싶은 것 (Codex에게)
1. **Electron(Windows, transparent + frameless)에서 `win.setShape`가 보조 모니터에서
   컴포지팅 안 되는 현상의 알려진 원인/우회책이 있는가?** (`disableHardwareAcceleration`은
   효과 없었음.) 예: 창 재생성, `setBackgroundColor` 토글, `BrowserWindow` 옵션
   (`thickFrame`, `roundedCorners`, `vibrancy`/`backgroundMaterial`), Chromium 플래그,
   monitor change 이벤트에서 setShape 재적용 타이밍 등.
2. **`setShape` 없이** "고정 크기 창 안에서 콘텐츠만 제자리 슬라이드"를 구현하는 다른 방법이
   있는가? (목표 2의 부드러움을 유지하면서.) 예: 항상 펼침 높이 창 + 빈 위쪽을 click-through로
   만드는 신뢰할 방법(`setIgnoreMouseEvents` 영역 지정 한계?), 또는 둥근 모서리/클립을 GPU
   합성과 충돌 없이 처리하는 합성 레이어 기법.
3. **드래그 순간이동**(커서가 모니터 경계 넘을 때 창이 자기 너비만큼 점프)의 원인과 해법.
   `setShape`된 투명창의 멀티모니터 드래그 관련 알려진 버그인가? (현재 우리 `moved` 핸들러는
   300ms 디바운스 후 "다른 디스플레이에 안착했을 때만" 우하단 모서리 고정으로 리사이즈한다 —
   아래 코드 참고. 드래그 중에는 `applyCurrentShape`만 호출.)
4. 위 트레이드오프를 근본적으로 깨는 **더 나은 아키텍처**가 있는가? (예: 창은 항상 콘텐츠 크기로
   두되, 펼침 애니메이션을 창 리사이즈가 아닌 다른 방식으로 "제자리 슬라이드"처럼 보이게 하는 법.)

## 9. 참고 코드 위치
- 메인 프로세스: `src/main.js`
  - 사이징/스케일: `computeUiScale`, `applyUiScale`, `getWinScaleFactor`
  - 셰이프: `setWinShape`, `applyCurrentShape`, `roundedRectShape`,
    IPC `set-exact-height`, `update-shape`
  - 창 생성/이동: `createWindow()` 내부 `win.on('moved', …)` (디바운스 300ms,
    `screen.getDisplayNearestPoint(center)`로 디스플레이 판정, 우하단 모서리 고정 리사이즈)
- 렌더러: `src/renderer/app.js`
  - `togglePlaylistPanel()` (펼침: `update-shape{visibleHeight: innerHeight}` 후 `.open` 클래스;
    접힘: `.open` 제거 후 300ms 뒤 `update-shape{visibleHeight: collapsedH}`)
  - `init()` 말미 `requestAnimationFrame`에서 `set-exact-height(maxH)` + `update-shape(collapsedH)`
- CSS: `src/renderer/style.css`
  - `#player-area { position:absolute; bottom:0; overflow:hidden; border-radius:var(--window-radius) }`
  - `#queue-list { max-height:0; transition:max-height .3s ease }`,
    `#playlist-panel.open #queue-list { max-height:280px }`

### `moved` 핸들러(현재)
```js
win.on('moved', () => {
  try { applyCurrentShape(win); } catch {}        // 드래그 중 클립 유지
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    const fb = win.getBounds();
    const center = { x: fb.x + Math.round(fb.width/2), y: fb.y + Math.round(fb.height/2) };
    const disp = screen.getDisplayNearestPoint(center);
    if (disp.id === lastDisplayId) return;         // 같은 모니터면 무시
    lastDisplayId = disp.id;
    const newScale = computeUiScale(disp);
    const { x:dx, y:dy, width:dw, height:dh } = disp.workArea;
    const newW = Math.round(DESIGN_WIDTH * newScale);
    const designH = mainWinDesignMaxH ?? Math.min(WIN_HEIGHT_MAX, dh/newScale);
    const newH = Math.min(Math.round(designH * newScale), dh);
    let newX = fb.x + fb.width - newW;             // 우하단 모서리 고정
    let newY = fb.y + fb.height - newH;
    newX = Math.max(dx, Math.min(newX, dx + dw - newW));
    newY = Math.max(dy, Math.min(newY, dy + dh - newH));
    applyUiScale(win, newScale);
    win.setBounds({ x:newX, y:newY, width:newW, height:newH });
    applyCurrentShape(win);
  }, 300);
});
```

## 10. 현재 코드 상태
- 현재 작업 트리는 **옵션 A(`setShape` 유지) + `app.disableHardwareAcceleration()`** 상태이며,
  보조 모니터 사라짐/순간이동이 재현됨. (옵션 B 구현체는 직전 커밋 이전 작업 내역에 있었고
  되돌린 상태.) 모든 변경은 아직 커밋 안 됨(working tree).
