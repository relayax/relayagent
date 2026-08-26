# 패키지 화면 하나 — 콘솔 상세와 스튜디오를 합친다

2026-08-26 · 앞선 문서: `2026-08-26-package-describe-design.md` (1층 "읽기", 완료)

## 왜

콘솔 상세(설치본)와 스튜디오(draft)는 같은 패키지를 두 화면에서 보여준다. 분리의 실제 축은
live/draft 였지 읽기/쓰기가 아니었고, 비개발자에게는 "같은 게 왜 두 군데 있지"로 보인다.
1층(설명서)이 콘솔에 들어갔으니, 이제 스튜디오의 나머지 두 층을 같은 화면으로 옮긴다.

## 결과 모습

`/?p=<이름>&face=detail` 하나가 패키지 화면이다. 세 층:

```
머리   아이콘 · 이름 · 버전 · [상주|상세] · 화면 열기
       ── draft 가 열려 있으면 ──  ↶ ↷ · ＋ 만들기 · 검사 · 기록 · [적용] · ⋯(이전 판으로 / 작업 사본 버리기)
       ── 아니면 ──                고치기
몸     소개 한 줄 + 칩 (수정 n건 · 아직 적용 안 됨 / 변경 없음)
       설명서 줄들 (1층) — 어느 줄이든 누르면 그 줄 아래로 펼쳐진다 (2층)
         펼침 = 왼쪽 그 섹션의 기존 폼(SectionView) · 오른쪽 결과면(Preview, 재료별)
         폼의 파일 카드를 누르면 몸 전체가 에디터가 된다 (3층) — 상단에 "◀ 돌아가기 · 경로 · 삭제"
       콘솔 띠 (검사 결과·기록·적용 로그, 접힘)
       하단: 데이터 폴더 열기 · 제거
```

- **live 냐 draft 냐**: draft 가 있으면 draft 를 보여주고 칩으로 그 사실을 말한다. 없으면 설치본.
  줄을 누르거나 [고치기]·[만들기]를 누르면 draft 가 열린다(설치본 사본). 콘솔 목록(사이드바·설정
  지도)은 그대로 설치본이다.
- **설치 안 된 draft** (만드는 중)도 같은 주소로 연다 — 장부에 없으면 draft 목록에서 찾아
  매니페스트를 draft 에서 읽는다. 머리의 버전은 "미발행".
- **새 패키지**: `/?new=1` 에 마법사(스튜디오의 Wizard 그대로), 만들면 `/?p=<이름>&face=detail`.
- `/studio/` 는 리다이렉트만 남는다: `?pkg=x&sec=&item=&file=` → `/?p=x&face=detail&sec=&item=&file=`,
  `?new=1` → `/?new=1`, 나머지 → `/`.
- 사이드바(기판 `runner/runtime/shell.ts`): "패키지 만들기" → `?new=1`, 초안 각각 →
  `?p=<이름>&face=detail`, "만드는 중 N" → 셸 홈(초안 띠가 거기 있다). 홈의 "스튜디오에서 이어서
  만들기" 링크는 없앤다 — 이름마다 이미 문이 있다.

## 설명서 줄 (1층) 확장

모든 선언 섹션이 줄 하나씩 갖는다 — 2층으로 가는 문이 줄이므로, 줄이 없는 섹션은 고칠 수 없다.

| key | 질문 | sec |
|---|---|---|
| identity | 이름과 버전 | identity |
| verbs | 시킬 수 있는 일 | scripts |
| when | 스스로 움직이는 때 | triggers |
| dirs | 손대는 폴더 | services |
| talk | 대화하는 곳 (이 화면 · 에이전트들) | agents |
| faces | 화면과 채널 (view · 끼울 부품 · 채널 이름) | surfaces |
| links | 바깥 연결 | edges |
| missions | 맡길 수 있는 일 | missions |
| engine | 동작 엔진 | harness |
| needs | 필요한 것 | requires |
| (고급, 접힘) host | 기판 브리지 캡 | host_methods |
| (고급) org | 조직 설정 | org |
| (고급) files | 기타 파일 n | files |

draft 가 열려 있으면 빈 줄도 전부 보인다("아직 없음" — 누르면 거기서 만든다). 설치본만 볼 때는
지금처럼 engine·needs·고급 줄은 비면 생략.

## 구조

### 1단계 — 스튜디오 기계를 훅으로 (UI 무변화)

`app/studio/page.tsx` (842줄) 의 상태와 동작 전부를 `lib/useDraft.ts` 로 옮긴다:

```ts
export function useDraft(pkg: string | null, view: { sec, item, file }, nav: (q) => void): Draft
```

`Draft` 가 주는 것: `status · fatal · manifest · schema · buf · issues · verdicts · marks · log ·
conflict · agentBusy · undo/redo 길이 · effFile · rev · ctx(SectionCtx) · previewCtx(PreviewCtx)` 와
동작 `open() · refresh() · onEdit() · writeManifest() · stepHistory() · validate() · pack() ·
onPublished() · conflictReload() · conflictOverwrite() · deleteFile() · say() · seedHarness()`.
`fixTargetOf` 는 `lib/verdict.ts` 로. page.tsx 는 훅을 부르고 그리는 껍데기가 된다.
이 단계가 끝나면 스튜디오는 **그대로** 돈다 — 굽고 눈으로 확인한다.

새 훅의 한 가지 차이: `pkg` 가 있어도 **자동으로 draft 를 열지 않는다**. `open()` 을 불러야 연다.
스튜디오 page 는 진입 즉시 `open()` 을 부른다(지금과 같은 행동). 패키지 화면은 draft 가 이미
있을 때만 `open()` 을 부르고, 없으면 사용자가 줄·고치기·만들기를 눌렀을 때 부른다.

### 2단계 — 패키지 화면

- `components/DetailFace.tsx` (PkgPane 에서 분리): 설명서 + 펼침 + 에디터 + 콘솔 띠 + 하단.
  `useDraft` 를 쓴다. URL 의 `sec · item · file` 이 펼침·에디터의 정본(스튜디오 규약 그대로).
- `components/Describe.tsx`: 줄이 링크가 아니라 버튼이 된다. `expanded` 줄 아래에 `children`.
- `components/DraftActions.tsx`: 머리의 버튼 묶음 + 다이얼로그(StudioDialogs 재사용) + ⋯ 메뉴.
- `components/EditorPanel.tsx`: 돌아가기 줄 + 충돌 배너 + CodeEditor.
- `components/DraftConsole.tsx`: 스튜디오의 콘솔 띠 그대로.
- `app/page.tsx`: `?new=1` 이면 Wizard. `p` 가 장부에 없으면 draft 목록을 보고 draft 전용 Pkg 를
  합성한다(`workspace: ""`, `harness: null`, manifest 는 draft 의 것).
- `app/studio/page.tsx`: 리다이렉트만.
- 지우는 것: `DeclTree.tsx`, 스튜디오 셸 CSS(`.st-shell · .st-top · .st-body · .st-tree · .st-node …`).
  폼·파일 카드·콘솔 CSS(`.st-form · .st-field · .st-files · .st-console …`)는 남는다.
- `lib/describe.ts`: 위 표대로 줄 확장. `describe(m, ctx, { editing: boolean })`.
- 기판 `runner/runtime/shell.ts`: 링크 셋만 바뀐다.

### 에러 · 경계

- draft 열기 실패(`fatal`)는 몸 상단 배너. 줄은 설치본으로 남는다.
- 동시 편집 충돌은 지금 스튜디오와 같은 배너·두 처분.
- 설치 안 된 draft 는 "상주" 탭이 없고 "제거" 대신 "작업 사본 버리기"(⋯ 메뉴)만 있다.
- 제거 확인 문구는 그대로.

## 테스트

- `lib/describe.test.ts` — 새 줄들과 `editing` 플래그.
- 1단계 뒤 스튜디오, 2단계 뒤 패키지 화면을 각각 `relay build system` 으로 굽고 headless Chrome
  으로 찍어 본다: 설치본(system), 초안(만드는 중), 새 패키지 셋.
- `npm run validate · typecheck · test`.

## 이 문서 밖

동사 이름을 `meta.description` 으로 번역하는 것(콘솔이 동사 meta 를 받을 API 필요). 2층 폼 자체를
사람 말로 다시 쓰는 것 — 이번엔 기존 폼을 그대로 옮긴다.
