# 설치본에서만 다운로드가 실패하던 문제 — 조사 기록 (2026-08-11)

## 한 줄 요약
`youtube-dl-exec`은 yt-dlp 실행 파일 경로에 **공백**이 있으면 셸 모드로 전환하면서
**실행 파일만 따옴표로 감싸고 인자는 감싸지 않는다.** 설치 경로가
`…\Metalwave for YouTube\…` 이므로 패키지 빌드에서만 모든 인자가 공백에서 쪼개졌다.

---

## 1. 증상

사용자 신고는 두 가지였고, 오래도록 별개의 문제로 보였다.

- 이미 다운로드한 곡인데 체크 표시가 있는데도 재생할 때마다 다시 받는 것 같다.
- 다운로드가 계속 실패한다.

실제 저장 폴더에는 이런 파일들이 있었다.

```
Memory of Beach by M2U          ← 확장자 없음, [videoId] 없음
Memory of Beach by M2U.webp     ← 썸네일 잔여물
Sunny Side by Croove.webp       ← 음원 없이 썸네일만
```

`근신ost` 폴더에 53개, `리듬게임`에 3개, 썸네일 잔여물은 전체 60개였다.

## 2. 재현 실패와 잘못된 결론

CLI로도, `youtube-dl-exec`을 직접 호출해도, 심지어 **문제의 곡을 문제의 폴더에**
받아도 전부 정상 동작했다. 출력 템플릿은 다운로드 기능 첫 커밋부터
`%(title)s [%(id)s].%(ext)s` 하나로 고정이었다.

여기서 "이 앱은 그런 이름을 만들 수 없다 → 다른 도구가 만든 파일이다"라고 결론지었다.
**이 결론은 틀렸다.** 패키지 빌드에서는 앱이 정확히 그 이름을 만들고 있었다.

재현이 안 된 이유는 개발 경로 `D:\YoutubePlayer\…` 에 **공백이 없어서** 문제의
코드 분기를 타지 않았기 때문이다.

## 3. 결정적 증거

실패 원인을 토스트와 로그 파일에 남기도록 고친 뒤(v1.4.6), 사용자의 실제 로그에서:

```
ERROR: [generic] 'for' is not a valid URL
ERROR: [generic] '[%(id)s].%(ext)s' is not a valid URL
ERROR: [generic] 'YouTube\resources\...\ffmpeg-static\ffmpeg.exe' is not a valid URL
ERROR: Postprocessing: ffmpeg not found.
```

- `'for'` → `Metalwave for YouTube` 가 공백에서 쪼개진 조각
- `'[%(id)s].%(ext)s'` → 출력 템플릿이 첫 공백에서 잘린 나머지
- ffmpeg 경로도 같은 방식으로 파편화

## 4. 원인

`node_modules/youtube-dl-exec/src/index.js`:

```js
const needsQuoting = process.platform === 'win32' && /\s/.test(binaryPath)
const safeBinaryPath = needsQuoting ? `"${binaryPath}"` : binaryPath
...
if (needsQuoting) opts.shell = true      // 인자는 따옴표로 감싸지 않음
return $(safeBinaryPath, fullArgs, opts)
```

셸이 켜지는데 인자는 무방비라 전부 단어 분리된다.

## 5. 하나의 원인이 설명한 것들

- 출력 템플릿이 `%(title)s` 에서 끊김 → `%(ext)s` 가 없으니 **확장자 없는 파일** 생성
- 파일에 `[videoId]` 가 없음 → 앱의 로컬 인덱스가 인식 못 함 → **매번 재다운로드**
- ffmpeg 경로 파편화 → **썸네일 삽입 실패** → `.webp` 잔여물 60개
- 개발 모드에서는 멀쩡 → **재현 불가**

즉 사용자가 신고한 두 증상은 같은 원인이었다.

## 6. 수정 (v1.4.7)

셸을 거치지 않고 `execFile`로 직접 실행한다. argv가 `CreateProcess`에 그대로
전달되므로 공백이 문제되지 않는다.

```js
execFile(ytDlpPath, [url, ...ytDlpArgs(flags)],
  { maxBuffer: YT_DLP_MAX_BUFFER, windowsHide: true }, cb);
```

**검증:** 일부러 공백이 든 경로(`…/Metalwave for YouTube/bin/yt-dlp.exe`)를 만들어 비교.

| 방식 | 결과 |
|---|---|
| 기존 (`youtube-dl-exec`) | `ERROR: [generic] '[%(id)s].%(ext)s' is not a valid URL` — 사용자 로그와 동일 |
| 신규 (`execFile`) | `Memory of Beach by M2U [_Y0LRZ3e34Q].m4a` (3,437,819 bytes, 썸네일 삽입 완료) |

## 7. 배운 것

- **패키지 빌드에서만 나는 버그가 있다.** 설치 경로에 공백이 있는지 없는지처럼 사소한
  환경 차이가 코드 분기를 바꾼다. dev에서 재현되지 않는다고 "앱 문제가 아니다"로
  결론내면 안 된다.
- **오류 원인을 삼키지 말 것.** 이 문제는 실패 원인을 토스트와 로그에 남기도록 고친
  직후에 즉시 풀렸다. 그 전까지는 추측만 반복했다.
- 후속으로 일시적 실패 재시도, 일괄 다운로드 간격, yt-dlp 실행 시 자동 갱신을
  추가했다 (v1.4.8).

## 8. 잔여 이슈

- 이전 버전이 만든 확장자 없는 파일은 자동 복구되지 않는다. 재생목록의 곡 제목과
  대조해 `제목 [videoId].확장자` 로 되돌리는 일회성 정리를 수행했다(53개 복원).
- 파일 헤더(`ftyp` 등)를 읽어 실제 컨테이너를 판별했다.
