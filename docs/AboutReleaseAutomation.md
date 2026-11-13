# リリースの自動化

[CONTRIBUTING.md](./CONTRIBUTING.md) のルールを GitHub の上で守らせ、リリースの手順を進める自動化の説明。ルールそのものは CONTRIBUTING.md に書き、ここには自動化の前提、CONTRIBUTING.md に書いていない決まり、自動化ではできないことを書く。ルールセット（だれが何をできるか、マージキューの設定）は `.github/rulesets/README.md` に書いている。

## 全体

| ワークフロー | 動くとき | すること |
|---|---|---|
| CI（`ci.yml`） | PR、マージキュー | 変更が影響する製品のテストと、自動化のスクリプトのテストを動かし、結果を `ci` にまとめる |
| Release Label Check（`release-label-check.yml`） | `main` と `release/` で始まるブランチへの PR、マージキュー | リリースラベルの決まりを確かめる。VERSION を変える PR のラベルは変更後のバージョンにする |
| Version Check（`version-check.yml`） | `main` と `release/` で始まるブランチへの PR、マージキュー | main では降版の禁止とパッチ 0、release ではブランチ名との一致を確かめる。ラベルは使わない |
| Rerun Release Checks（`rerun-release-checks.yml`） | リリースブランチの作成・削除、保護ブランチの VERSION の変更 | ブランチの作成・削除では Release Label Check を、VERSION の変更では Version Check もやり直す |
| Cherry-Pick（`cherry-pick.yml`） | 保護ブランチへの PR のマージ、手で実行（`main`） | ラベルの範囲のほかのリリースブランチへ、cherry-pick の PR を作る |
| Normal Release Preparation（`normal-release-prep.yml`） | 手で実行（`main`） | `main` からリリースブランチを作り、`main` の VERSION を上げる PR を作る |
| Hotfix Release Preparation（`hotfix-release-prep.yml`） | 手で実行（`main`） | 製品の最新のリリースタグから修正フェーズのリリースブランチを作り、その VERSION を上げる PR を作る |
| Tag Creation（`release.yml`） | 手で実行（リリースブランチ） | rc：リリースブランチの先頭に rc タグを打つ。release：リリースしたコミットにリリースタグを打ち、リリースブランチを削除する |

ワークフローが呼ぶスクリプトは `.github/scripts` にある。GitHub に依存しない判断は `rules.ts` にまとめ、単体テスト（`*.test.ts`）で確かめる。

## 前提

- 製品名の元は VERSION（1 行 1 製品で `product-name/X.Y.Z`）。
- 変更が影響する製品は、`.github/product-paths.yml` のパスで決める。複数の製品で使うパスは、使う製品すべてに書く。どこにも書かれていないパスの変更は、すべての製品に影響するとみなす。`none` に書いたパス（VERSION、docs、.github など）は、どの製品にも影響しない（`ci.yml` を変えたときは、CI がすべての製品のテストを動かす）。ファイルの移動は、移動元と移動先の両方の変更として数える。
- 必須チェックは `release label check`、`version check`、`ci`。いずれも GitHub のテスト用マージコミット（マージキューではマージグループのコミット）を確かめる。比較基準の `base_sha` は、PR ではその第 1 親、キューではイベントの `base_sha` とし、差分と変更前の VERSION に共通で使う。テストのジョブは `ci` にまとめ、飛ばしたジョブは通った扱いにする。
- PR のマージ先、ラベル、今あるリリースブランチは、実行した時点の状態を読み直す。Release Label Check と Version Check は、再実行でも現在の `refs/pull/<PR 番号>/merge` を取得する。Release Label Check はその第 1 親との差分と両方の VERSION を、Version Check は両方の VERSION を調べる。マージキューでは、イベントの `base_sha` と合成済みコミットを比べる。人が出した PR のラベルは、自動化では変えない（ただし、cherry-pick のブランチ名の PR には、Cherry-Pick が元の PR のアーカイブされていないラベルと `cherry-pick` ラベルを付ける）。
- 自動化の GitHub App の秘密鍵は Environment `automation-app` の秘密 `AUTOMATION_APP_PRIVATE_KEY` に、Client ID は変数 `AUTOMATION_APP_CLIENT_ID` に置く。Environment は `main` と `release/**/*` でだけ使えるようにする（どちらもコードにはない設定）。App には Contents・Issues・Pull requests・Workflows の書き込みの権限が要り、ルールセットの例外にもする。
- 使うワークフローとスクリプト：Cherry-Pick と 2 つの Release Preparation は、`main` のもの。Tag Creation は、実行したリリースブランチのもの。Rerun Release Checks は、イベントが起きたブランチのもの（削除では `main`）。PR の CI・Release Label Check・Version Check のワークフローは、イベントのテスト用マージコミットのもの。CI は全ジョブでイベントの `github.sha` を取得し、コード・スクリプト・パス設定をそろえる。Release Label Check と Version Check のスクリプトは、検査するマージコミットから取る（再実行では現在のもの）。この 2 つのうち、パス設定を使うのは Release Label Check だけ。CI は PR の情報を API で読まない。Release Label Check は現在のマージ先とラベルを、Version Check は現在のマージ先を読む（マージキューではイベントのマージ先を使う）。

## 入るべきリリースと、入っているか

Normal Release Preparation と Tag Creation は、同じ定義を使う（`rules.ts` の `belongsTo`、`changes.ts`）。Cherry-Pick の PR を作る行き先は別に決める。

- 入るべきリリース：`main` かリリースブランチにマージした、リリースラベル `product-name/vX.Y.Z` の PR の変更は、その製品の X.Y.Z 以上の通常リリース（パッチが 0）に入るべき。修正フェーズ（パッチが 1 以上）は、その修正バージョンのラベルを明示したものだけ。旧ラベルだけでは、前のリリースで見送った変更を後続の修正バージョンに要求しない。リリースブランチにマージした PR は、そのブランチのバージョンまで。作業ブランチにマージした PR と、`cherry-pick` ラベルの PR は数えない。ブランチ名だけでは cherry-pick から除外しない。
- 入っているか：元の PR か、その cherry-pick の PR のマージコミットが祖先にあれば入っている。変更を当てても何も変わらない（同じ内容がもう入っている）ときも入っている。cherry-pick の PR は、ブランチ名 `cherry-pick-<元の PR の番号>-to-<行き先のブランチ>` だけで元の PR と結ぶ（別の名前で手で cherry-pick した PR は、中身が元の PR と違うと入っていないとみなされ、Tag Creation の rc が止まる）。
- 使い方：Normal Release Preparation は、作ったリリースブランチに入っていない変更の Cherry-Pick を実行する（作る間にマージされた PR のため）。Hotfix Release Preparation は正式なリリースタグから分岐し、過去の PR の cherry-pick は実行しない。Tag Creation は、入るべき変更が入っていなければ rc を打たず、release では書き出す。

## CONTRIBUTING.md に書いていない決まり

### リリースラベル

- `release/` で始まるがリリースブランチの形（`release/product-name/vX.Y.Z`）でないブランチへの PR と、スタックした PR の上の PR（スタックのいちばん下のマージ先で動く）は、Release Label Check を通らない。`release/` で始まる名前は、リリースブランチだけに使う。
- `main` への PR で、どの製品にも影響しない変更には、リリースラベルを付けない（付けると通らない）。
- リリースブランチへの PR には、どの製品にも影響しない変更でも、そのブランチの製品のリリースラベルが要る。ただし、`cherry-pick` ラベルの付いた PR は、元のラベルがアーカイブ済みで引き継げないため、リリースラベルがなくてもよい。
- `cherry-pick` ラベルの付いたリリースブランチへの PR は、元のリリースラベルのブランチが削除済みでもよく、他の製品のラベルも残してよい。ラベルの検査は行き先の製品に対して行い、バージョンの上限と VERSION のチェックは通常の PR と同じ。
- 形式に合わないラベルと、VERSION にない製品のラベルは、リリースラベルとみなさない（無視する）。
- VERSION を変える PR に、その製品のリリースラベルを付けるなら、変えた後のバージョンにする。
- マージ先とコンフリクトしている PR は、通らない。

### VERSION

- release への PR では、マージ後の VERSION の対象製品のバージョンを、ブランチ名のバージョンと一致させる。cherry-pick の PR にも適用する。
- `main` では、既存の製品の VERSION を下げない。上げるときはパッチを 0 にする。新しく追加した製品は対象外。
- `main` の VERSION を上げるために、変更前のバージョンのリリースブランチが存在する必要はない。Normal Release Preparation の実行順序は変わらず、先にリリースブランチを作ってから VERSION を上げる PR を作る。

### Cherry-Pick

- 行き先は、ラベルの製品とバージョン以上の、現在ある通常・修正リリースのブランチ。元の PR をリリースブランチにマージした場合は、その製品とバージョンまでに限定し、マージ先自身は除く。`cherry-pick` ラベルの PR は再び送らない。たとえば `main` にマージした `product-a/v1.3.0` の PR は、存在する `release/product-a/v1.3.1` にも候補の PR を作るが、旧ラベルだけではその hotfix の rc に必須の変更にはならない。
- コミットの選択は backport-action の `cherry_picking` の既定値 `auto` を使う。空変更の判定や既存の作業ブランチの扱いも action に任せる。
- cherry-pick の PR は自動化が作り、元の PR のアーカイブされていないラベルをすべて引き継ぐ。他の製品のラベルも残し、再び cherry-pick しないための `cherry-pick` ラベルを付ける。リリースラベルのバージョンは変えない。ラベルは backport-action の `add_labels` で付け、既存 PR の古いラベルは同期しない。元の PR の担当者を引き継ぎ、マージは人がする。
- GitHub はアーカイブ済みラベルを新しい PR に追加できないため、そのラベルは引き継がず、アーカイブも解除しない。元の PR のすべてのラベルがアーカイブ済みなら、`cherry-pick` ラベルだけを付ける。手で cherry-pick するときも同じ。
- コンフリクトしたときは、コンフリクトを含んだ draft の cherry-pick の PR を作り、解き方をその PR にコメントする（元の PR のコメントには、その PR へのリンクだけが出る。メンションはしない）。その PR でコンフリクトを解いてマージする。
- 失敗したときは、backport-action のコメントと Actions の実行の記録で確認する。追加の通知コメントや作者・マージした人へのメンションは出さない。一部の行き先で失敗したときも、ワークフローは失敗にする。手で cherry-pick するときは、`cherry-pick-<元の PR の番号>-to-<行き先のブランチ>` の名前で作業ブランチを作り、元の PR のアーカイブされていないラベルと `cherry-pick` ラベルを付けて PR を出す。リリースラベルのバージョンは変えない。原因を直したら、Actions の「Cherry-Pick」を `main` で、PR の番号を指定して実行し直してもよい（リリースブランチで実行すると、そのブランチの古いワークフローとスクリプトで動く。ほかのブランチでは job が始まらない）。
- 行き先のブランチがもうない（リリースして削除された）ときは、手での cherry-pick もやり直しも要らない（ブランチも作り直さない）。変更はそのリリースには入っていない。

### Normal Release Preparation と Hotfix Release Preparation

- 作るリリースブランチのバージョンは、Normal Release Preparation では、実行した時点の `main` の VERSION。Hotfix Release Preparation では、その製品の最新（バージョンがいちばん大きい）のリリースタグのパッチを 1 上げたもの。
- Normal Release Preparation は、`main` の VERSION の minor か major を上げる。
- 次のバージョンのリリースラベルと VERSION を上げる PR は、自動化が作る（PR の担当者は実行した人）。`main` への PR にはリリースラベルを付けず、修正フェーズのリリースブランチへの PR には、上げた後のバージョンのリリースラベルを付ける。
- VERSION を上げる PR をマージするまで、`main` への次のバージョンのラベルの PR は Release Label Check を、修正フェーズのリリースブランチへの PR（cherry-pick の PR も）は Version Check を通らない。マージすると、Rerun Release Checks が両方をやり直す。
- Hotfix Release Preparation は、最新のリリースタグからだけ作る（それより古いバージョンの修正フェーズのリリースブランチは、管理者が作る）。リリースしたバージョンのリリースブランチが残っているとき（Tag Creation の release が済んでいないとき）と、タグのコミットに `.github/scripts/changes.ts`（TypeScript 移行前は `changes.js`）がない（今の自動化を入れる前の）ときは作らない。
- Hotfix Release Preparation は、前のリリースで見送った変更を自動では取り込まない。修正フェーズに入れる変更は、その修正バージョンのリリースラベルを指定して PR を出す。
- 途中で止まったときは、Actions の Re-run で続きから進める（済んだことは重ねてしない）。Normal Release Preparation を Run workflow で実行し直すのは、`main` の VERSION を上げる PR をマージする前だけにする（マージした後だと、次のバージョンの準備が始まる）。VERSION を上げる PR がコンフリクトしたときは、同じ入力で実行し直すと、最新のマージ先の上に作り直す（PR に手で足したコミットは消える）。

### Tag Creation

- rc もリリースタグも、`main` の VERSION のその製品を、リリースブランチのバージョンより上げてから打つ。
- rc は、リリースブランチの先頭の VERSION がブランチのバージョンになり、入るべき変更がすべて入ってから打つ。
- リリースしたコミットは、release の commit に入力したコミット（リリースブランチの履歴にあり、VERSION がブランチのバージョンのもの）、なければ最後の rc。rc を打たずにリリースしたときは、commit の入力が要る。
- release は、リリースしたコミットより後のコミット、リリースブランチへの開いている PR、入るべきなのに入っていない変更を書き出してから、リリースブランチを削除する（書き出したものがあれば、実行は失敗で終わる）。これらの変更を後続の修正フェーズに自動では取り込まない。入れる変更を選び、その修正バージョンを指定して PR を出す。
- 実行中にリリースブランチの先頭が進んだら、削除しない。リリースタグがもうあれば打ち直さずに続きを進めるので、止まった release は実行し直してよい。
- release で、そのバージョンのリリースラベルをアーカイブする（ラベルを選ぶ画面に出なくなる）。

## 自動化ではできないこと・気をつけること

- 自動化の変更が効くとき：`main` で動くもの（Cherry-Pick、2 つの Release Preparation）への変更は、`main` にマージするとすぐ効く。リリースブランチで動くもの（Tag Creation、リリースブランチへの PR の CI・Release Label Check・Version Check、リリースブランチでの Rerun Release Checks）への変更は、そのあと `main` から作るリリースブランチから効く（修正フェーズのリリースブランチは、リリースタグの `.github` を使う）。`.github` だけを変える PR にはリリースラベルを付けないので、今あるリリースブランチには cherry-pick されない。必須チェックや入るべきリリースの定義を変えるときは、今あるリリースブランチとの食い違いに気をつける（要るなら、そのブランチにも PR で入れる）。
- 2 つの Release Preparation と Tag Creation は、実行した人を確かめない。Actions を実行できる人なら、App を通してリリースブランチとタグを作り、リリースブランチを削除できる。
- 2 つの Release Preparation と Tag Creation は、App のトークンを作ってから動く。秘密鍵がなければ、何も作らずに止まる。
- Cherry-Pick の行き先は、実行した時点で今あるリリースブランチだけ。あとで作ったブランチに入っていない変更の Cherry-Pick を実行するのは、Normal Release Preparation だけ。管理者が手で作ったリリースブランチでは、そのバージョンのリリースラベルと VERSION を上げる PR を手で作り、rc が書き出した PR ごとに Cherry-Pick を手で実行する。
- Rerun Release Checks は、最初の実行から 30 日を過ぎたチェックをやり直せない（GitHub の制限）。そのときは失敗して PR を書き出すので、その PR に push するか、ラベルを付け直す。
- `.github/product-paths.yml` のパスと製品の対応が実際の依存と合っているかと、`ci.yml` の製品のテストのジョブ（`ci` の `needs` も）が VERSION の製品とそろっているかは、確かめない（テストのジョブがない製品の変更は、テストなしで `ci` が通る）。

## 変えるとき

- 製品を足す・消すとき：VERSION、`.github/product-paths.yml`（製品のフィルタと `listed`）、2 つの Release Preparation の製品の選択肢、`ci.yml` の製品のテストのジョブ（`ci` の `needs` も）を、同じ PR で直す（`ci.yml` 以外は `products.test.ts` が確かめる）。
- 製品を足すときと、この自動化を入れるときは、`main` の VERSION の各製品のリリースラベル（`product-name/vX.Y.Z`）を手で作る（自動化が作るのは、2 つの Release Preparation が上げた後のバージョンのラベルだけ）。この自動化を入れるときに今あるリリースブランチには、`.github` を PR で入れ、そのバージョンのリリースラベルも手で作る（入れないと、そのブランチへの PR は必須チェックが出ずにマージできず、Tag Creation も実行できない）。
- 必須チェックとルールセットを変えるときは、`.github/rulesets/README.md` に従う。
- この自動化を入れるときに、`cherry-pick` ラベルも作っておく。

### TypeScript とローカル確認

- `cherry-pick.yml` に、準備、PR 作成、結果確認の順番を記す。PR 作成とラベル設定、空変更のスキップ、コンフリクト時の draft、結果のまとめは `korthout/backport-action` に任せる。action が成功扱いでも `was_successful` が true でなければ、最後のステップでワークフローを失敗にする。
- Cherry-Pick の `prepare` は、現在の PR とブランチを API で読み、ラベルのルールに従って行き先を選び、出力する。行き先があるときは、元の PR の未アーカイブラベルに `cherry-pick` を加え、action の `add_labels` に渡す。読み取り権限だけを使い、行き先がなければ App のトークンも作らない。
- 自動化の実装と単体テストは `.github/scripts/` の TypeScript に統一する。Cherry-Pick は `cherry-pick/workflow.ts` の `prepare` を YAML から呼び、行き先と付けるラベルを受け取る。
- 実行時は `actions/github-script` の Node 24 が TypeScript を直接読む。実行用の依存パッケージのインストールや JavaScript の生成は不要。`package.json` とロックファイルは型チェック用で、CI の `script test` でも型チェックを行う。
- リポジトリのルートで、Node 24 を使って次を実行する。GitHub を変更する回帰スクリプトは実行しない。

```sh
npm ci --prefix .github/scripts --ignore-scripts
npm run typecheck --prefix .github/scripts
node --test .github/scripts/*.test.ts
```
