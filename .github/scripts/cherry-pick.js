// cherry-pick.yml から actions/github-script で呼ぶ処理。
'use strict';

const { findCherryPickTargets, parseReleaseBranch, parseVersionFile } = require('./release-labels.js');

// cherry-pick.yml の backport-action の branch_name と同じ形にする
function cherryPickBranch(prNumber, target) {
  return `cherry-pick-${prNumber}-to-${target}`;
}

const MANUAL_GUIDE = [
  '手で cherry-pick するときは、行き先のブランチから作業ブランチを作って cherry-pick し、行き先のブランチのバージョンのリリースラベル（例：`release/product-a/v1.4.0` なら `product-a/v1.4.0`）を付けて PR を出してください。元の PR のラベルを付けると、その PR のマージでさらに cherry-pick されます。',
  '原因を直して自動でやり直すときは、Actions の「Cherry-pick」→「Run workflow」で、この PR の番号を指定してください。',
].join('\n\n');

async function readFile(github, repo, path, ref) {
  const { data } = await github.rest.repos.getContent({ ...repo, path, ref });
  return Buffer.from(data.content, 'base64').toString('utf8');
}

async function findCherryPickPull(github, repo, prNumber, target, state) {
  const { data } = await github.rest.pulls.list({ ...repo, state, head: `${repo.owner}:${cherryPickBranch(prNumber, target)}` });
  return data;
}

// 元の PR（PR_NUMBER）の cherry-pick 先を決めて、次を出力する。
// - pr_number：元の PR の番号
// - all_branches：cherry-pick 先のすべて（スペース区切り。ラベルを付ける対象）
// - branches：そのうち、まだ cherry-pick の PR がないもの（backport-action に渡す）
// 行き先を決められないラベルや、VERSION をまだ上げていない行き先があれば、元の PR にコメントで知らせる。
async function findTargets({ github, context, core }) {
  const repo = context.repo;
  const prNumber = Number(process.env.PR_NUMBER);
  // workflow_dispatch でやり直すときも今の状態で決めるため、イベントの内容ではなく API で取り直す
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber });
  if (!pr.merged) {
    core.setFailed(`#${prNumber} はマージされていません。`);
    return;
  }
  const labels = (
    await github.paginate(github.rest.issues.listLabelsOnIssue, { ...repo, issue_number: prNumber, per_page: 100 })
  ).map((label) => label.name);
  const versionFile = await readFile(github, repo, 'VERSION', pr.merge_commit_sha);
  const refs = await github.paginate(github.rest.git.listMatchingRefs, { ...repo, ref: 'heads/release/', per_page: 100 });
  const branches = refs.map((ref) => ref.ref.replace(/^refs\/heads\//, ''));

  const { targets, problems } = findCherryPickTargets({ baseBranch: pr.base.ref, labels, versionFile, branches });

  const pending = [];
  const rows = [];
  for (const target of targets) {
    // やり直したときに同じ行き先へ PR を重ねて作らないよう、開いているかマージ済みの cherry-pick の PR があれば飛ばす
    const existing = (await findCherryPickPull(github, repo, prNumber, target, 'all')).find((pull) => pull.state === 'open' || pull.merged_at);
    if (existing) {
      rows.push([target, `作成済み（#${existing.number}）`]);
      continue;
    }
    pending.push(target);
    rows.push([target, 'これから作る']);
    // 修正フェーズのブランチで VERSION をまだ上げていなければ、cherry-pick の PR はラベルのチェックで止まる
    const release = parseReleaseBranch(target);
    const targetVersion = parseVersionFile(await readFile(github, repo, 'VERSION', target))[release.product];
    if (targetVersion !== release.version) {
      problems.push(
        `${target} の VERSION がまだ ${release.product}/${targetVersion} です。VERSION を上げたあと、cherry-pick の PR で「Update branch」を押して、ラベルのチェックをやり直してください。`,
      );
    }
  }

  await core.summary
    .addHeading(`#${prNumber} の cherry-pick 先`, 3)
    .addTable([
      [{ data: '行き先', header: true }, { data: '状態', header: true }],
      ...(rows.length > 0 ? rows : [['（なし）', '']]),
    ])
    .addList(problems)
    .write();

  if (problems.length > 0) {
    for (const problem of problems) core.warning(problem);
    await github.rest.issues.createComment({
      ...repo,
      issue_number: prNumber,
      body: ['cherry-pick 先を決めるときに、次の問題がありました。', '', ...problems.map((problem) => `- ${problem}`), '', MANUAL_GUIDE].join('\n'),
    });
  }
  core.setOutput('pr_number', prNumber);
  core.setOutput('all_branches', targets.join(' '));
  core.setOutput('branches', pending.join(' '));
}

// cherry-pick の PR に、行き先のブランチのバージョンのリリースラベルを付ける。
// 元の PR のラベルを写すと、その PR がマージされたときにさらに cherry-pick が広がるため。
// 前の実行で作られた PR にも付けるため、作られた PR の番号ではなく、行き先ごとにブランチ名から探す。
async function labelPullRequests({ github, context, core }) {
  const repo = context.repo;
  const prNumber = Number(process.env.PR_NUMBER);
  const failures = [];
  for (const target of (process.env.TARGETS || '').split(' ').filter(Boolean)) {
    try {
      const release = parseReleaseBranch(target);
      const label = `${release.product}/v${release.version}`;
      for (const pull of await findCherryPickPull(github, repo, prNumber, target, 'open')) {
        if (pull.labels.some(({ name }) => name === label)) continue;
        await github.rest.issues.addLabels({ ...repo, issue_number: pull.number, labels: [label] });
        core.info(`#${pull.number} に ${label} を付けました。`);
      }
    } catch (error) {
      failures.push(`${target}：${error.message}`);
    }
  }
  if (failures.length > 0) {
    core.setFailed(`リリースラベルを付けられなかった cherry-pick の PR があります。\n${failures.join('\n')}`);
  }
}

// cherry-pick を終えられなかったとき、元の PR の作者とマージした人に知らせる。
// backport-action のコメントはあとから書き換えられて通知が届かないので、新しいコメントを作る。
async function reportFailures({ github, context, core }) {
  const repo = context.repo;
  const prNumber = Number(process.env.PR_NUMBER);
  const reasons = [];
  if (process.env.APP_TOKEN_OUTCOME !== 'success') {
    reasons.push('GitHub App のトークンを作れませんでした。App とリポジトリの設定（CHERRY_PICK_APP_CLIENT_ID・CHERRY_PICK_APP_PRIVATE_KEY）を確かめてください。');
  }
  if (process.env.APP_TOKEN_OUTCOME === 'success' && process.env.PENDING_BRANCHES && process.env.BACKPORT_OUTCOME !== 'success') {
    reasons.push('backport-action が動かなかったか、途中で失敗しました。');
  }
  for (const line of (process.env.RESULTS || '').split('\n')) {
    if (line.endsWith('=false')) reasons.push(`${line.slice(0, -'=false'.length)} に cherry-pick できませんでした。`);
  }
  if (process.env.LABEL_OUTCOME === 'failure') reasons.push('cherry-pick の PR にリリースラベルを付けられませんでした。');
  if (reasons.length === 0) return;

  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber });
  const mentions = [...new Set([pr.user.login, pr.merged_by?.login].filter(Boolean))].map((login) => `@${login}`).join(' ');
  const runUrl = `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  await github.rest.issues.createComment({
    ...repo,
    issue_number: prNumber,
    body: [`${mentions} cherry-pick を終えられませんでした（[実行の記録](${runUrl})）。`, '', ...reasons.map((reason) => `- ${reason}`), '', MANUAL_GUIDE].join('\n'),
  });
  core.setFailed(reasons.join('\n'));
}

module.exports = { findTargets, labelPullRequests, reportFailures };
