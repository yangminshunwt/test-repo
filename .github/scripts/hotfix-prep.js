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
      `${releasedBranch} がまだあります。リリース手順の最後のとおり、リリースタグより後のコミットや開いている cherry-pick の PR がないかを確かめてから削除し（削除は管理者だけができます）、実行し直してください。`,
    );
  }

  // タグの VERSION は、その製品の行がタグのバージョンと同じでなければならない（自動化を入れる前のタグには VERSION がない）
  const tagVersionFile = await readFile(github, repo, 'VERSION', sha);
  if (tagVersionFile !== null && parseVersionFile(tagVersionFile)[product] !== plan.releasedVersion) {
    return core.setFailed(`${plan.releasedTag} のコミットの VERSION の ${product} が ${plan.releasedVersion} ではありません。タグの位置を確かめてください。`);
  }

  // 同じ名前のブランチがすでにあるときは、このタグから作ったもの（タグが祖先で、VERSION がタグか次のバージョン）だけを使い回す
  if (await branchExists(github, repo, plan.releaseBranch)) {
    const { data: compare } = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${sha}...${plan.releaseBranch}` });
    const branchVersionFile = await readFile(github, repo, 'VERSION', plan.releaseBranch);
    const branchVersion = branchVersionFile === null ? null : parseVersionFile(branchVersionFile)[product];
    const fromTag = compare.behind_by === 0 && (branchVersionFile === null || [plan.releasedVersion, plan.nextVersion].includes(branchVersion));
    if (!fromTag) {
      return core.setFailed(`${plan.releaseBranch} はすでにありますが、${plan.releasedTag} から作られたものではないようです。管理者に削除してもらってから、実行し直してください。`);
    }
  }

  const branch = await createReleaseBranch({ github, core, repo, branch: plan.releaseBranch, sha });
  if (!branch) return;
  const results = [branch.result, await createReleaseLabel({ github, repo, label: plan.nextLabel })];
  const notes = tagVersionFile === null ? [`${plan.releasedTag} には VERSION がないので、main の VERSION をもとに作っています。`] : [];

  await report(core, `${product} の修正フェーズの準備（${plan.releasedTag} → ${plan.nextVersion}）`, [...results, ...notes]);
  core.setOutput('released_tag', plan.releasedTag);
  core.setOutput('next_version', plan.nextVersion);
  core.setOutput('release_branch', plan.releaseBranch);
  core.setOutput('next_label', plan.nextLabel);
  core.setOutput('notes', notes.map((note) => `- ${note}`).join('\n'));
}

// リリースブランチの作業場所（RELEASE_WORK）の VERSION を、次のバージョンに書き換える。
// 自動化を入れる前のタグから作ったブランチで VERSION がなければ、main の VERSION をもとに作る。
function bumpVersion() {
  const file = path.join(process.env.RELEASE_WORK, 'VERSION');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fs.readFileSync('VERSION', 'utf8');
  fs.writeFileSync(file, setVersion(current, process.env.PRODUCT, process.env.NEXT_VERSION));
}

module.exports = { prepare, bumpVersion };
