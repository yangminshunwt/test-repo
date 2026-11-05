# test-repo

ブランチ運用ルールの自動化を試すための検証用リポジトリ。中身はすべてダミー。

- `VERSION`：そのブランチで開発中のバージョン（製品ごとに 1 行）
- `ProductA/`・`ProductB/`：製品ごとのコード
- `Shared/`：両方の製品で使うコード

`ProductA/FAIL` または `ProductB/FAIL` があると、その製品のテストが失敗する。
