<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" width="220" alt="RelayAgent" />
  </picture>
</p>

<h1 align="center">RelayAgent</h1>

<p align="center"><b>人とエージェントが協働するための決定的な層。</b></p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.6-5FA04E" alt="Node.js 22.6+" />
  <img src="https://img.shields.io/badge/status-seed-8B5CF6" alt="status: seed" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
</p>

RelayAgent は、自分の画面を携えて出荷されるエージェントパッケージのための個人基板(substrate)です。

エージェントは確率的ですが、協働はそうではありません。今日のエージェントランタイムはどれもチャット窓を一つ渡すだけで、そこには人が覗き込み、検証し、途中で引き継げる面がありません。ここではパッケージが、人が自分で操作できる画面と、再生できる動詞を一緒に積んで出荷し、その両方を一枚のマニフェストが判定します。だから同じ層が人にもエージェントにも同じように働きます。

1 パッケージ = 1 エージェント + その画面。インストールして得られるのはチャット窓ではなくソフトウェアです。view はエージェントと一体でバージョンが切られ、同じマニフェストで判定され、インストールがビルドし、デーモンが `/pkg/<名前>/view/` でホストします。チャットとチャネルは、そのソフトウェアへ入るいくつもの扉のひとつにすぎません。

1 つのパッケージは 1 つのディレクトリです。1 枚のマニフェスト(`relay.yaml`)がパッケージのすべてを宣言します。エージェント、動詞、画面、チャネル、サービス、トリガー、そして触れてはならない場所まで。基板はマニフェストの外のファイルを読まず、インストールは fail-loud で、資格情報は vault に置かれ、パッケージ間のあらゆる接続は監査可能な承認(grant)として台帳に残ります。

## コア概念

| 概念 | 意味 |
| --- | --- |
| パッケージ | `relay.yaml` を持つディレクトリ。マニフェストが構造とパスの正本、ツリーが内容の正本。 |
| Surfaces | パッケージが人と接する面。中心は `view`:パッケージが同梱するウェブ UI で、インストールがビルドし、デーモンが `/pkg/<名前>/view/` でホストし、パッケージトークンで自分のエージェントの動詞につながる。`channels`(Discord、Slack などのアダプタ)は追加の扉——チャネルは必要な資格情報の*形*を宣言し(`credential.fields`)、コンソールがその宣言から入力欄を描く(人が JSON を手で組み立てない)。`components` は**自己完結した ESM バンドル**(スタイルもその中に入る)をエクスポートし、他パッケージの画面が実行時にマウントする:基盤がバンドルをアドレスで配信し、消費側のドキュメントに import map を差し込むため、消費側は `import { mount } from "<提供元の名前>"` と書くだけでアドレスを組み立てない。React で書いても同じ——React はバンドルの中に入るので、消費側にフレームワークもビルドも要らない。 |
| Harness | パッケージのエージェントを実行するアダプタ。**アダプタは共有であり、パッケージ所属ではありません**: コンソールパッケージが Claude Code、Codex、Kimi、Pi を同梱し、基盤がそれをプールへ展開して全パッケージが候補として見ます — `variants` 未宣言 = プール全体。同梱はプールにない harness を連れてくるための道です。絞るときは `harness.requires` に **harness 名ではなく能力**を書きます(そうすれば施錠の理由が宣言に残り、別の harness がその能力を実装すれば再び開きます)。作者の既定は `harness.prefers`、実際に試した組み合わせは `harness.verified` に記します。資格情報は `llm/<provider>` に座り、パッケージ間で共有され、接続画面がそれを繋ぐ場所です。動詞は `session`、`setup`、`models`、`commands`、`info`(任意で `login`、および `serve` — ターンごとにプロセスを起こさず stdin でターンを受け取る常駐セッション)。契約適合性は `relay harness-check` が判定し、契約の全文は [docs/harness-protocol.md](docs/harness-protocol.md) にあります。variant が駆動する CLI は `requires.binaries` に宣言します — `manager`+`package` のレシピがあれば、欠けている場合に基盤が自分でインストールし(`~/.relay/bin/<pkg>/`、PATH の先頭)、variant の `binary: <name>` はその項目への参照なので、壊れたホストインストールも setup 失敗時に基盤のコピーへ置き換えられます。 |
| Agents | ペルソナ(`AGENT.md`)にスキル、スラッシュコマンド、サブエージェントへの dispatch、そして任意の `greeting`——空の対話の最初の一行で、扉ではなく話す側に属する。harness へは中立バンドルとして渡され、ネイティブ形式への翻訳はすべてアダプタの責務。`default: true` がランディングエージェント——エージェントを宣言したパッケージはランディングが定まらなければならず(このフラグ、またはパッケージ短縮名と同じエージェント)、さもなければインストールが拒否する。セッションはペルソナの上に立つので、`agents[]` の外の名前でターンが開くことはない。直接対話は宣言しない——エージェントがあって `view` がなければ `/pkg/<名前>/view/` に全画面の対話が無償で立つ。 |
| Scripts | 動詞。`scripts/<名前>.ts` が `async (input, ctx) => JSON` をデフォルトエクスポート。`scripts.get` は `GET` にも答える動詞を指名する——OAuth のリダイレクト、Webhook の検証チャレンジ、人が開くリンク。クエリ文字列がそのまま入力で、文字列を返せばそれが本文のすべてだ。既定ではなく宣言なのは、その扉には CSRF 判定が読む `Origin` が無いからだ——著者が名前を書いた場所でだけ開き、同意書には入ってくる扉として並ぶ。 |
| Services | 形は 4 つ。`source`(自分の身体、コンテナまたはプロセス)、`url`(リモート MCP エンドポイント)、`api`(リモート REST ベース)、`dir`(基盤が扉として立てるフォルダ)。資格情報は外へ出る 2 つ(`url`・`api`)にのみ付く。`dir` はパスではなく名前で届く——動詞は `ctx.service(<名前>).call("list"|"read"|"write"|"remove", …)` で使い、セッションはフォルダに直接触れない——それを包む動詞を通してのみ届く。宣言したパスはローカルの既定バインディングで、インストール承認が差し替え、組織基盤は同じ名前を自分のボリューム座標へ解決する。資格情報は入力欄の形(`auth.fields`——チャネルの `credential.fields` と同じ欄の語彙で、`Authorization` に出るトークン欄ひとつだけに `header: true`)、必須かどうか(`auth.required`、未宣言 = true。false なら無くても動き、その機能だけが止まる)、取得先の案内(`auth.help`)を宣言する。oauth 資格情報にも欄がある——ログインが尋ねない値(アカウント番号・保管庫の座標)の居場所で、認可が作ったバンドルの中に一緒に座る。`auth.accounts: true` は一つのサービスを複数アカウントで使うという宣言だ:vault 座標が `<パッケージ>/<サービス>@<アカウント>` になり、動詞は `ctx.service(<名前>).account(<アカウント>)` で選び `.accounts()` で列挙する。選ばれていないハンドルは代わりに選んだりせず、理由を添えて止まる。コンソールの接続画面(`/connect`)がこの宣言から全パッケージの外向き資格情報を描き、動詞は秘密を持たない——`ctx.service(<名前>).connected()` で有無を尋ね、`.fields()` で秘密でない欄だけを読む。 |
| Connector | 身体のないコネクタ——動詞が外部 REST API を呼ぶパッケージ。`api` サービスが REST ベースと `auth` の形を宣言し、値は vault の `<パッケージ>/<サービス>` に置かれる。基板が呼び出しごとに付与するため、動詞が資格情報を手に持つことはなく、宣言した base の外へも出られない。`auth.scheme` は `Authorization` の接頭辞を定める(例:Unsplash の `Client-ID`)——未宣言なら `Bearer`。`auth.inject` は資格情報をヘッダの外へ移す——トークンをパラメータで受け取る API のために `{query: <名前>}` または `{form: <名前>}`。`bases` は一つの提供者が散らばらせた別ホスト(別ドメインに住むトークン交換)を宣言し、それらも同じ接頭辞判定を通るので、同意書は資格情報が届く先をすべて名指しする。 |
| Triggers | cron またはイベント。プロンプトでエージェントを起こすか、スクリプトを headless で実行。`delivery: <チャネル>:<会話キー>` はその会話の slot でターンを回し、返信をチャネルアダプタから送出する。 |
| Missions | パッケージが他のパッケージに提供する質疑応答能力。 |
| Edges | 他パッケージの tools・mission・components への依存宣言。宣言は申請であり、有効化は承認——components はインストールが edge を解決した時点で承認が記録され、実行点は基盤が消費側の画面に差し込む import map である。`agent_access`(tools 形のみ、既定 `scripts-only`)は消費側エージェントが触れるものを定める——`scripts-only` なら edge ツールは常に提供側の動詞、`full` なら提供側が `services[].url.tools` に宣言したリモート MCP ツールも raw で開かれ、開示書が raw と記す。 |
| Workspace | パッケージのフォルダ承認。セッションの cwd で、インストール時に決まり(デフォルト `~/Relay/<名前>`)台帳に残る。自分の view は `GET /pkg/<名前>/workspace/<パス>` で読む——読み取り専用、`dir` の扉と同じ隔離、リクエストごとに再検証。 |
| Grants | 台帳に残る承認。承認は宣言を超えられない。 |

## クイックスタート

要件:Node.js 22.6 以上(ランナーが `--experimental-strip-types` を使用)、同梱 harness を使うにはログイン済みの [Claude Code](https://claude.com/claude-code) CLI。macOS では資格情報は Keychain に保存され、それ以外の環境では `0600` のファイル vault を使います。

```sh
git clone https://github.com/relayax/relayagent.git
cd relayagent
npm install
alias relay="node --experimental-strip-types runner/cli.ts"

relay validate packages/system        # マニフェストを判定
relay install packages/system --ring0   # 管理シェルを ring-0 で
relay daemon                          # API、サービス、トリガー、コンソール
```

デーモンはデフォルトで `http://127.0.0.1:4747` を待ち受け(`RELAY_PORT` で別のポートを選べます)、自分のポートを `RELAY_HOME/run/daemon.port` に書きます。CLI はその記録に従うので、チェックアウトはホームだけ知っていれば済みます。コンソールは `/pkg/system/view/`、オーサリング playground は `/pkg/system/view/playground.html`。このコンソール自体が system パッケージの view です。基板の上で動く最初のエージェントソフトウェアというわけです。

基板と話す:

```sh
relay run system                      # 対話セッション
relay run system "何がインストールされてる?"  # ワンショット実行
```

システムエージェントに新しいパッケージを頼むと、`agent-builder` サブエージェントが引き継ぎ、文法を読み、編集レイヤー(draft)にスキャフォールドし、`draft-validate` で判定してから `draft-publish` で発行します。インストール済みパッケージは実行中のバイナリなので直接編集しません。編集はすべて git 履歴を持つ draft に積まれ、判定を通過したスナップショットだけがリリースとして実行本になります。GUI で編集するにはコンソールからスタジオ(`/studio`)を開いてください。同じ draft、同じ diff、同じ発行ゲートを共有します。

## CLI

```
relay daemon                          基板を起動(API、サービス、トリガー、コンソール)
relay install <dir> [--ring0] [--workspace <パス>]  パッケージをインストール(workspace = フォルダ承認)
relay ls | rm <名前>                   一覧 | 削除
relay validate <dir>                  マニフェストを判定
relay build <パッケージ>                surfaces.view.out を再ビルド
relay run <パッケージ> [プロンプト]      セッション(プロンプトなしで対話モード)
relay harness <パッケージ> [名前]       harness variant の一覧・切替
relay harness-check <パッケージ>        harness 契約の適合性を判定
relay login <パッケージ> [--token]      harness ログイン(login 動詞対応時)
relay model <パッケージ> [モデル]        モデルの表示・設定
relay effort <パッケージ> [強度|off]    推論強度(effort capability を持つアダプタのみ反映)
relay connect <パッケージ> <サービス>    資格情報を貼り付け(vault / Keychain)
relay grant <consumer> <provider> --tools a,b | --mission m
relay suite ls | set <名前> --members a,b [--hub h] | rm <名前>   スイート(サイドバーのフォルダ)
relay suite pack <名前> [--out f] | import <f.relaypackages>    スイート封筒を焼く | 受け取る
```

## パッケージの解剖

```
my-package/
  relay.yaml                        BOM:構造とパス
  assets/icon.svg
  agents/<name>/AGENT.md            ペルソナ
  agents/<name>/skills/<s>/SKILL.md スキル
  agents/<name>/commands/<c>.md     スラッシュコマンド
  scripts/<verb>.ts                 デフォルトエクスポート:async (input, ctx) => JSON
  surfaces/view/                    このパッケージの画面(`out` 宣言時はインストールがビルド)
  channels/<name>/                  チャネルアダプタ(discord、slack、...)
  harness/<name>/                   実行アダプタ、パッケージに同梱
  services/<name>/                  source サービス(コンテナまたはプロセス)
```

文法は注釈付き JSON Schema の [relay.manifest.yaml](relay.manifest.yaml) です。完全なサンプルマニフェストはリポジトリ直下の [relay.yaml](relay.yaml)。管理シェル自体も 1 つのパッケージです:[packages/system](packages/system)。

## 設計原則

1. **マニフェストが BOM。** `relay.yaml` が構造とパスを、ツリーが内容を所有する。マニフェストから到達できないファイルは、基板にとって存在しない。
2. **Fail-loud。** 宣言と実体の不一致は判定とインストールを失敗させる。警告はなく、判定だけがある。
3. **宣言は上限、承認は有効化。** マニフェストの `edges` と `dir` サービスは申請。有効化はインストール時か `relay grant` で起き、台帳に残り、宣言を決して超えられない。
4. **資格情報はツリーに住まない。** マニフェストは認証の形(`none`、`token`、`oauth`)だけを宣言する。値は vault に置かれる。macOS Keychain、なければ `0600` ファイルへフォールバック。
5. **Harness 中立なエージェント。** エージェントは中立バンドル(ペルソナ、スキル、コマンド、メタ)として届く。ネイティブ形式への翻訳はすべてアダプタの仕事なので、パッケージは特定の CLI に縛られない。
6. **最小の足場。** セッションが立つのはインストール時に承認された workspace 一つだけ。フォルダがもう 1 つ必要なら `dir` サービスを宣言する——そこへ届くのはパッケージの動詞だけで(`ctx.service`)、セッションは直接触れずパスも知らない。基板の家(`~/.relay`)はすべてのセッションに対して常に閉じており、`dir` としても開けない(インストールが拒否する)。

この六つの原則の根には、一つの前提があります:**すべてはエージェントパッケージとして表現できる。**

## ディスク上の状態

| パス | 用途 |
| --- | --- |
| `~/.relay/ledger.json` | インストール済みパッケージと承認の台帳 |
| `~/.relay/sessions/` | パッケージごとのセッションスロット |
| `~/.relay/releases/<名前>/<バージョン>/` | 発行スナップショット: 台帳の path がこのいずれかを指す(ロールバック = 付け替え) |
| `~/.relay/logs/*.jsonl` | イベントログ |
| `~/.relay/vault.json` | Keychain がない場合の資格情報フォールバック |
| `~/Relay/` | 見える地面:デフォルト workspace(`~/Relay/<名前>`) |
| `~/Relay/packages/<名前>/` | 編集レイヤー: git 履歴を持つ作業コピー(スタジオと agent-builder がここに書く)。オーサリングはこの製品の中心なので、人が開ける場所で行われる——動いている版は `releases/` に残り、手が届かない。 |
| `~/Relay/.stage/` | チャットとセッションの間のファイル交換ステージ |
| `.env`(チェックアウト直下) | インスタンス設定:`RELAY_HOME`(デフォルト `~/.relay`)、`RELAY_PORT`(ポートを*選ぶ*ときだけ — CLI は動いているデーモンに従う)。シェルの環境変数が常に優先。[.env.example](.env.example) 参照 |
| `~/.relay/run/daemon.{pid,port,runner}` | 動いているデーモンの pid・ポートと、それが起動した runner — 起動時に書き、CLI が従い、終了時に消す。別の runner からの起動は古いデーモンを引き継ぐ(アプリを更新すればデーモンも変わる) |
| `127.0.0.1:4747` | デーモン API とコンソール(デフォルトポート) |

## コントリビュート

まず [CONTRIBUTING.md](CONTRIBUTING.md) を読んでください。いまレバレッジが最も高い貢献:

- **Harness アダプタ**:他のコーディングエージェント(Gemini CLI、Qwen Code、ローカルモデル)向けに、中立バンドルの上で動詞(`session`、`setup`、`models`、`commands`、`info`、任意で `serve` — 常駐セッション)を実装する。[packages/system/harness](packages/system/harness) の `claude-code` と `codex` アダプタがリファレンスで、`kimi` と `pi` が最小形。それぞれ 1 枚のシェルスクリプト。
- **Surface リファレンス**:view がパッケージトークンで自分のエージェントの動詞と基板 API を呼ぶ契約を示す例。
- **チャネルアダプタ**(Telegram、メール、ウェブウィジェット):外部アイデンティティを principal にマッピングし、`RELAY_API` 経由でディスパッチ。
- **サービスレシピ**:主要 SaaS 向けに動作する `url` サービス宣言(auth、verify)の蓄積。
- **適合性チェックの拡張**:`relay harness-check` が判定する harness・チャネル契約チェックの拡張。
- **ドキュメントと翻訳。**

セキュリティの問題は公開 issue ではなく [SECURITY.md](SECURITY.md) へ。

## ライセンス

[MIT](LICENSE)。

[RelayAX](https://relayax.com) が開発しています。
