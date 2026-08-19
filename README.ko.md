<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" width="220" alt="RelayAgent" />
  </picture>
</p>

<h1 align="center">RelayAgent</h1>

<p align="center"><b>확률적인 에이전트 위에, 결정적인 층.</b></p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.6-5FA04E" alt="Node.js 22.6+" />
  <img src="https://img.shields.io/badge/status-seed-8B5CF6" alt="status: seed" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
</p>

RelayAgent는 자기 화면을 싣고 다니는 에이전트 패키지의 개인 기판입니다.

에이전트는 확률적이지만 협업은 그렇지 않습니다. 오늘의 모든 에이전트 런타임은 채팅창 하나를 건넬 뿐이고, 채팅창에는 사람이 들여다보거나 검증하거나 도중에 넘겨받을 수 있는 면이 없습니다. 여기서 패키지는 사람이 직접 조작하는 화면과 다시 재생할 수 있는 동사를 함께 싣고, 그 둘을 하나의 매니페스트로 판정합니다. 그래서 같은 층이 사람에게도 에이전트에게도 똑같이 작동합니다.

패키지 하나 = 에이전트 하나 + 그 에이전트의 화면. 설치하면 채팅창이 아니라 소프트웨어가 생깁니다. view는 에이전트와 한 몸으로 버전이 잘리고, 같은 매니페스트로 판정되고, 설치가 빌드하고, 데몬이 `/pkg/<이름>/view/`로 호스팅합니다. 채팅과 채널은 그 소프트웨어로 들어가는 여러 문 중 하나일 뿐입니다.

패키지 하나는 디렉토리 하나입니다. 매니페스트 하나(`relay.yaml`)가 패키지의 전부를 선언합니다. 에이전트, 동사, 화면, 채널, 서비스, 트리거, 그리고 닿지 말아야 할 곳까지. 기판은 매니페스트 밖의 파일을 읽지 않고, 설치는 fail-loud이며, 자격증명은 vault에 살고, 패키지 사이의 모든 연결은 감사 가능한 결재(grant)로 장부에 남습니다.

## 핵심 개념

| 개념 | 의미 |
| --- | --- |
| 패키지 | `relay.yaml`을 가진 디렉토리. 매니페스트가 구조와 경로의 정본, 트리가 내용의 정본. |
| Surfaces | 패키지가 사람을 만나는 면. 중심은 `view`: 패키지가 배송하는 웹 UI로, 설치가 빌드하고 데몬이 `/pkg/<이름>/view/`로 호스팅하며 패키지 토큰으로 자기 에이전트의 동사에 연결된다. `chat`(직접 대화)과 `channels`(Discord, Slack 등 어댑터)는 추가 문 — 채널은 자기가 요구하는 자격의 *형태*를 선언하고(`credential.fields`), 콘솔이 그 선언으로 입력 칸을 그린다(사람이 JSON을 손으로 조립하지 않는다). `components`는 npm 패키지(소스 + `package.json`)를 수출한다 — 다른 패키지의 view가 components edge로 빌드 의존으로 소비하며, 기판이 설치 시점에 tgz로 굽는다(레지스트리 없음). |
| Harness | 패키지에 동봉되어 에이전트를 실행하는 어댑터. 시스템 패키지에 Claude Code, Codex, Kimi, Pi 어댑터 동봉. 동사: `session`, `setup`, `models`, `commands`, `info`(+선택 `login`, `serve` — 턴마다 프로세스를 갈지 않고 stdin 으로 턴을 주입받는 상주 세션). 계약 적합성은 `relay harness-check`가 판정하고, 계약 전문은 [docs/harness-protocol.md](docs/harness-protocol.md)에 있습니다. variant 는 `tool`(`{bin, manager, package, version?}`)을 선언할 수 있고, 그러면 기판이 그 CLI 를 자기 자리에 설치해 PATH 앞에 둡니다 — 호스트의 전역 설치가 없거나 깨져 있어도 패키지가 멈추지 않습니다. |
| Agents | 페르소나(`AGENT.md`)와 스킬, 슬래시 커맨드, 서브에이전트 dispatch. 하네스에는 중립 번들로 전달되고, 네이티브 형식으로의 번역은 전부 어댑터 소유. `default: true` 가 착지 에이전트. |
| Scripts | 동사. `scripts/<이름>.ts`가 `async (input, ctx) => JSON`을 기본 수출. |
| Services | 형태는 셋뿐. `source`(자기 몸, 컨테이너 또는 프로세스), `url`(원격 MCP 접점, 자격은 여기에만 앉음), `dir`(파일 자원). |
| Connector | 몸 없는 커넥터 — 동사가 외부 REST API 를 직접 부르는 패키지. 최상위 `auth` 가 자격의 형태만 선언하고, 값은 vault 에 앉아 동사가 `ctx.credential()` 로 호출 시점에 꺼낸다. `url` 서비스와 동시 선언 불가. |
| Storage | `storage.buckets` — 파일 버킷 파사드. 1인 기판은 판정만 하고, 집행은 org 기판 소유. 서비스의 `disk` 와는 다른 축. |
| Triggers | cron 또는 이벤트. 에이전트를 프롬프트로 깨우거나 스크립트를 headless로 실행. `delivery: <채널>:<대화키>` 는 그 대화의 slot 에서 턴을 돌리고 reply 를 채널 어댑터로 발신한다. |
| Missions | 패키지가 다른 패키지에 제공하는 질의응답 능력. |
| Edges | 다른 패키지의 tools, mission, components에 대한 의존 선언. 선언은 신청이고 활성화는 결재 — components는 집행점이 view 빌드라, 빌드 해석 성공이 곧 결재 기록이다. |
| Workspace | 패키지의 폴더 결재. 세션의 cwd이며 설치 때 정해져(기본 `~/Relay/<이름>`) 장부에 남는다. |
| Hooks | 세션 담장. `hooks.deny`가 세션 도구 호출이 닿으면 안 되는 경로를 선언하고, 어댑터가 네이티브 훅으로 번역한다. 기판은 자기 홈(`~/.relay`)을 항상 병합한다. |
| Grants | 장부에 남는 결재. 결재는 선언을 넘지 못한다. |

## 빠른 시작

요구사항: Node.js 22.6 이상(러너가 `--experimental-strip-types`를 사용), 동봉 하네스를 쓰려면 로그인된 [Claude Code](https://claude.com/claude-code) CLI. macOS에서는 자격증명이 Keychain에 저장되고, 그 외 환경에서는 `0600` 파일 vault를 씁니다.

```sh
git clone https://github.com/relayax/relayagent.git
cd relayagent
npm install
alias relay="node --experimental-strip-types runner/relay.ts"

relay validate packages/system        # 매니페스트 판정
relay install packages/system --ring0 --workspace ~   # 관리 셸을 ring-0으로, 홈 폴더를 workspace로 결재
relay daemon                          # API, 서비스, 트리거, 콘솔
```

데몬은 `http://127.0.0.1:4747`에서 듣습니다(포트는 `RELAY_PORT`로 변경). 콘솔은 `/pkg/system/view/`, 저작 playground는 `/pkg/system/view/playground.html`. 이 콘솔 자체가 system 패키지의 view입니다. 기판 위에서 도는 첫 번째 에이전트 소프트웨어인 셈입니다.

기판과 대화하기:

```sh
relay run system                      # 대화형 세션
relay run system "설치된 패키지 알려줘"  # 1회 실행
```

시스템 에이전트에게 새 패키지를 부탁하면 `agent-builder` 서브에이전트가 넘겨받아 문법을 읽고, 수정 레이어(draft)에 스캐폴드하고, `draft-validate`로 판정하고, `draft-publish`로 발행합니다. 설치본은 실행 중인 바이너리라 직접 만지지 않습니다. 편집은 전부 draft에 쌓이고, 판정을 통과한 스냅샷만 릴리스로 실행본이 됩니다. GUI로 직접 고치려면 콘솔에서 패키지를 골라 스튜디오(`/studio`)를 여세요. 같은 draft, 같은 diff, 같은 배포 관문을 씁니다.

## CLI

```
relay daemon                          기판 기동 (API, 서비스, 트리거, 콘솔)
relay install <dir> [--ring0] [--workspace dir]  패키지 설치 (workspace = 폴더 결재)
relay ls | rm <이름>                   목록 | 제거
relay validate <dir>                  매니페스트 판정
relay build <패키지>                   surfaces.view.out 재빌드
relay run <패키지> [프롬프트]           세션 (프롬프트 없으면 대화형)
relay harness <패키지> [이름]           하네스 variant 조회 또는 전환
relay harness-check <패키지>           하네스 계약 적합성 판정
relay login <패키지> [--token]         하네스 로그인 (login 동사 지원 시)
relay model <패키지> [모델]             모델 조회 또는 설정
relay effort <패키지> [강도|off]        추론 강도 (effort capability 어댑터만 반영)
relay connect <패키지> <서비스>         자격 붙여넣기 (vault / Keychain)
relay grant <consumer> <provider> --tools a,b | --mission m
```

## 패키지 해부

```
my-package/
  relay.yaml                        BOM: 구조와 경로
  assets/icon.svg
  agents/<name>/AGENT.md            페르소나
  agents/<name>/skills/<s>/SKILL.md 스킬
  agents/<name>/commands/<c>.md     슬래시 커맨드
  scripts/<verb>.ts                 기본 수출: async (input, ctx) => JSON
  surfaces/view/                    이 패키지의 화면 (`out` 선언 시 설치가 빌드)
  channels/<name>/                  채널 어댑터 (discord, slack, ...)
  harness/<name>/                   실행 어댑터, 패키지에 동봉
  services/<name>/                  source 서비스 (컨테이너 또는 프로세스)
```

문법은 주석 달린 JSON Schema인 [relay.manifest.yaml](relay.manifest.yaml)입니다. 완결된 예제 매니페스트는 레포 루트의 [relay.yaml](relay.yaml)입니다. 관리 셸 자체도 하나의 패키지입니다: [packages/system](packages/system).

## 설계 원칙

1. **매니페스트가 BOM이다.** `relay.yaml`이 구조와 경로를, 트리가 내용을 소유한다. 매니페스트에서 도달 불가능한 파일은 기판에게 존재하지 않는다.
2. **Fail-loud.** 선언과 실체의 불일치는 판정과 설치를 실패시킨다. 경고는 없고 판정만 있다.
3. **선언은 캡, 결재는 활성화.** 매니페스트의 `edges`와 `dir` 서비스는 신청이다. 활성화는 설치나 `relay grant`에서 일어나 장부에 남고, 선언을 절대 넘지 못한다.
4. **자격증명은 트리에 살지 않는다.** 매니페스트는 auth의 형태(`none`, `token`, `oauth`)만 선언한다. 값은 vault에 앉는다. macOS Keychain, 없으면 `0600` 파일 폴백.
5. **하네스 중립 에이전트.** 에이전트는 중립 번들(페르소나, 스킬, 커맨드, 메타)로 배송된다. 네이티브 형식으로의 번역은 전부 어댑터의 일이므로, 패키지는 특정 CLI에 종속되지 않는다.
6. **최소 지반.** 세션이 딛는 땅은 설치 때 결재된 workspace 하나다. 폴더가 더 필요하면 `dir` 서비스를 선언하고, 닿으면 안 되는 경로는 `hooks.deny`로 막는다. 기판 홈(`~/.relay`)은 모든 세션에서 항상 막힌다.

이 여섯 원칙의 뿌리에는 하나의 전제가 있습니다: **모든 것은 에이전트 패키지로 표현될 수 있다.**

## 디스크 위 상태

| 경로 | 용도 |
| --- | --- |
| `~/.relay/ledger.json` | 설치된 패키지와 결재 장부 |
| `~/.relay/sessions/` | 패키지별 세션 슬롯 |
| `~/.relay/drafts/<이름>/` | 수정 레이어: git 이력을 가진 작업 사본 (스튜디오와 agent-builder가 여기 쓴다) |
| `~/.relay/releases/<이름>/<버전>/` | 발행 스냅샷: 장부 path가 이 중 하나를 가리킨다 (롤백 = 재전환) |
| `~/.relay/logs/*.jsonl` | 이벤트 로그 |
| `~/.relay/vault.json` | Keychain 부재 시 자격 폴백 |
| `~/Relay/` | 보이는 땅: 기본 workspace(`~/Relay/<이름>`) |
| `~/Relay/.stage/` | 채팅과 세션 사이의 파일 교환 무대 |
| `.env` (체크아웃 루트) | 인스턴스 설정: `RELAY_HOME`(기본 `~/.relay`), `RELAY_PORT`(기본 4747). 셸 환경변수가 항상 이긴다. [.env.example](.env.example) 참조 |
| `127.0.0.1:4747` | 데몬 API와 콘솔 (기본 포트) |

## 기여

먼저 [CONTRIBUTING.md](CONTRIBUTING.md)를 읽어주세요. 지금 레버리지가 가장 높은 기여:

- **하네스 어댑터**: 다른 코딩 에이전트(Gemini CLI, Qwen Code, 로컬 모델)용으로 중립 번들 위에 동사(`session`, `setup`, `models`, `commands`, `info`, 선택 `serve` — 상주 세션)를 구현. [packages/system/harness](packages/system/harness)의 `claude-code`와 `codex` 어댑터가 레퍼런스이고 `kimi`와 `pi`가 최소형입니다. 각각 셸 스크립트 하나입니다.
- **Surface 레퍼런스**: view가 패키지 토큰으로 자기 에이전트의 동사와 기판 API를 부르는 계약을 보여주는 예제 화면.
- **채널 어댑터** (Telegram, 이메일, 웹 위젯): 외부 신원을 principal로 매핑해 `RELAY_API`로 착신.
- **서비스 레시피**: 주요 SaaS용으로 작동하는 `url` 서비스 선언(auth, verify) 모음.
- **적합성 검사 확장**: `relay harness-check`가 판정하는 하네스·채널 계약 체크의 확장.
- **문서와 번역.**

보안 문제는 공개 이슈가 아니라 [SECURITY.md](SECURITY.md)로 보내주세요.

## 라이선스

[MIT](LICENSE).

[RelayAX](https://relayax.com)가 만듭니다.
