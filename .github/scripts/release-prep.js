// release-prep.yml から actions/github-script で呼ぶ処理。
// 作業場所には、今の main をすべての履歴（ブランチとタグも）つきで取ってある。
'use strict';

const fs = require('fs');
const { createReleaseBranch, createReleaseLabel, git, report } = require('./github-helpers.js');
const { parseVersionFile, planReleasePrep, setVersion } = require('./release-labels.js');

// 準備するバージョンは、実行を始めた時点（Run workflow を押した時点。Re-run でも同じ）の main の VERSION で決め、
// リリースブランチもその時点の main から作る。VERSION を上げる PR は今の main に作る（ほかの製品の VERSION を戻さないため）。
// どのステップも、すでにできているものはそのまま使うので、Re-run すると続きから進む（すべて済んでいれば何もしない）。
async function prepare({ github, context, core }) {
  const repo = context.repo;
  if (context.ref !== 'refs/heads/main') return core.setFailed(`main ブランチで実行してください（今は ${context.ref}）。`);
  const product = process.env.PRODUCT;
  const plan = planReleasePrep({ versionFile: git('show', `${context.sha}:VERSION`), product, bump: process.env.BUMP });
  if (git('tag', '--list', plan.releaseTag) !== '') return core.setFailed(`${plan.releaseTag} はもうリリースされています（この準備は済んでいます）。`);
  const versionFile = fs.readFileSync('VERSION', 'utf8');
  const now = parseVersionFile(versionFile)[product];
  if (now !== plan.currentVersion && now !== plan.nextVersion) {
    return core.setFailed(`実行を始めたあとに main の VERSION の ${product} が ${now} に変わったので、この準備（${plan.currentVersion} → ${plan.nextVersion}）は進められません。`);
  }

  const branch = await createReleaseBranch(github, repo, plan.releaseBranch, context.sha);
  const results = [branch.line, await createReleaseLabel(github, repo, plan.nextLabel)];
  fs.writeFileSync('VERSION', setVersion(versionFile, product, plan.nextVersion));
  await report(core, `${product} のリリースの準備（${plan.currentVersion} → ${plan.nextVersion}）`, results);
  core.setOutput('current_version', plan.currentVersion);
  core.setOutput('next_version', plan.nextVersion);
  core.setOutput('release_branch', plan.releaseBranch);
  core.setOutput('branch_sha', branch.head); // 入っていない変更を、チェックアウトしたときのブランチの先頭で確かめる（changes.js の catchUp）
}

module.exports = { prepare };
