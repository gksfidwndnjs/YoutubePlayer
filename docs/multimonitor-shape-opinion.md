# Electron `setShape` 멀티모니터 이슈에 대한 의견

## 결론

현재 문제는 좌표 계산이나 `uiScale` 설계의 문제가 아니라, Windows에서 `transparent` + `frameless` + `setShape` 조합이 멀티모니터 환경에서 불안정하게 동작하는 문제로 보는 것이 타당하다.

따라서 `setShape`를 계속 핵심 아키텍처에 두는 방향은 권하지 않는다. 가장 현실적인 방향은 **창은 최대 펼침 높이로 고정하되, `setShape`를 제거하고, 시각적 클리핑은 CSS로, 빈 영역 클릭 통과는 `setIgnoreMouseEvents()`의 동적 토글로 분리하는 것**이다.

## 근거

Electron 공식 문서에서 `win.setShape(rects)`는 Windows/Linux 대상 **Experimental API**로 명시되어 있다.

문서상 `setShape`는 단순 렌더링 클립이 아니라 다음 두 가지를 동시에 바꾼다.

- 시스템이 픽셀을 그릴 수 있는 영역
- 마우스 이벤트를 받을 수 있는 영역

즉 현재 구조처럼 `setShape`에 둥근 모서리, 접힘 클리핑, 클릭 통과를 모두 맡기면 창 렌더링과 입력 히트테스트가 강하게 결합된다. 이 결합은 투명 프레임리스 창, 네이티브 드래그, 멀티모니터, DPI 변환이 동시에 걸리는 상황에서 특히 위험하다.

참고:

- Electron `setShape` 문서: https://www.electronjs.org/docs/latest/api/base-window#winsetshaperects-windows-linux-experimental
- Electron transparent window 제약: https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#transparent-windows

## 현재 진단에 대한 판단

문서에 적힌 실험 결과는 `setShape`가 원인이라는 결론을 꽤 강하게 지지한다.

- 모든 `setShape` 호출을 끄면 보조 모니터에서 정상 표시된다.
- `app.disableHardwareAcceleration()`은 효과가 없다.
- 사라지는 동안에도 `bounds`는 보조 모니터 작업영역 안에 정상적으로 들어온다.
- `setShape` 없이 콘텐츠 크기에 맞춰 리사이즈하면 보조 모니터 문제가 사라진다.
- `setZoomFactor()` 적용 여부와 무관하게 문제가 재현된다.

이 조합이면 `uiScale`, DPI, bounds 계산 오류보다는 Electron/Chromium/Windows DWM 쪽의 shaped transparent window 처리 문제로 보는 편이 맞다.

특히 현재 코드의 `moved` 핸들러에서 드래그 중 `applyCurrentShape(win)`를 계속 호출하는 점은 위험하다. 네이티브 드래그 중 창의 shape region을 반복해서 바꾸면 Windows의 hit-test/capture 상태와 충돌할 수 있다. 드래그 순간이동도 이 경로와 관련 있을 가능성이 높다.

## 권장 아키텍처

추천하는 구조는 다음과 같다.

1. 메인 창은 항상 최대 펼침 높이로 유지한다.
2. `setShape`는 완전히 제거한다.
3. 둥근 모서리와 접힘/펼침 애니메이션은 CSS에서 처리한다.
4. 접힌 상태에서 위쪽 빈 투명 영역은 `win.setIgnoreMouseEvents(true, { forward: true })`로 클릭 통과시킨다.
5. 렌더러가 커서 위치를 기준으로 실제 UI 영역 위에 있을 때만 `setIgnoreMouseEvents(false)`로 되돌린다.
6. IPC는 매 프레임 보내지 않고, ignore 상태가 바뀔 때만 보낸다.

이 방식은 `setShape`가 하던 역할을 둘로 나눈다.

- 시각적 표현: CSS `border-radius`, `overflow: hidden`, `max-height` transition
- 입력 처리: `setIgnoreMouseEvents()` 동적 토글

이렇게 하면 사용자가 원하는 "OS 창이 늘었다 줄었다 하지 않는 느낌"은 유지하면서, 불안정한 shaped native region 의존성을 제거할 수 있다.

참고:

- Electron `setIgnoreMouseEvents` 문서: https://www.electronjs.org/docs/latest/api/base-window#winsetignoremouseeventsignore-options

## `setIgnoreMouseEvents` 방식의 한계

`setIgnoreMouseEvents()`는 region 단위 API가 아니라 창 전체 단위 API다. 따라서 완전한 네이티브 shape 대체품은 아니다.

하지만 `{ forward: true }`를 사용하면 ignore 상태에서도 mouse move 계열 이벤트를 Chromium 쪽으로 전달할 수 있다. 이를 이용하면 렌더러가 커서 위치를 보고 다음 상태를 전환할 수 있다.

구현 시에는 다음을 신경 써야 한다.

- 커서가 실제 `#player-area` 영역 안에 들어오면 즉시 `ignore=false`
- 커서가 접힌 상태의 위쪽 빈 영역으로 나가면 `ignore=true`
- 버튼, 드롭다운, 모달, 팝업을 여는 동안에는 `ignore=false` 유지
- 드래그 시작부터 종료까지는 `ignore=false` 고정
- 둥근 모서리 바깥 코너도 클릭 통과시키려면 렌더러에서 radius 기반 hit-test 필요

이 방식이 완벽하지는 않지만, 현재 문제의 본질인 `setShape` 멀티모니터 컴포지팅 문제를 피할 수 있다는 장점이 더 크다.

## 작업표시줄 썸네일 문제

창을 최대 높이로 고정하면 작업표시줄 썸네일에 빈 영역이 보일 수 있다.

이 경우 Windows에서는 `win.setThumbnailClip(region)`을 별도로 검토할 수 있다. 이 API는 작업표시줄 썸네일에 보이는 영역만 조정하므로, 창의 실제 렌더링/입력 region을 바꾸는 `setShape`보다 위험도가 낮다.

다만 썸네일은 핵심 인터랙션이 아니므로, 우선순위는 낮게 두는 편이 좋다.

## `setShape`를 계속 실험한다면

완전히 버리기 전에 원인을 더 좁히고 싶다면 다음 순서로 테스트하는 것이 좋다.

1. `setShape([{ x: 0, y: 0, width, height }])`처럼 단일 사각형만 적용
2. 전체 창 높이에 rounded rect shape 적용
3. 아래 정렬 offset shape를 사각형으로만 적용
4. 현재 방식처럼 아래 정렬 rounded rect shape 적용
5. 드래그 중 `applyCurrentShape(win)` 호출 제거
6. 모니터 전환 후 `setShape([])`로 초기화한 다음 다음 tick에서 shape 재적용
7. `thickFrame: false`, `roundedCorners: false`, `hasShadow: false`, `backgroundMaterial: 'none'`을 각각 독립적으로 테스트

이 테스트의 목적은 해결책을 찾기보다는 문제가 "rounded rect" 때문인지, "offset shape" 때문인지, "드래그 중 shape 변경" 때문인지 확인하는 것이다.

다만 이 테스트에서 특정 조합이 우연히 동작하더라도 장기적으로 신뢰하기는 어렵다. `setShape`가 실험적 API이고, Electron/Chromium/Windows 업데이트에 따라 다시 깨질 수 있기 때문이다.

## 드래그 순간이동에 대한 의견

드래그 순간이동은 현재 `moved` 디바운스 후의 `setBounds()`보다 드래그 중 `applyCurrentShape(win)` 호출이 더 의심스럽다.

현재 코드는 `moved` 이벤트마다 shape를 다시 적용한다. 이때 shape region은 window-local physical pixel 좌표이고, 창은 가상 데스크톱 좌표계에서 모니터 경계를 넘어 이동한다. 보조 모니터가 왼쪽에 있는 구성에서는 음수/양수 가상 좌표, monitor boundary, native drag capture, shaped hit-test가 동시에 개입한다.

따라서 우선 테스트할 것은 다음이다.

- 드래그 중에는 `applyCurrentShape(win)`를 호출하지 않는다.
- 드래그가 끝난 뒤 display가 바뀐 경우에만 shape를 재적용한다.
- 가능하면 `will-move`/`moved`보다 사용자가 직접 잡는 drag region의 pointer down/up 상태를 렌더러에서 알려 드래그 중 shape 변경을 막는다.

하지만 이 역시 근본 해결이라기보다 완화책이다. 최종적으로는 `setShape` 제거가 더 낫다.

## 하이브리드 안에 대한 판단

주 모니터에서는 `setShape`, 보조 모니터에서는 리사이즈 방식으로 바꾸는 하이브리드 안은 권하지 않는다.

이유는 다음과 같다.

- 모니터마다 펼침/접힘 감각이 달라진다.
- 모니터 경계 전환 시 구현 복잡도가 커진다.
- 전환 순간 shape 제거, bounds 변경, zoom 변경, CSS 상태 전환이 겹쳐 글리치가 생기기 쉽다.
- 나중에 버그 리포트가 들어왔을 때 재현 조건이 더 복잡해진다.

일관성을 중시한다면 모든 모니터에서 같은 방식으로 동작하는 구조가 낫다.

## 최종 제안

가장 좋은 다음 단계는 다음 순서다.

1. `setShape`를 메인 창 경로에서 제거한다.
2. 창은 최대 펼침 높이로 고정한다.
3. 접힘/펼침은 현재 CSS transition을 유지한다.
4. 렌더러 hit-test + `setIgnoreMouseEvents(true, { forward: true })`로 투명 빈 영역 클릭 통과를 구현한다.
5. 작업표시줄 썸네일이 문제로 보이면 이후 `setThumbnailClip()`을 추가 검토한다.

이 방향이 현재 요구사항을 가장 잘 만족한다.

- 보조 모니터에서 정상 동작
- 창 리사이즈 애니메이션 없음
- 콘텐츠는 제자리에서 부드럽게 펼침/접힘
- 실험적 `setShape` 의존성 제거
- 모니터마다 동작이 달라지는 하이브리드 회피

요약하면, **`setShape`로 native region을 만들려는 접근을 포기하고, "시각적 클립"과 "입력 통과"를 분리하는 것이 이 문제의 가장 안정적인 해법**이다.
