# 생성물 델타 — 우리가 손댄 곳 (fail-loud 목록)

`src/ui/*` 는 `npx shadcn@latest add <name>` 산출물이다. 원칙은 **손대지 않는다**이지만, 아래
세 파일은 의도적으로 고쳤다. `add --overwrite` 로 다시 받으면 이 델타가 **사라진다** — 되받은
직후 여기를 보고 다시 적용하고, 적용을 잊으면 typecheck/화면이 즉시 어긋나 드러난다
(어긋남을 가려주는 호환 shim 을 두지 않는 이유가 이것이다).

## 1. 밀도 — `button.tsx` · `input.tsx` · `select.tsx` · `table.tsx`

업무 화면은 한 화면에 들어가는 행 수가 곧 생산성이라 스톡보다 한 단계 촘촘하다.

| 파일 | 스톡 | 우리 값 |
|---|---|---|
| button.tsx | `default h-9` `sm h-8` `lg h-10` `icon size-9` `icon-sm size-8` `icon-lg size-10` | `h-8` `h-7`(+`text-xs`) `h-9` `size-8` `size-7` `size-9` |
| input.tsx | `h-9` | `h-8` |
| select.tsx | `data-[size=default]:h-9` `data-[size=sm]:h-8` | `h-8` / `h-7` |
| table.tsx | `TableHead h-10 px-2` · `TableCell p-2` | `h-9 px-3` + `text-xs uppercase tracking-wide text-muted-foreground` · `p-3` |

## 2. 상태 어휘 — `badge.tsx`

표·목록의 상태가 4종(진행·완료·경고·중립)이라 스톡 4변형만으로는 전부 회색이 된다.
`success` / `warning` / `info` / `muted` 를 추가하고, `destructive` 를 solid → soft
(`bg-destructive/10 text-destructive`)로 바꿨다 — 표 안에 칩이 여러 개 뜰 때 채워진 색은
데이터보다 칩이 먼저 읽힌다.

## 3. import 규약 — 전 파일 (받은 직후 1회)

CLI 는 `@/lib/utils`·`@/<name>` 별칭으로 쓴다. 그대로 두면 소비 앱(`transpilePackages`)에서
**그 앱의 별칭**으로 해석돼 깨진다. 받은 직후 이렇게 되돌린다:

```
@/lib/utils  →  @relay/relayjs      (cn 단일 소스)
@/<name>     →  ./<name>            (같은 디렉토리 형제)
@/hooks/<x>  →  ../hooks/<x>
```

## 제외한 컴포넌트

- **combobox** — base-ui 기반이라 `className` 이 `(state) => string` 함수로 온다. 우리 `cn` 은
  문자열 합성기라 그 함수를 조용히 버린다(타입도 안 맞고 동작도 틀린다). 콤보박스는 upstream
  정본 레시피대로 **Popover + Command** 로 짓는다(Radix 기반이라 정합).
