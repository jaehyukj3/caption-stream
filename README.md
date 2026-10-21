# 실시간 자막 스트리밍 (MVP)

강의장에서 강사(송출자)의 음성을 실시간 자막으로 바꿔 **송출 PC 화면**과 **참석자 휴대폰 브라우저**에 동시에 보여주는 웹앱입니다. 참석자는 설치 없이 QR 코드나 링크로 접속합니다.

```
[강사 PC · 크롬]                         [서버 · Node + ws]                [참석자 휴대폰]
 마이크 → Web Speech API(ko-KR)            방(room)별 브로드캐스트            /view/123456
   ├ interim(초당 ≤4회) ──────────────▶   확정 자막 이력(메모리) ──────▶   자막 표시
   └ final(용어 사전 치환 후) ────────▶   seq 부여 · 늦은 입장자에 history
```

## 폴더 구조

```
shared/   공통 타입과 WebSocket 메시지 프로토콜 (shared/src/index.ts)
server/   Node.js + ws. 방 관리, 브로드캐스트, interim 쓰로틀, 운영 시 정적 파일 서빙
client/   Vue 3 + Vite
  src/components/caption/CaptionView.vue   ← 자막 표시 전용 (Electron 재사용 대상)
  src/stt/SttProvider.ts                   ← STT 인터페이스 (엔진 교체 지점)
  src/views/HostView.vue, ViewerView.vue
```

## 요구 사항

- Node.js 20 이상
- **송출 PC: 데스크톱 크롬 또는 엣지.** 음성인식에 Web Speech API를 쓰기 때문입니다. 크롬의 Web Speech API는 음성을 Google 서버로 보내 인식하므로 **인터넷 연결이 필요**합니다.
- 수신 기기: 최신 모바일 브라우저면 됩니다 (iOS Safari, 안드로이드 크롬 등).

## 🚀 인터넷에 배포하기 (Render) — 명령어 없이 주소로만 사용

한 번 배포해 두면 강사는 크롬으로 `https://<서비스명>.onrender.com/host`만 열면 됩니다.
HTTPS가 자동으로 붙어 **어느 PC에서든 마이크가 동작**하고, 참석자는 Wi‑Fi든 LTE든 QR만 찍으면 됩니다.

### 처음 한 번만 (웹 화면에서 클릭)

1. https://render.com 에 **GitHub 계정으로 가입/로그인**
2. 우측 상단 **New + → Blueprint** 선택
3. 이 저장소를 고르고 **Connect** → 저장소의 `render.yaml`을 읽어 설정이 자동으로 채워집니다
4. **Apply** (또는 Deploy Blueprint) 클릭 → 3~5분 뒤 `https://caption-stream-xxxx.onrender.com` 같은 주소가 생깁니다
5. 그 주소 뒤에 `/host`를 붙여 열면 송출 화면입니다. 즐겨찾기에 추가해 두세요.

이후 GitHub에 코드가 올라가면 자동으로 다시 배포됩니다.

### 요금제와 주의점

| | Free | Starter (월 약 $7) |
|---|---|---|
| 15분간 요청이 없으면 | 서버가 잠듦 (깨어나는 데 30초~1분) | 항상 켜져 있음 |
| 잠들거나 재배포되면 | 진행 중이던 방·자막 이력 사라짐 | 재배포 시에만 사라짐 |

- **무료 플랜 사용 팁:** 강의 시작 5분 전에 송출 주소를 미리 열어 서버를 깨워 두세요. 송출 화면이 열려 있는 동안에는 5분마다 서버를 자동으로 깨워 두므로, 강의 중에 잠들지는 않습니다.
- **정식 강의에 쓸 때**는 Render 대시보드의 서비스 → Settings → Instance Type에서 **Starter**로 바꾸는 것을 권장합니다.
- 리전은 한국과 가까운 **싱가포르**로 설정되어 있습니다(`render.yaml`의 `region`). 자막은 텍스트만 오가므로 지연은 체감되지 않는 수준입니다.

---

## 빠른 시작 (개발 모드)

```bash
npm install
npm run dev
```

- 서버는 `:3001`, 클라이언트(Vite)는 `:5173`에서 실행됩니다. Vite가 `/api`와 `/ws`를 서버로 프록시합니다.
- 송출 화면은 **http://localhost:5173/host** 입니다.

---

## 로컬 테스트: PC 1대(송출) + 휴대폰(수신)

### 1. 같은 네트워크에 연결

PC와 휴대폰을 **같은 Wi‑Fi**에 연결합니다.

> ⚠️ 호텔·카페·사내 **게스트 Wi‑Fi**는 기기끼리 통신을 막는 경우(AP isolation)가 많습니다. 휴대폰에서 접속이 안 되면 휴대폰 핫스팟에 PC를 연결해서 테스트해 보세요.

### 2. 실행하고 송출 화면 열기

```bash
npm run dev
```

송출 PC의 크롬에서 **`http://localhost:5173/host`** 를 엽니다.

- 반드시 `localhost`로 여세요. 마이크와 음성인식은 **보안 컨텍스트(HTTPS 또는 localhost)** 에서만 동작합니다.
- `http://192.168.x.x:5173`처럼 IP로 열면 송출 PC에서도 마이크가 막힙니다.

### 3. 세션 만들고 휴대폰으로 접속

1. **세션 만들기**를 누르면 6자리 방 코드와 QR 코드가 표시됩니다.
2. 송출 화면을 `localhost`로 열었어도 QR에는 서버가 찾아낸 **PC의 LAN 주소**(예: `http://192.168.0.12:5173/view/123456`)가 들어갑니다.
   - LAN 주소가 여러 개면 QR 옆 드롭다운에서 고를 수 있습니다.
   - QR을 클릭하면 전체 화면으로 커져서 빔프로젝터로 띄우기 좋습니다.
3. 휴대폰 카메라로 QR을 찍습니다. 수신 페이지는 마이크를 쓰지 않으므로 **일반 HTTP로 접속해도 됩니다.**

### 4. 송출 시작

**마이크 시작**을 누르고 크롬의 마이크 권한을 허용한 뒤 말하면 됩니다. 확정 문장은 PC와 휴대폰에 누적되고, 인식 중인 문장(interim)은 흐리게 표시됩니다.

### 휴대폰에서 접속이 안 될 때

| 증상 | 확인할 것 |
|---|---|
| 페이지가 아예 안 열림 | PC 방화벽에서 Node.js 허용 (Windows: "Windows Defender 방화벽 → 앱 허용"에서 **개인 네트워크** 체크). macOS는 첫 실행 시 "들어오는 연결 허용"을 선택 |
| QR 주소가 `localhost`로 나옴 | 드롭다운에서 LAN 주소를 고르거나, `PUBLIC_URL`을 지정 (아래 참고) |
| 열리는데 "연결 중…"에서 멈춤 | 회사망이나 프록시가 WebSocket을 막는지 확인. PC 브라우저에서 같은 수신 주소로 먼저 열어 보기 |

### 보안 컨텍스트(HTTPS) 정리

| 접속 형태 | 송출(마이크·음성인식) | 수신 |
|---|---|---|
| `http://localhost:...` (송출 PC 본인) | ✅ | ✅ |
| `http://192.168.x.x:...` | ❌ 마이크 차단 | ✅ (화면 꺼짐 방지만 비활성) |
| `https://...` | ✅ | ✅ |

**송출을 다른 PC에서 해야 한다면** 다음 두 가지 방법 중 하나를 쓰세요.

- **자체 서명 HTTPS로 개발 서버 실행:**
  ```bash
  npm run dev:https      # https://<LAN IP>:5173
  ```
  브라우저에 인증서 경고가 뜨면 "고급 → 계속"을 눌러 진행합니다. 이때 QR 주소도 `https://`가 되므로 휴대폰에서도 같은 경고를 한 번 통과해야 합니다.
- **크롬 플래그로 해당 주소를 예외 처리 (테스트 PC 전용):**
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`에 `http://192.168.x.x:5173`을 추가합니다.

---

## 운영 모드 (서버 하나로 실행)

```bash
npm run build      # client/dist 생성
npm start          # :3001 에서 API + WebSocket + 정적 파일 모두 서빙
```

이 경우 송출 화면은 `http://localhost:3001/host` 입니다. 실제 강의장에서 쓸 때는 HTTPS 리버스 프록시(nginx, Caddy 등)나 터널(Cloudflare Tunnel 등) 뒤에 두고 `PUBLIC_URL`을 지정하는 것을 권장합니다. 리버스 프록시는 `/ws`의 WebSocket Upgrade를 전달해야 합니다.

### 환경 변수 (server)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3001` | 서버 포트 |
| `HOST` | `0.0.0.0` | 바인딩 주소 |
| `PUBLIC_URL` | (없음) | QR/링크에 쓸 외부 주소. 예: `https://caption.example.com` |

---

## 기능 요약

**송출자 (`/host`)**
- 세션을 만들면 6자리 방 코드, 수신 URL, QR 코드(전체 화면 확대 가능)가 생성됩니다.
- 마이크 시작·일시정지·세션 종료, 입력 레벨 미터를 제공합니다.
- 확정 문장은 누적되고, interim은 흐리게 표시됩니다. 서버 연결이 끊긴 동안의 문장은 기울임꼴로 보관했다가 재연결 후 전송합니다.
- **플로팅 자막**: Document Picture‑in‑Picture로 항상 위에 떠 있는 자막 창을 엽니다. 데스크톱 크롬·엣지 116 이상에서 동작하고, 미지원 브라우저에서는 안내 메시지를 표시합니다.
- **용어 사전**: "오인식 → 교정어"를 등록하면 송출 전에 치환합니다.
  - 띄어쓰기 차이는 무시합니다.
  - 긴 단어가 먼저 매칭되고, 연쇄 치환은 일어나지 않습니다.
  - 사전은 브라우저(localStorage)에 저장됩니다.
- 현재 접속자 수를 보여주고, 자막 전체를 .txt로 저장할 수 있습니다.
- 새로고침해도 같은 방을 이어서 송출합니다. hostToken은 sessionStorage에 있으므로 탭을 닫으면 송출 권한이 사라집니다.

**수신자 (`/view/:code`)**
- 늦게 들어와도 지금까지의 확정 자막 이력을 받습니다.
- 재연결 시에는 놓친 문장만(`sinceSeq`) 다시 받습니다.
- 최신 문장을 강조하고 자동으로 스크롤합니다. 위로 스크롤하면 자동 스크롤이 멈추고 **"최신 자막으로 ↓"** 버튼이 나타납니다.
- 글자 크기 조절, 다크/라이트 모드를 지원하고 설정은 기기에 저장됩니다.
- 전체 자막을 .txt로 다운로드할 수 있습니다 (`[HH:MM:SS] 문장` 형식, 메모장 호환 BOM 포함).
- 지원 브라우저에서 HTTPS로 접속하면 시청 중 화면 꺼짐을 방지합니다.

**서버**
- 방 단위로 브로드캐스트하고, 확정 이력을 메모리에 보관합니다 (방당 최대 5,000줄).
- 송출 권한은 방을 만들 때 발급한 `hostToken`으로 검증합니다.
- interim은 서버에서도 방마다 **초당 최대 4회**로 쓰로틀합니다 (마지막 값은 보장).
- **방 유지 시간: 2시간.** 송출자 연결이 끊기거나 세션이 종료된 뒤 2시간이 지나면 방이 삭제됩니다.
- 30초 간격 ping/pong으로 죽은 연결을 정리합니다. 클라이언트는 1s→2s→…→최대 10s 백오프로 자동 재연결하고, 화면이 다시 보이거나 네트워크가 복구되면 즉시 재연결합니다.

## 메시지 프로토콜

전체 정의는 `shared/src/index.ts`에 있습니다. 모든 메시지는 JSON 텍스트 프레임입니다.

| 방향 | type | 필드 |
|---|---|---|
| C→S | `join` | `code`, `role: host\|viewer`, `hostToken?`, `sinceSeq?` |
| C→S | `interim` / `final` | `text` (host만) |
| C→S | `end` | (host만) |
| S→C | `joined` | `role`, `code`, `ended` |
| S→C | `history` | `lines: {seq, text, ts}[]` |
| S→C | `interim` | `text` (빈 문자열이면 지움) |
| S→C | `final` | `line: {seq, text, ts}` |
| S→C | `viewerCount` | `count` |
| S→C | `sessionEnd` | – |
| S→C | `error` | `code`, `message` |

HTTP 엔드포인트는 `POST /api/rooms`(방 생성), `GET /api/rooms/:code`(상태), `GET /api/net-info`(LAN 주소) 세 가지입니다.

## 확장 포인트

- **STT 교체**: `client/src/stt/SttProvider.ts` 인터페이스를 구현한 클래스를 추가하고, `HostConsole.vue`의 `new WebSpeechProvider()` 한 줄을 바꾸면 됩니다. 클라우드 STT(Google, Azure, Clova)는 대개 서버를 거쳐야 하므로 오디오를 서버로 보내는 provider를 만들게 됩니다.
- **Electron 오버레이**: `CaptionView.vue`는 props만 받는 순수 표시 컴포넌트입니다. `variant="overlay"`는 투명 배경, 외곽선 글자, 최근 N줄 표시를 지원합니다. Electron 창에서 `useRoomSocket(viewer)`와 `CaptionView`만 조합하면 투명·클릭 통과 자막 창이 됩니다.

## 테스트

```bash
npm test -w server     # 방 이력/재입장, 쓰로틀, final 시 interim 폐기, 2시간 만료
npm run typecheck
```

## 알려진 제한 (MVP)

- 데이터는 메모리에만 있어 **서버를 재시작하면 모든 방이 사라집니다**. 단일 프로세스 기준이며, 여러 인스턴스로 확장하려면 Redis 같은 공유 저장소가 필요합니다.
- Web Speech API는 크롬·엣지 전용이고, 음성이 Google(엣지는 Microsoft) 서버로 전송됩니다.
- 크롬은 인식을 스스로 끊는 경우가 있습니다(약 1분 경과, 침묵, 네트워크 오류). 앱이 자동으로 다시 시작하지만, 재시작 순간에 아주 짧은 구간이 누락될 수 있습니다.
