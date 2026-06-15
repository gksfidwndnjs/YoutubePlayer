<div align="center">

<img src="assets/icon.png" width="120" alt="YouTube Player icon">

# YouTube Player

화면 우하단에 도킹되는 **컴팩트 YouTube 음악 플레이어 위젯**
브러시드 메탈 + CRT 그린 레트로 UI · Windows · Electron

[![release](https://img.shields.io/github/v/release/gksfidwndnjs/YoutubePlayer)](https://github.com/gksfidwndnjs/YoutubePlayer/releases/latest)

</div>

---

## 소개

YouTube Player는 작업 중에 한쪽 구석에 띄워두고 쓰는 작은 데스크톱 음악 플레이어입니다.
브라우저 탭을 따로 열지 않고도 YouTube 음원을 검색·재생·다운로드할 수 있으며,
평소엔 플레이어 바만 보이다가 토글하면 재생목록이 제자리에서 부드럽게 펼쳐집니다.

전체 UI는 브러시드 스테인리스 메탈 베젤과 CRT 그린 화면 톤으로 꾸며진 레트로 미니 기기 컨셉입니다.

## 주요 기능

### 재생
- YouTube 음원 스트리밍 재생 (`yt-dlp` 기반)
- 다운로드된 트랙은 **로컬 파일 우선 재생**, 없으면 스트리밍 폴백
- 재생 모드: **한 번만 / 전체 반복 / 한 곡 반복**
- 자동 다음 곡(auto-advance), 볼륨·진행바 컨트롤
- 키보드 단축키

  | 키 | 동작 |
  |----|------|
  | `Space` | 재생 / 일시정지 |
  | `→` 또는 `n` | 다음 곡 |
  | `←` 또는 `p` | 이전 곡 |

### 재생목록 · 검색
- 접이식 재생목록(큐) 패널
- YouTube 재생목록 URL로 플레이리스트 추가, 여러 플레이리스트 간 전환
- 곡 검색 (YouTube Data API v3 키 필요)

### 다운로드
- 트랙 개별 다운로드 + 큐 전체 **일괄 다운로드**
- 다운로드 폴더 지정 가능 (기본 `YTmusic`)
- 다운로드 상태 표시(진행/완료)

### 창 · 멀티모니터
- **버튼 기반 창 배치** — 위치 버튼(2×2 그리드) → 코너 스냅 + 모니터 전환
  (네이티브 드래그가 멀티모니터에서 순간이동하는 문제를 대체)
- 상단 코너 배치 시 레이아웃이 뒤집혀 재생목록이 아래로 펼쳐짐
- 보조 모니터에서 **사라짐/순간이동 없음** (투명창 `setShape` 제거)
- 모니터 해상도에 맞춘 일관 스케일링
- 항상 위(always-on-top) 토글, 최소화/닫기, 프레임리스 투명창

## 다운로드 / 설치

[**Releases**](https://github.com/gksfidwndnjs/YoutubePlayer/releases/latest)에서 `YouTube-Player-x.y.z.exe`(portable) 다운로드 후 바로 실행하세요. **설치 불필요.**

> ⚠️ 코드 서명이 없어 첫 실행 시 Windows SmartScreen 경고가 뜰 수 있습니다.
> **추가 정보 → 실행**으로 진행하면 됩니다.

## 사용법

1. 앱을 실행하면 주 모니터 **우하단**에 위젯이 나타납니다.
2. 검색 기능을 쓰려면 **YouTube Data API v3 키**가 필요합니다.
   [Google Cloud Console](https://console.cloud.google.com/)에서 키를 발급받아 설정(⚙)에 입력하세요.
   - 헤더의 점 표시기로 키 상태를 확인할 수 있습니다 (회색=없음 / 초록=설정됨).
3. 검색 또는 재생목록 URL로 곡을 큐에 추가하고 재생합니다.
4. 위치 버튼으로 원하는 모니터·코너에 배치하세요.

## 소스에서 빌드

```bash
# 의존성 설치
npm install

# 개발 실행
npm start

# Windows portable exe 빌드 (dist/ 에 생성)
npm run build
```

> 빌드는 Windows에서 실행하세요. (Linux/WSL에서는 Windows 코드 서명에 wine이 필요합니다.)

앱 아이콘을 다시 생성하려면 (Pillow 필요):

```bash
python3 scripts/make_icon.py   # assets/icon.png + assets/icon.ico 재생성
```

## 기술 스택

- **Electron 35** (Chromium 134) — 프레임리스 투명 위젯 창
- **yt-dlp** (`youtube-dl-exec`) — 음원 추출/다운로드
- **ffmpeg-static** — 오디오 처리
- 렌더러: 바닐라 JS + CSS (프레임워크 없음)
- 패키징: **electron-builder** (portable target)

## 프로젝트 구조

```
src/
  main.js              메인 프로세스 (창/스케일/배치, IPC, 다운로드, yt-dlp)
  renderer/
    index.html         위젯 UI
    app.js             재생/큐/검색/다운로드/창 배치 로직
    style.css          메탈 + CRT 레트로 테마
    texture.js         metal.png 브러시드 텍스처 적용
assets/
  metal.png            브러시드 스테인리스 텍스처
  icon.png / icon.ico  앱 아이콘
scripts/
  make_icon.py         아이콘 생성기 (PIL)
```

## 면책

개인용 비공식 프로젝트입니다. YouTube 콘텐츠 이용은 각자 YouTube 이용약관 및 저작권을 준수하는 범위에서 사용하세요.
