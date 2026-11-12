// hotfix-release-prep.yml から actions/github-script で呼ぶ処理。
// 作業場所には、今の main をすべての履歴（ブランチとタグも）つきで取ってある。
'use strict';

const fs = require('fs');
const path = require('path');
const { branchHead, createReleaseBranch, createReleaseLabel, git, report } = require('./github-helpers.js');
const { planHotfixReleasePrep, setVersion } = require('./rules.js');

// 最新のリリースタグから次のパッチバージョンのリリースブランチを作り、そのリリースラベルを作る。
// すでにできているものはそのまま使うので、Re-run すると続きから進む。
async function prepare({ github, context, core }) {
  const repo = context.repo;
  if (context.ref !== 'refs/heads/main') return core.setFailed(`main ブランチで実行してください（今は ${context.ref}）。`);
  const product = process.env.PRODUCT;
  const plan = planHotfixReleasePrep({ product, tags: git('tag', '--list', `${product}/v*`).split('\n').filter(Boolean) });
  if (plan.error) return core.setFailed(plan.error);
  const sha = git('rev-parse', `${plan.releasedTag}^{commit}`);

  // リリースしたバージョンのリリースブランチが残っていれば、リリース手順を先に終わらせる（リリース後にそこへ入った変更を書き出してから消す）
  const releasedBranch = `release/${product}/v${plan.releasedVersion}`;
  if (await branchHead(github, repo, releasedBranch)) {
    return core.setFailed(`${releasedBranch} がまだあります。Tag Creation の release を実行して、リリース手順を終わらせてから、実行し直してください。`);
  }
  // この自動化より前のタグから作ったブランチでは、ワークフローが今の決まりと合わず（必須チェックの ci がないなど）、PR をマージできないので作らない
  try {
    git('cat-file', '-e', `${sha}:.github/scripts/changes.js`);
  } catch {
    return core.setFailed(`${plan.releasedTag} は今の自動化を入れる前のタグなので、修正フェーズのブランチは作りません（そのブランチへの PR は必須チェックが動かず、マージできないためです）。`);
  }

  const branch = await createReleaseBranch(github, repo, plan.releaseBranch, sha);
  const results = [branch.line, await createReleaseLabel(github, repo, plan.nextLabel)];
  await report(core, `${product} の修正フェーズの準備（${plan.releasedTag} → ${plan.nextVersion}）`, results);
  core.setOutput('released_tag', plan.releasedTag);
  core.setOutput('next_version', plan.nextVersion);
  core.setOutput('release_branch', plan.releaseBranch);
  core.setOutput('next_label', plan.nextLabel);
}

// リリースブランチの作業場所（RELEASE_WORK）の VERSION を、次のバージョンに書き換える。
function bumpVersion() {
  const file = path.join(process.env.RELEASE_WORK, 'VERSION');
  fs.writeFileSync(file, setVersion(fs.readFileSync(file, 'utf8'), process.env.PRODUCT, process.env.VERSION));
}

module.exports = { prepare, bumpVersion };
