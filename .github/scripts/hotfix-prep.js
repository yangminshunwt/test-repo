// hotfix-prep.yml から actions/github-script で呼ぶ処理。
'use strict';

const fs = require('fs');
const path = require('path');
const { branchExists, readFile, report, tagCommit } = require('./github-helpers.js');
const { createReleaseBranch, createReleaseLabel } = require('./release-branch.js');
const { parseVersionFile, planHotfixPrep, setVersion } = require('./release-labels.js');

// 最新のリリースタグから次のパッチバージョンのリリースブランチを作り、そのリリースラベルを作る。
// 途中で止まって直せないブランチを残さないよう、確かめられることはすべて作る前に確かめる。
// やり直したときも続きから進められるよう、正しく作られたブランチやラベルはそのまま使う。
async function prepare({ github, context, core }) {
  const repo = context.repo;
  if (context.ref !== 'refs/heads/main') return core.setFailed(`main ブランチで実行してください（今は ${context.ref}）。`);

  const product = process.env.PRODUCT;
  const refs = await github.paginate(github.rest.git.listMatchingRefs, { ...repo, ref: `tags/${product}/v`, per_page: 100 });
  const plan = planHotfixPrep({
    versionFile: fs.readFileSync('VERSION', 'utf8'),
    product,
    tags: refs.map((ref) => ref.ref.replace(/^refs\/tags\//, '')),
  });
  if (plan.error) return core.setFailed(plan.error);
  const sha = await tagCommit(github, repo, refs.find((ref) => ref.ref === `refs/tags/${plan.releasedTag}`));

  // リリースしたバージョンのリリースブランチが残っていると、リリース後にそこへ入った変更がこの修正に入らず、
  // 古いバージョンのラベルもチェックを通ってしまうので、リリース手順の最後（リリースブランチの削除）を済ませてもらう
  const releasedBranch = `release/${product}/v${plan.releasedVersion}`;
  if (await branchExists(github, repo, releasedBranch)) {
    return core.setFailed(
      `${releasedBranch} がまだあります。先に Tag Creation の release を実行し直し、その案内に従ってください（ブランチを消すと Tag Creation をやり直せないので、管理者がブランチを消すのは、その案内で求められたときだけにしてください）。そのあと実行し直してください。`,
    );
  }

  // リリースブランチの自動化（.github）は、タグのものをそのまま使う。自動化を入れる前のタグから作ると、
  // そのブランチへの PR は必須チェックが動かずにマージできないので、作る前に止める
  const tagVersionFile = await readFile(github, repo, 'VERSION', sha);
  if (tagVersionFile === null || (await readFile(github, repo, '.github/workflows/release-label-check.yml', sha)) === null) {
    return core.setFailed(
      `${plan.releasedTag} は自動化を入れる前のタグ（VERSION か .github/workflows/release-label-check.yml がない）なので、修正フェーズのブランチは作りません。そのブランチへの PR は必須チェックが動かず、マージできないためです。`,
    );
  }
  // タグの VERSION は、その製品の行がタグのバージョンと同じでなければならない
  if (parseVersionFile(tagVersionFile)[product] !== plan.releasedVersion) {
    return core.setFailed(`${plan.releasedTag} のコミットの VERSION の ${product} が ${plan.releasedVersion} ではありません。タグの位置を確かめてください。`);
  }

  // 同じ名前のブランチがすでにあるときは、このタグから作ったもの（タグが祖先で、VERSION がタグか次のバージョン）だけを使い回す
  if (await branchExists(github, repo, plan.releaseBranch)) {
    const { data: compare } = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${sha}...${plan.releaseBranch}` });
    const branchVersionFile = await readFile(github, repo, 'VERSION', plan.releaseBranch);
    const branchVersion = branchVersionFile === null ? null : parseVersionFile(branchVersionFile)[product];
    const fromTag = compare.behind_by === 0 && [plan.releasedVersion, plan.nextVersion].includes(branchVersion);
    if (!fromTag) {
      return core.setFailed(`${plan.releaseBranch} はすでにありますが、${plan.releasedTag} から作られたものではないようです。管理者に削除してもらってから、実行し直してください。`);
    }
  }

  const branch = await createReleaseBranch({ github, core, repo, branch: plan.releaseBranch, sha });
  if (!branch) return;
  const results = [branch.result, await createReleaseLabel({ github, repo, label: plan.nextLabel })];

  await report(core, `${product} の修正フェーズの準備（${plan.releasedTag} → ${plan.nextVersion}）`, results);
  core.setOutput('released_tag', plan.releasedTag);
  core.setOutput('next_version', plan.nextVersion);
  core.setOutput('release_branch', plan.releaseBranch);
  core.setOutput('next_label', plan.nextLabel);
}

// リリースブランチの作業場所（RELEASE_WORK）の VERSION を、次のバージョンに書き換える。
function bumpVersion() {
  const file = path.join(process.env.RELEASE_WORK, 'VERSION');
  fs.writeFileSync(file, setVersion(fs.readFileSync(file, 'utf8'), process.env.PRODUCT, process.env.NEXT_VERSION));
}

module.exports = { prepare, bumpVersion };
