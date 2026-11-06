// cherry-pick.yml から actions/github-script で呼ぶ処理。
'use strict';

const { deleteBranchIfAt, listReleaseBranches, listReleaseBranchHeads, mentionsOf, readFile, tagCommit } = require('./github-helpers.js');
const { cherryPickBranch, compareVersions, findCherryPickTargets, parseCherryPickBranch, parseReleaseBranch, parseVersionFile } = require('./release-labels.js');

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

// 元の PR の変更を運んだコミット（元の PR のマージコミットと、マージした cherry-pick の PR のマージコミット）を返す。
// cherry-pick の PR を探すのは、ラベルの製品の、今あるリリースブランチ・ラベルのバージョンのリリースブランチ・リリースした
// バージョンのリリースブランチ（どちらも、もう消したものも）。行き先ごとに API を呼ばないよう、GraphQL で
// BRANCHES_PER_QUERY 件ずつまとめて探す（1 回の問い合わせで最大 50 × 10 ノード。GitHub の上限よりずっと少ない）
const BRANCHES_PER_QUERY = 50;
async function changeCommits(github, repo, pr, branches, tags) {
  const labels = pr.labels.map(({ name }) => name).filter((name) => /^[^/]+\/v\d+\.\d+\.\d+$/.test(name));
  const products = new Set(labels.map((label) => label.split('/v')[0]));
  const names = [
    ...new Set([
      ...branches.filter((branch) => products.has(parseReleaseBranch(branch)?.product)),
      ...[...labels, ...tags.keys()].filter((label) => products.has(label.split('/v')[0])).map((label) => `release/${label}`),
    ]),
  ];
  const shas = [pr.merge_commit_sha];
  for (let start = 0; start < names.length; start += BRANCHES_PER_QUERY) {
    const fields = names.slice(start, start + BRANCHES_PER_QUERY).map(
      (name, index) =>
        `b${index}: pullRequests(headRefName: ${JSON.stringify(cherryPickBranch(pr.number, name))}, baseRefName: ${JSON.stringify(name)}, states: MERGED, first: 10) { nodes { isCrossRepository mergeCommit { oid } } }`,
    );
    const { repository } = await github.graphql(`query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields.join(' ')} } }`, {
      owner: repo.owner,
      repo: repo.repo,
    });
    for (const { nodes } of Object.values(repository)) {
      for (const node of nodes) if (!node.isCrossRepository && node.mergeCommit) shas.push(node.mergeCommit.oid);
    }
  }
  return shas;
}

// ref（コミット）に、変更を運んだコミットのどれかが入っているか（祖先か同じか）。時刻ではなく、コミットのつながりで決める
async function containsChange(github, repo, shas, ref) {
  for (const sha of shas) {
    let status;
    try {
      ({ status } = (await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${sha}...${ref}`, per_page: 1 })).data);
    } catch (error) {
      if (error.status === 404) continue; // ref はあるコミットなので、404 は運んだコミットがもうない（ref にも入っていない）
      throw error;
    }
    if (status === 'ahead' || status === 'identical') return true;
  }
  return false;
}

// 修正フェーズのバージョンのラベル。Hotfix Preparation は、いちばん新しいリリースタグの次のパッチで作る
function fixPhaseLabel(product, releasedVersion) {
  const [major, minor, patch] = releasedVersion.split('.').map(Number);
  return `${product}/v${major}.${minor}.${patch + 1}`;
}

// リリース（releasedVersion）に入らなかった cherry-pick の元の PR を、修正フェーズでやり直すときに、元の PR のラベルを
// どうするかを今の状態から決めて返す。ラベルのバージョンより前のリリースブランチには cherry-pick しないので、ラベルをそのままに
// できるのは、ラベルがリリースしたバージョンより前で、まだリリースしていないか、そのリリースにこの変更が入っているときだけ。
// それ以外（リリースしたバージョンか、それより新しいか、この変更を含まずにリリースされたバージョン）は、修正フェーズのバージョンにする
async function fixPhaseLabelGuide(github, repo, originalNumber, product, releasedVersion) {
  const fixLabel = fixPhaseLabel(product, releasedVersion);
  let original;
  try {
    ({ data: original } = await github.rest.pulls.get({ ...repo, pull_number: originalNumber }));
  } catch (error) {
    if (error.status !== 404) throw error;
    return `#${originalNumber} のリリースラベルを ${fixLabel} にする`;
  }
  const label = original.labels.map(({ name }) => name).find((name) => name.startsWith(`${product}/v`) && /^[^/]+\/v\d+\.\d+\.\d+$/.test(name));
  if (label && compareVersions(label.split('/v')[1], releasedVersion) < 0) {
    const tags = await releaseTags(github, repo, [product]);
    const tag = tags.get(label);
    const branches = await listReleaseBranches(github, repo);
    if (!tag || (await containsChange(github, repo, await changeCommits(github, repo, original, branches, tags), await tagCommit(github, repo, tag)))) {
      return `#${originalNumber} のリリースラベル（${label}）はそのままにする`;
    }
  }
  return `#${originalNumber} のリリースラベル${label ? `（${label}）` : ''}を ${fixLabel} にする`;
}

// リリース済みで、この変更を含まないバージョンのラベルの案内
async function releasedLabelProblem(github, repo, pr, label) {
  const base = parseReleaseBranch(pr.base.ref);
  const original = parseCherryPickBranch(pr.head.ref);
  const head = `${label}：このバージョンは、この変更を含まずにリリースされています。`;
  const hotfix = '修正フェーズに入れるなら、Hotfix Preparation でブランチを作ったあと、そのブランチのバージョンにします';
  if (!base) return `${head}この変更が最初に入るリリースのバージョンに付け替えてから、Cherry-Pick の Run workflow でやり直してください（${hotfix}）。`;
  if (label === `${base.product}/v${base.version}`) {
    const next =
      original !== null
        ? `修正フェーズに入れるなら、Hotfix Preparation でブランチを作ったあと、${await fixPhaseLabelGuide(github, repo, original, base.product, base.version)}。そのあと Cherry-Pick の Run workflow で #${original} をやり直してください。`
        : `修正フェーズに入れるなら、Hotfix Preparation で作るブランチに、ラベル ${fixPhaseLabel(base.product, base.version)} を付けて PR を出し直してください。`;
    return `${head}マージ先の ${pr.base.ref} がリリース済みなので、ここに入れた変更はどのリリースにも入りません。${next}`;
  }
  return `${head}${label} の修正フェーズに入れるなら、Hotfix Preparation でブランチを作ったあと、そのブランチのバージョンに付け替えて、Cherry-Pick の Run workflow でやり直してください。入れないなら、この変更が最初に入る ${base.product}/v${base.version} に付け替えてください。`;
}

// 元の PR の cherry-pick 先を今の状態から決め、{ error } か { targets, problems } を返す。targets ジョブと cherry-pick ジョブ
// （Re-run failed jobs では、targets ジョブの結果が前の実行のままなので）の両方から使う。
async function computeTargets(github, repo, pr) {
  const versionFile = await readFile(github, repo, 'VERSION', pr.merge_commit_sha);
  if (versionFile === null) return { error: `#${pr.number} をマージしたコミットに VERSION がありません。` };
  // 行き先のブランチは、この一覧の時点の先頭で確かめる（途中でブランチが消されても、判断が食い違わない）
  const heads = await listReleaseBranchHeads(github, repo);
  const branches = [...heads.keys()];
  const tags = await releaseTags(github, repo, Object.keys(parseVersionFile(versionFile)));

  const carriers = await changeCommits(github, repo, pr, branches, tags);
  const inRelease = async (tag) => containsChange(github, repo, carriers, await tagCommit(github, repo, tag));

  // リリース済みで、この変更を含まないバージョンのラベルは使わない
  const labels = [];
  const problems = [];
  for (const { name } of pr.labels) {
    const tag = tags.get(name);
    if (tag && !(await inRelease(tag))) problems.push(await releasedLabelProblem(github, repo, pr, name));
    else labels.push(name);
  }

  const found = findCherryPickTargets({ baseBranch: pr.base.ref, labels, versionFile, branches });
  problems.push(...found.problems);
  const targets = [];
  for (const target of found.targets) {
    const release = parseReleaseBranch(target);
    const tag = tags.get(`${release.product}/v${release.version}`);
    // リリース済みの行き先（リリースより後のコミットがあって残しているブランチ）に入れても、どのリリースにも入らない
    if (tag) {
      if (!(await inRelease(tag))) problems.push(`${target} はリリース済み（タグがあります）なので、cherry-pick しません。この変更は v${release.version} には入っていません。`);
      continue;
    }
    // もう入っている行き先（この変更より後に作ったブランチ、この変更が入ったタグから作った修正フェーズのブランチ、
    // マージした cherry-pick の PR があるブランチ）には、cherry-pick しない
    if (await containsChange(github, repo, carriers, heads.get(target))) continue;
    targets.push(target);
  }
  for (const { label, product, version } of found.missing) {
    // リリース済みなら、この変更はそのリリースに入っている（入っていなければ、上でラベルを使わないことにしている）
    if (tags.has(label)) continue;
    // リリース前に cherry-pick してあり、そのあとブランチを消しただけなら問題ない
    const merged = (await findCherryPickPulls(github, repo, pr.number, `release/${product}/v${version}`, 'closed')).find((pull) => pull.merged_at);
    if (merged) continue;
    problems.push(
      `${label}：${product} に v${version} のリリースブランチがないので、この変更は v${version} には入っていません（リリース済みか、まだ作っていない可能性があります）。`,
    );
  }
  for (const target of targets) {
    // 修正フェーズのブランチで VERSION をまだ上げていなければ、cherry-pick の PR はラベルのチェックで止まる
    const release = parseReleaseBranch(target);
    const targetVersionFile = await readFile(github, repo, 'VERSION', heads.get(target));
    if (targetVersionFile === null || parseVersionFile(targetVersionFile)[release.product] !== release.version) {
      problems.push(
        `${target} の VERSION がまだ ${release.version} になっていません。VERSION を上げる PR がマージされたあと、cherry-pick の PR で \`gh pr update-branch <番号>\` を実行して、チェックをやり直してください。`,
      );
    }
  }
  return { targets, problems };
}

// まだコメントしていない項目だけを、見出しを付けてコメントする（やり直すたびに同じ知らせが増えないように）
async function commentNew(github, repo, issueNumber, heading, items, footer = '') {
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: issueNumber, per_page: 100 });
  const fresh = items.filter((item) => !comments.some((comment) => comment.body.includes(item)));
  if (fresh.length === 0) return;
  const body = [heading, '', ...fresh.map((item) => `- ${item}`), ...(footer ? ['', footer] : [])].join('\n');
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
  const result = await computeTargets(github, repo, pr);
  if (result.error) return core.setFailed(result.error);
  const { targets, problems } = result;

  await core.summary
    .addHeading(`#${prNumber} の cherry-pick 先`, 3)
    .addList(targets.length > 0 ? targets : ['（なし）'])
    .addList(problems)
    .write();

  // コメントに失敗しても、決められた行き先への cherry-pick は続けられるよう、先に出力する
  core.setOutput('all_branches', targets.join(' '));

  if (problems.length > 0) {
    for (const problem of problems) core.warning(problem);
    try {
      await commentNew(github, repo, prNumber, `${mentionsOf(pr)} cherry-pick 先を決めるときに、次の問題がありました。`, problems, manualGuide(prNumber));
    } catch (error) {
      core.warning(`#${prNumber} にコメントできませんでした：${error.message}`);
    }
  }
}

// 行き先を今の状態から決め直し、まだ cherry-pick の PR がない行き先を branches に、行き先すべてを targets に（どちらもスペース区切り）出力する。
// やり直し（Re-run・Run workflow）でも同じ行き先へ PR を重ねて作らないよう、cherry-pick の直前に今の状態で決める。
// PR のない cherry-pick のブランチが残っていて、閉じた（マージしていない）PR のものか、自動化が作ったものなら消す。
// 残っていると、backport-action がその古い中身で PR を作り直すため。人が手で作ったブランチ（PR はまだない）は消さずに知らせる。
async function selectPending({ github, context, core }) {
  const repo = context.repo;
  const prNumber = Number(process.env.PR_NUMBER);
  const pending = [];
  const manual = [];
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber });
  // 「Re-run failed jobs」では targets ジョブの結果が前の実行のままなので、行き先をここでも今の状態から決め直す
  const result = await computeTargets(github, repo, pr);
  if (result.error) return core.setFailed(result.error);
  // 下で失敗しても、前の実行で作った cherry-pick の PR にラベルを付けられるよう、先に出力する
  core.setOutput('targets', result.targets.join(' '));
  for (const target of result.targets) {
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
  const notes = [...result.problems];
  if (manual.length > 0) {
    const list = manual.map((branch) => `\`${branch}\``).join('、');
    notes.push(`手で作られた cherry-pick のブランチ（${list}）があり、PR がまだないので、自動では作り直しませんでした。そのブランチから PR を出してください。`);
  }
  if (notes.length > 0) {
    for (const note of notes) core.warning(note);
    // コメントに失敗しても、ほかの行き先への cherry-pick は続ける（出力はもう出してある）
    try {
      await commentNew(github, repo, prNumber, `${mentionsOf(pr)} cherry-pick の行き先について、次のことがありました。`, notes);
    } catch (error) {
      core.warning(`#${prNumber} にコメントできませんでした：${error.message}`);
    }
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

module.exports = { fixPhaseLabel, fixPhaseLabelGuide, findTargets, selectPending, waitForMergeLink, labelPullRequests, reportFailures, reportTargetsFailure };
