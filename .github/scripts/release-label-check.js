// release-label-check.yml と ci.yml から actions/github-script で呼ぶ。
// 作業場所には、PR の先頭をすべての履歴（ほかのブランチも）つきで取ってある。
// ルールセットで「マージ先の最新を取り込んでから」スカッシュでマージするので、マージできるときは PR の先頭の中身が
// マージ後の中身と同じになる。そのため、マージ後の VERSION は PR の先頭、マージ前の VERSION はマージ先との分かれ目から読む。
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const { checkReleaseLabels, findAffectedProducts, parseVersionFile } = require('./release-labels.js');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

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
  const labels = JSON.parse(env.LABELS);
  const versionFile = fs.readFileSync('VERSION', 'utf8');
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
    baseVersionFile: git('show', `${env.BASE_SHA}:VERSION`),
    branches: git('for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin/release/').split('\n').filter(Boolean),
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
