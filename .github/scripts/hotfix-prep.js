// hotfix-prep.yml から actions/github-script で呼ぶ処理。
'use strict';

const fs = require('fs');
const path = require('path');
const { createReleaseBranch, createReleaseLabel, tagCommit } = require('./release-branch.js');
const { parseVersionFile, planHotfixPrep, setVersion } = require('./release-labels.js');

async function readVersionFile(github, repo, ref) {
  try {
    const { data } = await github.rest.repos.getContent({ ...repo, path: 'VERSION', ref });
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function branchExists(github, repo, branch) {
  try {
    await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

// 最新のリリースタグから次のパッチバージョンのリリースブランチを作り、そのリリースラベルを作る。
// 途中で止まって直せないブランチを残さないよう、確かめられることはすべて作る前に確かめる。
// やり直したときも続きから進められるよう、正しく作られたブランチやラベルはそのまま使う。
async function prepare({ github, context, core }) {
  const repo = context.repo;
  const fail = (message) => core.setFailed(message);
  if (context.ref !== 'refs/heads/main') return fail(`main ブランチで実行してください（今は ${context.ref}）。`);

  const product = process.env.PRODUCT;
  const refs = await github.paginate(github.rest.git.listMatchingRefs, { ...repo, ref: `tags/${product}/v`, per_page: 100 });
  const plan = planHotfixPrep({
    versionFile: fs.readFileSync('VERSION', 'utf8'),
    product,
    tags: refs.map((ref) => ref.ref.replace(/^refs\/tags\//, '')),
  });
  if (plan.errors.length > 0) {
    for (const error of plan.errors) core.error(error);
    return fail('修正フェーズの準備を始められませんでした。');
  }
  const sha = await tagCommit(github, repo, refs.find((ref) => ref.ref === `refs/tags/${plan.releasedTag}`));

  // リリースしたバージョンのリリースブランチが残っていると、リリース後にそこへ入った変更がこの修正に入らず、
  // 古いバージョンのラベルもチェックを通ってしまうので、リリース手順の最後（リリースブランチの削除）を済ませてもらう
  const releasedBranch = `release/${product}/v${plan.releasedVersion}`;
  if (await branchExists(github, repo, releasedBranch)) {
    return fail(
      `${releasedBranch} がまだあります。リリース手順の最後のとおり、リリースタグより後のコミットや開いている cherry-pick の PR がないかを確かめてから削除し（削除は管理者だけができます）、実行し直してください。`,
    );
  }

  // タグの VERSION は、その製品の行がタグのバージョンと同じでなければならない（自動化を入れる前のタグには VERSION がない）
  const tagVersionFile = await readVersionFile(github, repo, sha);
  if (tagVersionFile !== null && parseVersionFile(tagVersionFile)[product] !== plan.releasedVersion) {
    return fail(`${plan.releasedTag} のコミットの VERSION の ${product} が ${plan.releasedVersion} ではありません。タグの位置を確かめてください。`);
  }

  // 同じ名前のブランチがすでにあるときは、このタグから作ったもの（タグが祖先で、VERSION がタグか次のバージョン）だけを使い回す
  if (await branchExists(github, repo, plan.releaseBranch)) {
    const { data: compare } = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${sha}...${plan.releaseBranch}` });
    const branchVersionFile = await readVersionFile(github, repo, plan.releaseBranch);
    const branchVersion = branchVersionFile === null ? null : parseVersionFile(branchVersionFile)[product];
    const fromTag = compare.behind_by === 0 && (branchVersionFile === null || [plan.releasedVersion, plan.nextVersion].includes(branchVersion));
    if (!fromTag) {
      return fail(`${plan.releaseBranch} はすでにありますが、${plan.releasedTag} から作られたものではないようです。管理者に削除してもらってから、実行し直してください。`);
    }
  }

  const branch = await createReleaseBranch({ github, core, repo, branch: plan.releaseBranch, sha });
  if (!branch) return;
  const { results, notes } = branch;
  results.push(await createReleaseLabel({ github, repo, label: plan.nextLabel }));
  if (tagVersionFile === null) {
    notes.push(`${plan.releasedTag} には VERSION がないので、main の VERSION をもとに作っています。`);
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
  core.setOutput('notes', notes.map((note) => `- ${note}`).join('\n'));
}

// リリースブランチの作業場所（RELEASE_WORK）の VERSION を、次のバージョンに書き換える。
// 自動化を入れる前のタグから作ったブランチで VERSION がなければ、main の VERSION をもとに作る。
async function bumpVersion() {
  const file = path.join(process.env.RELEASE_WORK, 'VERSION');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fs.readFileSync('VERSION', 'utf8');
  fs.writeFileSync(file, setVersion(current, process.env.PRODUCT, process.env.NEXT_VERSION));
}

module.exports = { prepare, bumpVersion };
