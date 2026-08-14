<div align="center">

<img src="assets/icon.png" width="110" alt="Metalwave for YouTube">

# Metalwave for YouTube

YouTube 음원과 내 PC 음악을 한 곳에서 재생하는 데스크톱 위젯

[![release](https://img.shields.io/github/v/release/gksfidwndnjs/YoutubePlayer)](https://github.com/gksfidwndnjs/YoutubePlayer/releases/latest)
[![downloads](https://img.shields.io/github/downloads/gksfidwndnjs/YoutubePlayer/total)](https://github.com/gksfidwndnjs/YoutubePlayer/releases)
![platform](https://img.shields.io/badge/platform-Windows-lightgrey)

### [⬇ 다운로드](https://github.com/gksfidwndnjs/YoutubePlayer/releases/latest)

| 접힘 | 펼침 |
|:--:|:--:|
| <img src="assets/preview-collapsed.png" width="330" alt="재생목록 접힘"> | <img src="assets/preview-expanded.png" width="330" alt="재생목록 펼침"> |

</div>

---

화면 구석에 띄워두고 쓰는 작은 음악 플레이어다. 브라우저 탭 없이 YouTube 음원을
재생·다운로드하고, PC에 있는 음악 폴더도 재생목록으로 쓴다.

## 다운로드

[Releases](https://github.com/gksfidwndnjs/YoutubePlayer/releases/latest)의 **Assets**에서
`Metalwave-Setup-1.4.10.exe` 같은 설치 파일을 받는다.
`latest.yml`과 `.blockmap`은 자동 업데이트용이므로 받지 않아도 된다.

설치 중 두 가지를 고른다.

- **설치 위치** — 기본값은 현재 사용자 폴더. 관리자 권한이 필요 없다.
  "모든 사용자용"을 고르면 UAC 창이 뜬다.
- **바탕화면 바로가기** — 기본 켜짐. 시작 메뉴 바로가기는 항상 생성된다.

이후 새 버전은 앱이 알려주고 자동으로 설치한다.

> 코드 서명 인증서가 없어 설치 시 SmartScreen 경고가 뜬다. **추가 정보 → 실행**으로 진행한다.

## 기능

**재생**

- YouTube 음원 스트리밍, 내려받은 곡은 로컬 파일 우선 재생
- 재생 모드 3종 — 한 번만 / 전체 반복 / 한 곡 반복
- [LRCLIB](https://lrclib.net/) 기반 **동기화 가사** (♪ 버튼으로 곡 정보와 전환)
- 앱을 다시 켜면 마지막에 듣던 곡과 재생 위치가 복원됨

**재생목록**

- YouTube 재생목록 URL로 추가
- **Google 로그인** — 내 재생목록 전부 (좋아요·비공개 포함)
- **내 폴더** — PC의 음악 폴더를 재생목록으로 (오프라인 재생)
- 앱 실행 시 자동 갱신 — 원본에서 빠진 곡은 삭제, 새 곡은 추가, 기존 순서 유지
- 목록 이름 검색, 곡·재생목록 검색 (검색만 API 키 필요)

**다운로드**

- 곡별 다운로드 + 큐 전체 일괄 다운로드
- `m4a` + 썸네일로 저장, 재생목록 이름의 하위 폴더로 정리
- 실패 시 자동 재시도, 실패 원인은 로그에 기록 (설정 → 다운로드 → 로그 열기)
- 저장 폴더 변경 시 기존 파일 이동 여부를 물어봄

**창**

- 프레임리스 투명 위젯, 항상 위 고정
- 위치 버튼으로 코너 4곳 스냅 + 모니터 전환, 모니터에 맞춰 크기 자동 조정
- 위젯 바깥 투명 영역은 클릭이 통과됨

## 시작하기

곡을 넣는 방법은 세 가지다.

| 방법 | 위치 |
|------|------|
| URL 붙여넣기 | 🔍 버튼 → Add by URL |
| 검색 | 🔍 버튼 → 검색창 (API 키 필요) |
| 내 PC 폴더 | 재생목록 버튼 → `＋ 폴더` |

설정(⚙)에서 Google 로그인을 하면 내 YouTube 재생목록이 전부 들어온다.

**단축키**

| 키 | 동작 |
|----|------|
| `Space` | 재생 / 일시정지 |
| `→` `n` | 다음 곡 |
| `←` `p` | 이전 곡 |

## 내 폴더 (로컬 음악)

재생목록 팝업의 **`＋ 폴더`** 로 폴더를 고르면 하위 4단계까지의 음악 파일
(`mp3` `m4a` `flac` `opus` `wav` `ogg` `aac` `wma` 등)이 재생목록이 된다.
인터넷·API 키·로그인 없이 동작한다.

- 곡 정보는 파일명에서 읽는다. `07 IU - 밤편지.flac`, `1-18. Artist - Title.mp3`처럼
  번호와 아티스트가 붙은 형식을 인식하고, 이 앱이 받은 파일(`제목 [영상ID].m4a`)은
  YouTube 썸네일이 그대로 붙는다.
- 앨범 아트는 파일에 내장돼 있으면 표시한다.
- 폴더에 파일을 넣거나 빼면 다음에 목록을 열 때 반영된다. 디스크 순서가 재생 순서다.
- 목록에서 제거해도 **폴더와 파일은 지워지지 않는다.**

## API 키

**키가 필요한 기능은 검색뿐이다.** 나머지는 키 없이 전부 동작한다.

| 기능 | API 키 |
|------|:---:|
| 곡·재생목록 검색 | **필요** |
| URL로 추가 · 재생 · 다운로드 | 불필요 |
| Google 로그인, 내 재생목록 | 불필요 |
| 내 폴더, 가사 | 불필요 |

키는 [Google Cloud Console](https://console.cloud.google.com/) → YouTube Data API v3에서
무료로 발급받아 설정(⚙)에 넣는다. 헤더의 점 표시기가 상태를 보여준다 (회색 = 없음, 초록 = 설정됨).

키 없이 쓸 경우 YouTube에서 URL을 복사해 Add by URL로 넣으면 된다.

## Google 로그인

설정(⚙) → **Google로 로그인**. 브라우저에서 동의하면 재생목록이 들어온다.
API 키와 무관하며, 별도 설정도 필요 없다.

- 처음에는 "Google에서 확인하지 않은 앱" 경고가 뜬다 → **고급 → 이동 → 허용**
- 권한은 읽기 전용(`youtube.readonly`)
- 토큰은 사용자 PC에만 저장된다 — [개인정보처리방침](https://gksfidwndnjs.github.io/privacy.html)
- 로그아웃은 설정에서, 권한 철회는 [Google 계정 권한](https://myaccount.google.com/permissions)에서
- OAuth 동의 화면이 테스트 모드인 동안에는 로그인이 약 7일 후 만료된다. 다시 로그인하면 된다.

## 저장 위치

음원은 설정에서 지정한 음악 폴더(기본 `음악\YTmusic`)에, 나머지는 `%APPDATA%\youtube-player\`에 저장된다.

| 파일 | 내용 |
|------|------|
| `settings.json` | 설정, 마지막 재생 위치 |
| `playlists.json` | 재생목록 |
| `google-token.json` | 로그인 토큰 (로그아웃 시 삭제) |
| `download-errors.log` | 다운로드 실패 기록 |
| `covers/` | 로컬 파일 앨범 아트 캐시 |

앱을 제거해도 이 파일들과 음원은 남는다.

---

## 개발

```bash
npm install
npm start          # 개발 실행
npm run build      # dist\Metalwave-Setup-x.y.z.exe 생성
```

Google 로그인을 쓰려면 `src/google-config.js`가 필요하다
(`google-config.example.js` 참고, 저장소에는 포함되지 않음).

**기술 스택** — Electron 35 · yt-dlp(`youtube-dl-exec`) · ffmpeg-static ·
electron-updater · electron-builder(NSIS). 렌더러는 바닐라 JS + CSS.

```
src/
  main.js       창·배치, IPC, 다운로드, 폴더 스캔/앨범 아트, 자동 업데이트
  oauth.js      Google OAuth 2.0 (loopback + PKCE)
  renderer/     위젯 UI (app.js, style.css, texture.js, popups/)
docs/           주요 버그 조사 기록
CHANGELOG.md    버전별 변경 내역
```

까다로웠던 문제들의 조사 기록은 [`docs/`](docs/)에 있다 —
[멀티모니터 투명창](docs/multimonitor-shape-issue.md),
[설치본 다운로드 실패](docs/download-failure-spaced-path.md),
[폴더 재생목록 멈춤](docs/folder-playlist-cover-art-storm.md).

## 면책

개인용 비공식 프로젝트다. YouTube 콘텐츠 이용은 각자 YouTube 이용약관과 저작권을
준수하는 범위에서 사용한다.
