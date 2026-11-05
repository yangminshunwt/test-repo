// release-prep.yml から actions/github-script で呼ぶ処理。
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const { planReleasePrep, setVersion } = require('./release-labels.js');

// 422 は「すでにある」以外（ルールセット違反など）でも返るので、本当にあるかを確かめる
async function ensureExists(createError, check) {
  if (createError.status !== 422) throw createError;
  try {
    await check();
  } catch (error) {
    throw error.status === 404 ? createError : error;
  }
}

// リリースブランチと次のバージョンのリリースラベルを作り、作業場所の VERSION を次のバージョンに書き換える。
// やり直したときも続きから進められるよう、すでにあるブランチやラベルはそのまま使う。
async function prepare({ github, context, core }) {
  const repo = context.repo;
  if (context.ref !== 'refs/heads/main') {
    core.setFailed(`main ブランチで実行してください（今は ${context.ref}）。`);
    return;
  }
  const product = process.env.PRODUCT;
  // チェックアウトしたのは、ジョブを始めた時点の最新の main（Re-run でも、そのときの main になる）
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const versionFile = fs.readFileSync('VERSION', 'utf8');
  const plan = planReleasePrep({ versionFile, product, bump: process.env.BUMP });
  if (plan.errors.length > 0) {
    for (const error of plan.errors) core.error(error);
    core.setFailed('リリースの準備を始められませんでした。');
    return;
  }

  // 同じ製品を別のバージョンに上げる PR が開いていると、どちらもマージできてしまうので止める
  const prefix = `release-prep/${product}/`;
  const others = (await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', base: 'main', per_page: 100 })).filter(
    (pull) => pull.head.ref.startsWith(prefix) && pull.head.ref !== `${prefix}v${plan.nextVersion}`,
  );
  if (others.length > 0) {
    core.setFailed(`${product} の VERSION を上げる PR がほかにも開いています（${others.map((pull) => `#${pull.number}`).join('、')}）。閉じてから実行し直してください。`);
    return;
  }

  const results = [];
  const notes = [];
  let createdFrom = '';
  try {
    await github.rest.git.createRef({ ...repo, ref: `refs/heads/${plan.releaseBranch}`, sha });
    createdFrom = sha;
    results.push(`${plan.releaseBranch} を作りました（${sha.slice(0, 7)} から）。`);
  } catch (error) {
    await ensureExists(error, () => github.rest.git.getRef({ ...repo, ref: `heads/${plan.releaseBranch}` }));
    results.push(`${plan.releaseBranch} はすでにあるので、そのまま使います。`);
    // 前に作ったブランチを使うときは、入っていない変更がないかを知らせる
    const cherryPicks = (await github.paginate(github.rest.pulls.list, { ...repo, state: 'all', base: plan.releaseBranch, per_page: 100 })).filter(
      (pull) => pull.head.ref.startsWith('cherry-pick-'),
    );
    const list = (pulls) => pulls.map((pull) => `#${pull.number}`).join('、');
    const closed = cherryPicks.filter((pull) => pull.state === 'closed' && !pull.merged_at);
    const open = cherryPicks.filter((pull) => pull.state === 'open');
    if (closed.length > 0) {
      notes.push(`${plan.releaseBranch} には、マージされずに閉じた cherry-pick の PR があります（${list(closed)}）。その変更はこのブランチに入っていません。`);
    }
    if (open.length > 0) {
      notes.push(`${plan.releaseBranch} への cherry-pick の PR がまだ開いています（${list(open)}）。リリースまでにマージしてください。`);
    }
  }
  try {
    await github.rest.issues.createLabel({ ...repo, name: plan.nextLabel, color: '1d76db', description: 'Release label' });
    results.push(`ラベル ${plan.nextLabel} を作りました。`);
  } catch (error) {
    await ensureExists(error, () => github.rest.issues.getLabel({ ...repo, name: plan.nextLabel }));
    results.push(`ラベル ${plan.nextLabel} はすでにあります。`);
  }
  fs.writeFileSync('VERSION', setVersion(versionFile, product, plan.nextVersion));

  for (const line of [...results, ...notes]) core.info(line);
  await core.summary
    .addHeading(`${product} のリリースの準備（${plan.currentVersion} → ${plan.nextVersion}）`, 3)
    .addList([...results, ...notes])
    .write();
  core.setOutput('current_version', plan.currentVersion);
  core.setOutput('next_version', plan.nextVersion);
  core.setOutput('release_branch', plan.releaseBranch);
  core.setOutput('next_label', plan.nextLabel);
  core.setOutput('created_from', createdFrom);
  core.setOutput('notes', notes.map((note) => `- ${note}`).join('\n'));
}

// リリースブランチを作ったコミット（CREATED_FROM）より後に main にマージされた PR の cherry-pick をやり直す。
// チェックアウトしてからブランチを作るまでの間にマージされた PR は、cherry-pick の時点でブランチがなかったかもしれないため。
// cherry-pick.yml は作成済みの行き先を飛ばすので、もう入っている PR をやり直しても重ならない。
async function catchUpCherryPicks({ github, context, core }) {
  const repo = context.repo;
  const createdFrom = process.env.CREATED_FROM;
  if (!createdFrom) return;
  const { data: main } = await github.rest.repos.getBranch({ ...repo, branch: 'main' });
  if (main.commit.sha === createdFrom) return;
  const { data: compare } = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${createdFrom}...${main.commit.sha}` });
  const numbers = new Set();
  for (const commit of compare.commits) {
    const { data: pulls } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ ...repo, commit_sha: commit.sha });
    for (const pull of pulls) {
      if (pull.merged_at && pull.base.ref === 'main') numbers.add(pull.number);
    }
  }
  for (const number of numbers) {
    await github.rest.actions.createWorkflowDispatch({ ...repo, workflow_id: 'cherry-pick.yml', ref: 'main', inputs: { pr_number: String(number) } });
    core.info(`ブランチを作る間に main にマージされた #${number} の cherry-pick をやり直しました。`);
  }
}

module.exports = { prepare, catchUpCherryPicks };
