# test-repo

ブランチ運用ルールの自動化を試すための検証用リポジトリ。中身はすべてダミー。

- `VERSION`：そのブランチで開発中のバージョン（製品ごとに 1 行）
- `ProductA/`・`ProductB/`・`ProductC/`：製品ごとのコード
- `Shared/`：すべての製品で使うコード
- `SharedAB/`・`SharedAC/`：一部の製品（A と B、A と C）で使うコード

`ProductA/FAIL` または `ProductB/FAIL` があると、その製品のテストが失敗する。
change
