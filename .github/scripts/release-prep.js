// release-prep.yml から actions/github-script で呼ぶ処理。
'use strict';

const fs = require('fs');
const { planReleasePrep, setVersion } = require('./release-labels.js');

// リリースブランチと次のバージョンのリリースラベルを作り、作業場所の VERSION を次のバージョンに書き換える。
// やり直したときも続きから進められるよう、すでにあるブランチやラベルはそのまま使う。
async function prepare({ github, context, core }) {
  const repo = context.repo;
  if (context.ref !== 'refs/heads/main') {
    core.setFailed(`main ブランチで実行してください（今は ${context.ref}）。`);
    return;
  }
  const product = process.env.PRODUCT;
  // チェックアウトされているのは、実行した時点の main（context.sha）
  const versionFile = fs.readFileSync('VERSION', 'utf8');
  const plan = planReleasePrep({ versionFile, product, bump: process.env.BUMP });
  if (plan.errors.length > 0) {
    for (const error of plan.errors) core.error(error);
    core.setFailed('リリースの準備を始められませんでした。');
    return;
  }

  const results = [];
  try {
    await github.rest.git.createRef({ ...repo, ref: `refs/heads/${plan.releaseBranch}`, sha: context.sha });
    results.push(`${plan.releaseBranch} を作りました（${context.sha.slice(0, 7)} から）。`);
  } catch (error) {
    if (error.status !== 422) throw error;
    results.push(`${plan.releaseBranch} はすでにあるので、そのまま使います。`);
  }
  try {
    await github.rest.issues.createLabel({ ...repo, name: plan.nextLabel, color: '1d76db', description: 'Release label' });
    results.push(`ラベル ${plan.nextLabel} を作りました。`);
  } catch (error) {
    if (error.status !== 422) throw error;
    results.push(`ラベル ${plan.nextLabel} はすでにあります。`);
  }
  fs.writeFileSync('VERSION', setVersion(versionFile, product, plan.nextVersion));

  for (const result of results) core.info(result);
  await core.summary.addHeading(`${product} のリリースの準備（${plan.currentVersion} → ${plan.nextVersion}）`, 3).addList(results).write();
  core.setOutput('current_version', plan.currentVersion);
  core.setOutput('next_version', plan.nextVersion);
  core.setOutput('release_branch', plan.releaseBranch);
  core.setOutput('next_label', plan.nextLabel);
}

module.exports = { prepare };
