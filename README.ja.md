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
| Surfaces | パッケージが人と接する面。中心は `view`:パッケージが同梱するウェブ UI で、インストールがビルドし、デーモンが `/pkg/<名前>/view/` でホストし、パッケージトークンで自分のエージェントの動詞につながる。`chat`(直接対話)と `channels`(Discord、Slack などのアダプタ)は追加の扉。 |
| Harness | パッケージに同梱され、エージェントを実行するアダプタ。システムパッケージには Claude Code、Codex、Kimi、Pi のアダプタが同梱。動詞は `session`、`setup`、`models`、`commands`、`info`(任意で `login`、および `serve` — ターンごとにプロセスを起こさず stdin でターンを受け取る常駐セッション)。契約適合性は `relay harness-check` が判定し、契約の全文は [docs/harness-protocol.md](docs/harness-protocol.md) にあります。 |
| Agents | ペルソナ(`AGENT.md`)にスキル、スラッシュコマンド、サブエージェントへの dispatch。harness へは中立バンドルとして渡され、ネイティブ形式への翻訳はすべてアダプタの責務。`default: true` がランディングエージェント。 |
| Scripts | 動詞。`scripts/<名前>.ts` が `async (input, ctx) => JSON` をデフォルトエクスポート。 |
| Services | 形は 3 つだけ。`source`(自分の身体、コンテナまたはプロセス)、`url`(リモート MCP エンドポイント、資格情報はここだけに付く)、`dir`(ファイル資源)。 |
| Connector | 身体のないコネクタ——動詞が外部 REST API を直接呼ぶパッケージ。トップレベル `auth` は資格情報の形だけを宣言し、値は vault に置かれ、動詞が呼び出し時に `ctx.credential()` で取り出す。`url` サービスとは同時宣言不可。 |
| Storage | `storage.buckets`——ファイルバケットのファサード。個人基板は判定のみ、執行は組織基板の責務。サービスの `disk` とは別の軸。 |
| Triggers | cron またはイベント。プロンプトでエージェントを起こすか、スクリプトを headless で実行。`delivery: <チャネル>:<会話キー>` はその会話の slot でターンを回し、返信をチャネルアダプタから送出する。 |
| Missions | パッケージが他のパッケージに提供する質疑応答能力。 |
| Edges | 他パッケージの tools や mission への依存宣言。宣言は申請であり、有効化は承認。 |
| Workspace | パッケージのフォルダ承認。セッションの cwd で、インストール時に決まり(デフォルト `~/Relay/<名前>`)台帳に残る。 |
| Hooks | セッションの柵。`hooks.deny` がセッションのツール呼び出しが触れてはならないパスを宣言し、アダプタがネイティブフックへ翻訳する。基板は自分の家(`~/.relay`)を常にマージする。 |
| Grants | 台帳に残る承認。承認は宣言を超えられない。 |

## クイックスタート

要件:Node.js 22.6 以上(ランナーが `--experimental-strip-types` を使用)、同梱 harness を使うにはログイン済みの [Claude Code](https://claude.com/claude-code) CLI。macOS では資格情報は Keychain に保存され、それ以外の環境では `0600` のファイル vault を使います。

```sh
git clone https://github.com/relayax/relayagent.git
cd relayagent
npm install
alias relay="node --experimental-strip-types runner/relay.ts"

relay validate packages/system        # マニフェストを判定
relay install packages/system --ring0 --workspace ~   # 管理シェルを ring-0 で、ホームフォルダを workspace として承認
relay daemon                          # API、サービス、トリガー、コンソール
```

デーモンは `http://127.0.0.1:4747` で待ち受けます(ポートは `RELAY_PORT` で変更)。コンソールは `/pkg/system/view/`、オーサリング playground は `/pkg/system/view/playground.html`。このコンソール自体が system パッケージの view です。基板の上で動く最初のエージェントソフトウェアというわけです。

基板と話す:

```sh
relay run system                      # 対話セッション
relay run system "何がインストールされてる?"  # ワンショット実行
```

システムエージェントに新しいパッケージを頼むと、`agent-builder` サブエージェントが引き継ぎ、文法を読み、編集レイヤー(draft)にスキャフォールドし、`draft-validate` で判定してから `draft-publish` で発行します。インストール済みパッケージは実行中のバイナリなので直接編集しません。編集はすべて git 履歴を持つ draft に積まれ、判定を通過したスナップショットだけがリリースとして実行本になります。GUI で編集するにはコンソールからスタジオ(`/studio`)を開いてください。同じ draft、同じ diff、同じ発行ゲートを共有します。

## CLI

```
relay daemon                          基板を起動(API、サービス、トリガー、コンソール)
relay install <dir> [--ring0] [--workspace dir]  パッケージをインストール(workspace = フォルダ承認)
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
6. **最小の足場。** セッションが立つのはインストール時に承認された workspace 一つだけ。フォルダがもう 1 つ必要なら `dir` サービスを宣言し、触れてはならないパスは `hooks.deny` で塞ぐ。基板の家(`~/.relay`)はすべてのセッションに対して常に閉じている。

この六つの原則の根には、一つの前提があります:**すべてはエージェントパッケージとして表現できる。**

## ディスク上の状態

| パス | 用途 |
| --- | --- |
| `~/.relay/ledger.json` | インストール済みパッケージと承認の台帳 |
| `~/.relay/sessions/` | パッケージごとのセッションスロット |
| `~/.relay/drafts/<名前>/` | 編集レイヤー: git 履歴を持つ作業コピー(スタジオと agent-builder がここに書く) |
| `~/.relay/releases/<名前>/<バージョン>/` | 発行スナップショット: 台帳の path がこのいずれかを指す(ロールバック = 付け替え) |
| `~/.relay/logs/*.jsonl` | イベントログ |
| `~/.relay/vault.json` | Keychain がない場合の資格情報フォールバック |
| `~/Relay/` | 見える地面:デフォルト workspace(`~/Relay/<名前>`) |
| `~/Relay/.stage/` | チャットとセッションの間のファイル交換ステージ |
| `.env`(チェックアウト直下) | インスタンス設定:`RELAY_HOME`(デフォルト `~/.relay`)、`RELAY_PORT`(デフォルト 4747)。シェルの環境変数が常に優先。[.env.example](.env.example) 参照 |
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
