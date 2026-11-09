// release-label-check.yml と ci.yml から actions/github-script で呼ぶ。
// 作業場所には、PR の先頭をすべての履歴（ほかのブランチも）つきで取ってある。
// マージ後の中身は、PR の先頭と今のマージ先の先頭を手元でマージして作る（GitHub がテスト用のマージコミットを作るのを待たない）。
// ルールセットで「マージ先の最新を取り込んでから」マージするので、マージできるときは PR の先頭の中身と同じになる。
'use strict';

const { git, localReleaseBranches } = require('./github-helpers.js');
const { checkReleaseLabels, findAffectedProducts, parseVersionFile } = require('./release-labels.js');

// PR の今のマージ先とラベル（イベントの後に変わっていても今の状態で判定するため、API で取り直す）と、
// PR の先頭とマージ先との分かれ目（paths-filter が変更を探す起点）を出力する。
async function findBase({ github, context, core }) {
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: context.payload.pull_request.number });
  core.setOutput('base_ref', pr.base.ref);
  core.setOutput('base_sha', git('merge-base', 'HEAD', `refs/remotes/origin/${pr.base.ref}`));
  core.setOutput('labels', JSON.stringify(pr.labels.map((label) => label.name)));
}

async function check({ core }) {
  const env = process.env;
  const baseBranch = env.BASE_REF;
  const base = `refs/remotes/origin/${baseBranch}`;
  const labels = JSON.parse(env.LABELS);
  let merged;
  try {
    merged = git('merge-tree', '--write-tree', base, 'HEAD').split('\n')[0];
  } catch {
    return core.setFailed(`${baseBranch} とコンフリクトしています。解消して push すると、もう一度チェックします。`);
  }
  const versionFile = git('show', `${merged}:VERSION`);
  const affected = findAffectedProducts({
    matched: JSON.parse(env.AFFECTED_PRODUCTS),
    products: Object.keys(parseVersionFile(versionFile)),
    allFileCount: Number(env.ALL_FILE_COUNT),
    listedFileCount: Number(env.LISTED_FILE_COUNT),
  });
  const { errors } = checkReleaseLabels({
    baseBranch,
    labels,
    affectedProducts: affected.products,
    versionFile,
    baseVersionFile: git('show', `${base}:VERSION`),
    branches: localReleaseBranches().map(([name]) => name),
  });

  await core.summary
    .addHeading('リリースラベルのチェック', 3)
    .addTable([
      [{ data: '項目', header: true }, { data: '内容', header: true }],
      ['マージ先', baseBranch],
      ['影響する製品', affected.products.join('、') || '（なし）'],
      ['ラベル', labels.join('、') || '（なし）'],
      ['結果', errors.length === 0 ? 'OK' : `NG（${errors.length} 件）`],
    ])
    .addList(affected.reason ? [affected.reason, ...errors] : errors)
    .write();
  if (affected.reason) core.warning(affected.reason);
  for (const error of errors) core.error(error);
  if (errors.length > 0) core.setFailed(`リリースラベルのルールを満たしていません（${errors.length} 件）。`);
}

module.exports = { findBase, check };
