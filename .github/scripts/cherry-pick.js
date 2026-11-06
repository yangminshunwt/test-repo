// cherry-pick.yml から actions/github-script で呼ぶ処理。
'use strict';

const { listReleaseBranches, readFile } = require('./github-helpers.js');
const { cherryPickBranch, findCherryPickTargets, parseReleaseBranch, parseVersionFile } = require('./release-labels.js');

function manualGuide(prNumber) {
  return [
    `手で cherry-pick するときは、行き先のブランチから \`${cherryPickBranch(prNumber, '<行き先のブランチ>')}\` という名前の作業ブランチを作って cherry-pick し、行き先のブランチのバージョンのリリースラベル（例：\`release/product-a/v1.4.0\` なら \`product-a/v1.4.0\`）を付けて PR を出してください。この名前にしておくと、自動でやり直したときに重ねて作られません。元の PR のラベルを付けると、その PR のマージでさらに cherry-pick されます。`,
    `原因を直して自動でやり直すときは、Actions の「Cherry-Pick」→「Run workflow」で、PR の番号 ${prNumber} を指定してください。`,
  ].join('\n\n');
}

async function findCherryPickPulls(github, repo, prNumber, target, state) {
  const { data } = await github.rest.pulls.list({ ...repo, state, head: `${repo.owner}:${cherryPickBranch(prNumber, target)}` });
  return data;
}

// 同じ内容のコメントがまだなければ付ける（やり直すたびに同じコメントが増えないように）
async function commentOnce(github, repo, issueNumber, body) {
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: issueNumber, per_page: 100 });
  if (comments.some((comment) => comment.body === body)) return;
  await github.rest.issues.createComment({ ...repo, issue_number: issueNumber, body });
}

// 元の PR（PR_NUMBER）の cherry-pick 先を決めて、all_branches（スペース区切り）に出力する。
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
  const labels = pr.labels.map((label) => label.name);
  const versionFile = await readFile(github, repo, 'VERSION', pr.merge_commit_sha);
  if (versionFile === null) return core.setFailed(`#${prNumber} をマージしたコミットに VERSION がありません。`);
  const branches = await listReleaseBranches(github, repo);

  const { targets, problems, missing } = findCherryPickTargets({ baseBranch: pr.base.ref, labels, versionFile, branches });

  for (const { label, product, version } of missing) {
    // リリース前に cherry-pick してあり、リリース後にブランチを消しただけなら問題ない
    const target = `release/${product}/v${version}`;
    const merged = (await findCherryPickPulls(github, repo, prNumber, target, 'closed')).find((pull) => pull.merged_at);
    if (merged) continue;
    problems.push(
      `${label}：${product} に v${version} のリリースブランチがないので、この変更は v${version} には入っていません（リリース済みか、まだ作っていない可能性があります）。`,
    );
  }
  for (const target of targets) {
    // 修正フェーズのブランチで VERSION をまだ上げていなければ、cherry-pick の PR はラベルのチェックで止まる
    const release = parseReleaseBranch(target);
    const targetVersionFile = await readFile(github, repo, 'VERSION', target);
    if (targetVersionFile === null || parseVersionFile(targetVersionFile)[release.product] !== release.version) {
      problems.push(
        `${target} の VERSION がまだ ${release.version} になっていません。VERSION を上げる PR がマージされたあと、cherry-pick の PR で \`gh pr update-branch <番号>\` を実行して、チェックをやり直してください。`,
      );
    }
  }

  await core.summary
    .addHeading(`#${prNumber} の cherry-pick 先`, 3)
    .addList(targets.length > 0 ? targets : ['（なし）'])
    .addList(problems)
    .write();

  // コメントに失敗しても、決められた行き先への cherry-pick は続けられるよう、先に出力する
  core.setOutput('all_branches', targets.join(' '));

  if (problems.length > 0) {
    for (const problem of problems) core.warning(problem);
    const body = ['cherry-pick 先を決めるときに、次の問題がありました。', '', ...problems.map((problem) => `- ${problem}`), '', manualGuide(prNumber)].join('\n');
    try {
      await commentOnce(github, repo, prNumber, body);
    } catch (error) {
      core.warning(`#${prNumber} にコメントできませんでした：${error.message}`);
    }
  }
}

// TARGETS のうち、まだ cherry-pick の PR がない行き先を branches（スペース区切り）に出力する。
// やり直し（Re-run・Run workflow）でも同じ行き先へ PR を重ねて作らないよう、cherry-pick の直前に今の状態で決める。
// 閉じた（マージしていない）PR のブランチが残っていれば消す。残っていると、backport-action がその古い中身で PR を作り直すため。
async function selectPending({ github, context, core }) {
  const repo = context.repo;
  const prNumber = Number(process.env.PR_NUMBER);
  const pending = [];
  for (const target of (process.env.TARGETS || '').split(' ').filter(Boolean)) {
    const pulls = await findCherryPickPulls(github, repo, prNumber, target, 'all');
    const existing = pulls.find((pull) => pull.state === 'open' || pull.merged_at);
    if (existing) {
      core.info(`${target}：作成済み（#${existing.number}）`);
      continue;
    }
    const ref = `heads/${cherryPickBranch(prNumber, target)}`;
    try {
      await github.rest.git.deleteRef({ ...repo, ref });
      core.info(`${target}：残っていた ${ref} を消しました。`);
    } catch (error) {
      if (error.status !== 422 && error.status !== 404) throw error;
    }
    pending.push(target);
    core.info(`${target}：これから作る`);
  }
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
      for (const pull of await findCherryPickPulls(github, repo, prNumber, target, 'open')) {
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
  const env = process.env;
  const reasons = [];
  if (env.APP_TOKEN_OUTCOME !== 'success') {
    reasons.push('GitHub App のトークンを作れませんでした。App とリポジトリの設定（CHERRY_PICK_APP_CLIENT_ID・CHERRY_PICK_APP_PRIVATE_KEY）を確かめてください。');
  } else if (env.JOB_STATUS === 'failure') {
    reasons.push('途中のステップが失敗しました。実行の記録を確かめてください。');
  }
  // backport-action は、一部の行き先に cherry-pick できなくてもステップを失敗にせず、結果に false を記録するだけなので、ここで拾う
  // （コンフリクトして draft の PR を作った行き先は true になるので、ここでは知らせない）
  for (const line of (env.RESULTS || '').split('\n')) {
    if (line.endsWith('=false')) reasons.push(`${line.slice(0, -'=false'.length)} に cherry-pick できませんでした。`);
  }
  if (reasons.length === 0) return;

  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber });
  const mentions = [...new Set([pr.user.login, pr.merged_by?.login].filter(Boolean))].map((login) => `@${login}`).join(' ');
  const runUrl = `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  await github.rest.issues.createComment({
    ...repo,
    issue_number: prNumber,
    body: [`${mentions} cherry-pick を終えられませんでした（[実行の記録](${runUrl})）。`, '', ...reasons.map((reason) => `- ${reason}`), '', manualGuide(prNumber)].join('\n'),
  });
  core.setFailed(reasons.join('\n'));
}

module.exports = { findTargets, selectPending, labelPullRequests, reportFailures };
