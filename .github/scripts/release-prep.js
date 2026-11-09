// release-prep.yml から actions/github-script で呼ぶ処理。
// 作業場所には、今の main をすべての履歴（ブランチとタグも）つきで取ってある。
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const { dispatchCherryPicks } = require('./changes.js');
const { createReleaseBranch, createReleaseLabel, prList, report } = require('./github-helpers.js');
const { parseVersionFile, planReleasePrep, setVersion } = require('./release-labels.js');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

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

  const results = [await createReleaseBranch(github, repo, plan.releaseBranch, context.sha), await createReleaseLabel(github, repo, plan.nextLabel)];
  fs.writeFileSync('VERSION', setVersion(versionFile, product, plan.nextVersion));
  await report(core, `${product} のリリースの準備（${plan.currentVersion} → ${plan.nextVersion}）`, results);
  core.setOutput('current_version', plan.currentVersion);
  core.setOutput('next_version', plan.nextVersion);
  core.setOutput('release_branch', plan.releaseBranch);
  // 前の実行で作ったブランチなら、cherry-pick がもう入っているかもしれないので、今の先頭で確かめる
  core.setOutput('branch_sha', (await github.rest.git.getRef({ ...repo, ref: `heads/${plan.releaseBranch}` })).data.object.sha);
}

// リリースブランチを作る前に main にマージされて、Cherry-Pick がこのブランチに入れていない PR の cherry-pick をやり直す
async function catchUp({ github, context, core }) {
  const env = process.env;
  const dispatched = await dispatchCherryPicks({ github, repo: context.repo, dir: '.', product: env.PRODUCT, version: env.VERSION, commit: env.BRANCH_SHA });
  if (dispatched.length > 0) await report(core, 'cherry-pick のやり直し', [`${env.RELEASE_BRANCH} に入っていない ${prList(dispatched)} の Cherry-Pick を実行しました。`]);
}

module.exports = { prepare, catchUp };
