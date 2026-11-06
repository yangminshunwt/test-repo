// release-label-check.yml から actions/github-script で呼ぶ。
// PR の情報を GitHub から集めて checkReleaseLabels に渡し、結果をジョブに反映する。
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const { listReleaseBranches } = require('./github-helpers.js');
const { checkReleaseLabels, findAffectedProducts, parseVersionFile } = require('./release-labels.js');

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;
  // イベントの後にマージ先が変わっていても今のマージ先で判定するため、前のステップで取り直したマージ先を使う
  const baseBranch = process.env.BASE_REF;

  // イベントの後に付け外しされたラベルも含めるため、今のラベルを取り直す。
  const labelObjects = await github.paginate(github.rest.issues.listLabelsOnIssue, {
    owner,
    repo,
    issue_number: pr.number,
    per_page: 100,
  });
  const labels = labelObjects.map((label) => label.name);
  const archivedLabels = labelObjects.filter((label) => label.archived_at).map((label) => label.name);

  // チェックアウトされているのは PR をマージした結果のコミットで、その第 1 親がマージ前のマージ先になる。
  const versionFile = fs.readFileSync('VERSION', 'utf8');
  // マージ先に VERSION がない（手で作ったブランチなど）ときは、空とみなす
  let baseVersionFile = '';
  try {
    baseVersionFile = execFileSync('git', ['show', 'HEAD^1:VERSION'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    core.info('マージ先に VERSION がないので、空とみなします。');
  }
  const products = Object.keys(parseVersionFile(versionFile));

  // paths-filter の出力（当たったフィルタの名前の JSON 配列と、all・listed に当たったファイルの数）
  const affected = findAffectedProducts({
    matched: JSON.parse(process.env.AFFECTED_PRODUCTS || '[]'),
    products,
    allFileCount: Number.parseInt(process.env.ALL_FILE_COUNT, 10),
    listedFileCount: Number.parseInt(process.env.LISTED_FILE_COUNT, 10),
  });

  const branches = await listReleaseBranches(github, context.repo);

  const { errors, warnings } = checkReleaseLabels({
    baseBranch,
    labels,
    affectedProducts: affected.products,
    versionFile,
    baseVersionFile,
    branches,
    archivedLabels,
  });
  if (affected.reason) warnings.unshift(affected.reason);

  await core.summary
    .addHeading('リリースラベルのチェック', 3)
    .addTable([
      [{ data: '項目', header: true }, { data: '内容', header: true }],
      ['マージ先', baseBranch],
      ['影響する製品', affected.products.join('、') || '（なし）'],
      ['ラベル', labels.join('、') || '（なし）'],
      ['結果', errors.length === 0 ? 'OK' : `NG（${errors.length} 件）`],
    ])
    .addList([...errors, ...warnings])
    .write();

  for (const warning of warnings) core.warning(warning);
  for (const error of errors) core.error(error);
  if (errors.length > 0) {
    core.setFailed(`リリースラベルのルールを満たしていません（${errors.length} 件）。`);
  }
};
