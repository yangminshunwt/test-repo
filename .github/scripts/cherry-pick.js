// cherry-pick.yml から actions/github-script で呼ぶ処理。
'use strict';

const { deleteBranchIfAt, listReleaseBranches, mentionsOf, readFile, tagCommit } = require('./github-helpers.js');
const { cherryPickBranch, findCherryPickTargets, parseCherryPickBranch, parseReleaseBranch, parseVersionFile } = require('./release-labels.js');

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

// backport-action が cherry-pick のコミットに使う committer（action.yml の git_committer_email の既定）
const AUTOMATION_COMMITTER = 'github-actions[bot]@users.noreply.github.com';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runUrlOf = (context) => `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;

// 製品のリリースタグ（<製品名>/vX.Y.Z。rc などは除く）を、タグ名 → ref で返す
async function releaseTags(github, repo, products) {
  const tags = new Map();
  for (const product of products) {
    for (const ref of await github.paginate(github.rest.git.listMatchingRefs, { ...repo, ref: `tags/${product}/v`, per_page: 100 })) {
      const name = ref.ref.replace(/^refs\/tags\//, '');
      if (/^[^/]+\/v\d+\.\d+\.\d+$/.test(name)) tags.set(name, ref);
    }
  }
  return tags;
}

// タグを打った日時（注釈付きタグはその日時、軽量タグはコミットの日時）
async function taggedAt(github, repo, ref) {
  if (ref.object.type === 'tag') return (await github.rest.git.getTag({ ...repo, tag_sha: ref.object.sha })).data.tagger.date;
  return (await github.rest.git.getCommit({ ...repo, commit_sha: ref.object.sha })).data.committer.date;
}

// sha のコミットが、タグ ref の指すコミットに入っているか（祖先か同じか）
async function isInTag(github, repo, sha, ref) {
  const tagSha = await tagCommit(github, repo, ref);
  const { data } = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${sha}...${tagSha}`, per_page: 1 });
  return data.status === 'ahead' || data.status === 'identical';
}

// 行き先のリリースブランチが、もうリリース済み（そのバージョンのリリースタグがある）かを確かめる。リリースしたあとも残している
// ブランチ（リリースより後のコミットがあったもの）に入れても、どのリリースにも入らないので cherry-pick しない。
// 戻り値：{ released: false } か、{ released: true, problem }（その変更がリリースに入っていれば problem は null）
async function checkReleasedTarget(github, repo, pr, target, tags) {
  const release = parseReleaseBranch(target);
  const tag = tags.get(`${release.product}/v${release.version}`);
  if (!tag) return { released: false };
  const merged = (await findCherryPickPulls(github, repo, pr.number, target, 'closed')).filter((pull) => pull.merged_at);
  for (const sha of [pr.merge_commit_sha, ...merged.map((pull) => pull.merge_commit_sha)]) {
    if (await isInTag(github, repo, sha, tag)) return { released: true, problem: null };
  }
  return { released: true, problem: `${target} はリリース済み（タグがあります）なので、cherry-pick しません。この変更は v${release.version} には入っていません。` };
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
  const versionFile = await readFile(github, repo, 'VERSION', pr.merge_commit_sha);
  if (versionFile === null) return core.setFailed(`#${prNumber} をマージしたコミットに VERSION がありません。`);
  const branches = await listReleaseBranches(github, repo);
  const tags = await releaseTags(github, repo, Object.keys(parseVersionFile(versionFile)));

  // この PR をマージする前にリリースしたバージョンのラベルは使わない（その変更はそのリリースに入っていない）
  const labels = [];
  const releasedProblems = [];
  for (const { name } of pr.labels) {
    const tag = tags.get(name);
    if (tag && Date.parse(pr.merged_at) > Date.parse(await taggedAt(github, repo, tag))) {
      const original = parseCherryPickBranch(pr.head.ref);
      let guide;
      if (pr.base.ref === 'main') {
        guide = '入っていません。これから入るリリースのバージョンに付け替えてから、Cherry-Pick の Run workflow でやり直してください。';
      } else if (original !== null) {
        guide = `どのリリースにも入っていません（${pr.base.ref} はリリース済み）。Hotfix Preparation で修正フェーズのブランチを作ったあと、元の PR（#${original}）を Cherry-Pick の Run workflow でやり直してください。`;
      } else {
        guide = `どのリリースにも入っていません（${pr.base.ref} はリリース済み）。Hotfix Preparation で作るブランチに PR を出し直してください。`;
      }
      releasedProblems.push(`${name}：この PR をマージする前にリリースされたバージョンなので、この変更は${guide}`);
    } else {
      labels.push(name);
    }
  }

  const found = findCherryPickTargets({ baseBranch: pr.base.ref, labels, versionFile, branches });
  const { missing } = found;
  const problems = [...releasedProblems, ...found.problems];
  // リリースしたあとも残しているリリースブランチ（リリースより後のコミットがあったもの）には cherry-pick しない
  // （入れても、どのリリースにも入らない）。すでに cherry-pick してあれば、そのリリースに入っているので知らせない
  const targets = [];
  for (const target of found.targets) {
    const released = await checkReleasedTarget(github, repo, pr, target, tags);
    if (!released.released) targets.push(target);
    else if (released.problem) problems.push(released.problem);
  }

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
    const body = [`${mentionsOf(pr)} cherry-pick 先を決めるときに、次の問題がありました。`, '', ...problems.map((problem) => `- ${problem}`), '', manualGuide(prNumber)].join('\n');
    try {
      await commentOnce(github, repo, prNumber, body);
    } catch (error) {
      core.warning(`#${prNumber} にコメントできませんでした：${error.message}`);
    }
  }
}

// TARGETS のうち、まだ cherry-pick の PR がない行き先を branches（スペース区切り）に出力する。
// やり直し（Re-run・Run workflow）でも同じ行き先へ PR を重ねて作らないよう、cherry-pick の直前に今の状態で決める。
// PR のない cherry-pick のブランチが残っていて、閉じた（マージしていない）PR のものか、自動化が作ったものなら消す。
// 残っていると、backport-action がその古い中身で PR を作り直すため。人が手で作ったブランチ（PR はまだない）は消さずに知らせる。
async function selectPending({ github, context, core }) {
  const repo = context.repo;
  const prNumber = Number(process.env.PR_NUMBER);
  const pending = [];
  const manual = [];
  const releasedProblems = [];
  const targetList = (process.env.TARGETS || '').split(' ').filter(Boolean);
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber });
  // 「Re-run failed jobs」では行き先が前の実行のままなので、そのあとリリースされた行き先をここでも外す
  const tags = await releaseTags(github, repo, [...new Set(targetList.map((target) => parseReleaseBranch(target).product))]);
  for (const target of targetList) {
    const released = await checkReleasedTarget(github, repo, pr, target, tags);
    if (released.released) {
      if (released.problem) releasedProblems.push(released.problem);
      continue;
    }
    const pulls = await findCherryPickPulls(github, repo, prNumber, target, 'all');
    const existing = pulls.find((pull) => pull.state === 'open' || pull.merged_at);
    if (existing) {
      core.info(`${target}：作成済み（#${existing.number}）`);
      continue;
    }
    const branch = cherryPickBranch(prNumber, target);
    let headSha = null;
    try {
      headSha = (await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` })).data.object.sha;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (headSha) {
      // 消すのは、閉じた PR のときのままのブランチか、自動化が作ったブランチだけ。消すまでの間に push されたら消さない
      const { data: head } = await github.rest.git.getCommit({ ...repo, commit_sha: headSha });
      const fromClosedPull = pulls.some((pull) => pull.state === 'closed' && !pull.merged_at && pull.head.sha === headSha);
      if ((!fromClosedPull && head.committer.email !== AUTOMATION_COMMITTER) || !(await deleteBranchIfAt(github, repo, branch, headSha))) {
        manual.push(branch);
        core.warning(`${target}：手で作られた（または更新された）${branch} があり、PR がまだないので、消さずに飛ばします。`);
        continue;
      }
      core.info(`${target}：残っていた ${branch} を消しました。`);
    }
    pending.push(target);
    core.info(`${target}：これから作る`);
  }
  core.setOutput('branches', pending.join(' '));
  const notes = [...releasedProblems];
  if (manual.length > 0) {
    const list = manual.map((branch) => `\`${branch}\``).join('、');
    notes.push(`手で作られた cherry-pick のブランチ（${list}）があり、PR がまだないので、自動では作り直しませんでした。そのブランチから PR を出してください。`);
  }
  if (notes.length > 0) {
    for (const note of notes) core.warning(note);
    await commentOnce(github, repo, prNumber, [`${mentionsOf(pr)} cherry-pick の行き先について、次のことがありました。`, '', ...notes.map((note) => `- ${note}`)].join('\n'));
  }
}

// backport-action は、PR が squash でマージされたかを「このコミットを含む PR」の API で見分ける。マージの直後で
// まだ反映されていないと見分けられず、PR のコミット（Update branch のマージコミットを含む）をそのまま使って失敗するので、反映を待つ。
async function waitForMergeLink({ github, context, core }) {
  const repo = context.repo;
  const prNumber = Number(process.env.PR_NUMBER);
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber });
  for (let attempt = 0; attempt < 30; attempt++) {
    const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ ...repo, commit_sha: pr.merge_commit_sha });
    if (data.some((pull) => pull.number === prNumber)) return;
    core.info(`マージコミット ${pr.merge_commit_sha.slice(0, 7)} と #${prNumber} の結び付きが GitHub に反映されるのを待っています（${attempt + 1} 回目）。`);
    await sleep(5000);
  }
  core.setFailed(`マージコミットと #${prNumber} の結び付きが GitHub に反映されませんでした。しばらくしてから、Actions の「Cherry-Pick」→「Run workflow」で PR の番号 ${prNumber} を指定してやり直してください。`);
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
  // backport-action は、ステップを失敗にせず、結果も出さずに終わることがある（PR にマージコミットがあると判断したときなど。
  // 理由は元の PR の backport-action のコメントにだけ書かれ、通知は届かない）
  if (env.PENDING_BRANCHES && env.BACKPORT_OUTCOME === 'success' && !env.WAS_SUCCESSFUL) {
    reasons.push('backport-action が結果を出さずに終わりました。元の PR の backport-action のコメントと、実行の記録を確かめてください。');
  }
  if (reasons.length === 0) return;

  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber });
  await github.rest.issues.createComment({
    ...repo,
    issue_number: prNumber,
    body: [`${mentionsOf(pr)} cherry-pick を終えられませんでした（[実行の記録](${runUrlOf(context)})）。`, '', ...reasons.map((reason) => `- ${reason}`), '', manualGuide(prNumber)].join('\n'),
  });
  core.setFailed(reasons.join('\n'));
}

// cherry-pick 先を決めるジョブが失敗したとき、元の PR の作者とマージした人に知らせる
// （マージしていない PR を Run workflow で指定したときは、実行した人が結果を見ているので知らせない）
async function reportTargetsFailure({ github, context }) {
  const repo = context.repo;
  const prNumber = Number(process.env.PR_NUMBER);
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber });
  if (!pr.merged) return;
  await github.rest.issues.createComment({
    ...repo,
    issue_number: prNumber,
    body: [`${mentionsOf(pr)} cherry-pick 先を決められませんでした（[実行の記録](${runUrlOf(context)})）。`, '', manualGuide(prNumber)].join('\n'),
  });
}

module.exports = { findTargets, selectPending, waitForMergeLink, labelPullRequests, reportFailures, reportTargetsFailure };
