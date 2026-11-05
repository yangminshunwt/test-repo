// hotfix-prep.yml から actions/github-script で呼ぶ処理。
'use strict';

const fs = require('fs');
const path = require('path');
const { createReleaseBranch, createReleaseLabel } = require('./release-branch.js');
const { planHotfixPrep, setVersion } = require('./release-labels.js');

// 最新のリリースタグから次のパッチバージョンのリリースブランチを作り、そのリリースラベルを作る。
// やり直したときも続きから進められるよう、すでにあるブランチやラベルはそのまま使う。
async function prepare({ github, context, core }) {
  const repo = context.repo;
  if (context.ref !== 'refs/heads/main') {
    core.setFailed(`main ブランチで実行してください（今は ${context.ref}）。`);
    return;
  }
  const product = process.env.PRODUCT;
  const versionFile = fs.readFileSync('VERSION', 'utf8');
  const refs = await github.paginate(github.rest.git.listMatchingRefs, { ...repo, ref: `tags/${product}/v`, per_page: 100 });
  const plan = planHotfixPrep({ versionFile, product, tags: refs.map((ref) => ref.ref.replace(/^refs\/tags\//, '')) });
  if (plan.errors.length > 0) {
    for (const error of plan.errors) core.error(error);
    core.setFailed('修正フェーズの準備を始められませんでした。');
    return;
  }

  // タグが指すコミット（注釈付きタグなら、その先のコミット）
  const tagRef = refs.find((ref) => ref.ref === `refs/tags/${plan.releasedTag}`);
  let sha = tagRef.object.sha;
  if (tagRef.object.type === 'tag') {
    sha = (await github.rest.git.getTag({ ...repo, tag_sha: sha })).data.object.sha;
  }

  const branch = await createReleaseBranch({ github, core, repo, branch: plan.releaseBranch, sha });
  if (!branch) return;
  const { results, notes } = branch;
  results.push(await createReleaseLabel({ github, repo, label: plan.nextLabel }));

  // 自動化を入れる前に打ったタグから作ったブランチには、リリースラベルのチェックなどのワークフローがない。
  // そのままでは必須チェックが走らず PR をマージできないので、VERSION を上げる PR で main の .github も入れる。
  let bringAutomation = false;
  try {
    await github.rest.repos.getContent({ ...repo, path: '.github/workflows/release-label-check.yml', ref: plan.releaseBranch });
  } catch (error) {
    if (error.status !== 404) throw error;
    bringAutomation = true;
    notes.push(`${plan.releasedTag} には自動化のワークフローがなかったので、この PR で main の .github も入れています。`);
  }

  for (const line of [...results, ...notes]) core.info(line);
  await core.summary
    .addHeading(`${product} の修正フェーズの準備（${plan.releasedTag} → ${plan.nextVersion}）`, 3)
    .addList([...results, ...notes])
    .write();
  core.setOutput('released_tag', plan.releasedTag);
  core.setOutput('next_version', plan.nextVersion);
  core.setOutput('release_branch', plan.releaseBranch);
  core.setOutput('next_label', plan.nextLabel);
  core.setOutput('bring_automation', String(bringAutomation));
  core.setOutput('notes', notes.map((note) => `- ${note}`).join('\n'));
}

// リリースブランチの作業場所（RELEASE_WORK）の VERSION を、次のバージョンに書き換える。
async function bumpVersion() {
  const file = path.join(process.env.RELEASE_WORK, 'VERSION');
  fs.writeFileSync(file, setVersion(fs.readFileSync(file, 'utf8'), process.env.PRODUCT, process.env.NEXT_VERSION));
}

module.exports = { prepare, bumpVersion };
