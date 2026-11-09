// cherry-pick.yml から actions/github-script で呼ぶ処理。
'use strict';

const { containsChange, listMergedPulls } = require('./changes.js');
const { branchHead, deleteBranchIfAt, localReleaseBranches } = require('./github-helpers.js');
const { cherryPickBranch, findCherryPickTargets } = require('./release-labels.js');

// backport-action が cherry-pick のコミットに使う committer（action.yml の git_committer_email の既定）
const AUTOMATION_COMMITTER = 'github-actions[bot]@users.noreply.github.com';

const prNumber = () => Number(process.env.PR_NUMBER);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function manualGuide(number) {
  return [
    `手で cherry-pick するときは、行き先のブランチから \`${cherryPickBranch(number, '<行き先のブランチ>')}\` という名前の作業ブランチを作って cherry-pick し、行き先のブランチのバージョンのリリースラベル（例：\`release/product-a/v1.4.0\` なら \`product-a/v1.4.0\`）を付けて PR を出してください。この名前にしておくと、自動でやり直したときに重ねて作られません。`,
    `原因を直して自動でやり直すときは、Actions の「Cherry-Pick」→「Run workflow」で、PR の番号 ${number} を指定してください。`,
    '行き先のブランチがもうない（リリースして削除された）ときは、手での cherry-pick もやり直しも要りません（ブランチも作り直さないでください）。変更はそのリリースには入っておらず、修正フェーズに入れるときは Hotfix Preparation が自動で cherry-pick します。',
  ].join('\n\n');
}

function cherryPickPulls(github, repo, target, state) {
  return github.paginate(github.rest.pulls.list, { ...repo, state, head: `${repo.owner}:${cherryPickBranch(prNumber(), target)}`, per_page: 100 });
}

// 元の PR の cherry-pick 先を決めて出力する（今あるリリースブランチと、変更が入っているかは、どちらもチェックアウトした時点のものを見る。
// そのあとに作られたブランチには、作った Release Preparation・Hotfix Preparation が、入っていない変更の Cherry-Pick を実行する）。
// targets：リリースラベルが表す範囲の、今あるリリースブランチ（cherry-pick の PR にラベルを付ける行き先）
// branches：そのうち、cherry-pick の PR が開いてもマージされてもいなくて、変更もまだ入っていない行き先（これから cherry-pick する）
// 前の実行の残りのブランチ（閉じた PR のものか、自動化が作ったもの）は消す。残っていると backport-action がその古い中身で PR を作るため。
// 人が作ったブランチは消さない（backport-action が、そのブランチで PR を作る）。
async function selectTargets({ github, context, core }) {
  const repo = context.repo;
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber() });
  if (!pr.merged) return core.setFailed(`#${pr.number} はマージされていません。`);
  const targets = findCherryPickTargets({ base: pr.base.ref, head: pr.head.ref, labels: pr.labels.map((label) => label.name) }, localReleaseBranches());
  core.setOutput('targets', targets.join(' '));

  const pulls = targets.length > 0 ? await listMergedPulls(github, repo) : [];
  const pending = [];
  for (const target of targets) {
    const existing = await cherryPickPulls(github, repo, target, 'all');
    if (existing.some((pull) => pull.state === 'open' || pull.merged_at)) {
      core.info(`${target}：cherry-pick の PR があります。`);
    } else if (containsChange(pulls, { number: pr.number, mergeCommit: pr.merge_commit_sha }, `refs/remotes/origin/${target}`)) {
      core.info(`${target}：変更はもう入っています。`);
    } else {
      const branch = cherryPickBranch(pr.number, target);
      const sha = await branchHead(github, repo, branch);
      if (sha) {
        const { data: commit } = await github.rest.git.getCommit({ ...repo, commit_sha: sha });
        if ((existing.some((pull) => pull.head.sha === sha) || commit.committer.email === AUTOMATION_COMMITTER) && (await deleteBranchIfAt(github, repo, branch, sha))) {
          core.info(`${target}：前の実行の残りの ${branch} を消しました。`);
        }
      }
      pending.push(target);
      core.info(`${target}：これから cherry-pick します。`);
    }
  }
  if (pending.length > 0 && !(await waitForMergeLink(github, repo, core, pr))) return;
  core.setOutput('branches', pending.join(' '));
}

// backport-action は、PR が squash でマージされたかを「このコミットを含む PR」の API で見分ける。マージの直後で
// まだ反映されていないと見分けられず、PR のコミット（Update branch のマージコミットを含む）をそのまま使って失敗するので、反映を待つ。
async function waitForMergeLink(github, repo, core, pr) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ ...repo, commit_sha: pr.merge_commit_sha });
    if (data.some((pull) => pull.number === pr.number)) return true;
    core.info(`マージコミット ${pr.merge_commit_sha.slice(0, 7)} と #${pr.number} の結び付きが GitHub に反映されるのを待っています（${attempt + 1} 回目）。`);
    await sleep(5000);
  }
  core.setFailed(`マージコミットと #${pr.number} の結び付きが GitHub に反映されませんでした。しばらくしてから、Actions の「Cherry-Pick」→「Run workflow」で PR の番号 ${pr.number} を指定してやり直してください。`);
  return false;
}

// cherry-pick の PR に、行き先のブランチのバージョンのリリースラベルを付ける（リリースブランチへの PR にはそのブランチの製品のラベルが要り、
// 元の PR のバージョンはリリース済みでブランチがないことがあるため）。前の実行で作られた PR にも付けるため、行き先ごとにブランチ名から探す。
async function labelPullRequests({ github, context }) {
  const repo = context.repo;
  for (const target of process.env.TARGETS.split(' ').filter(Boolean)) {
    for (const pull of await cherryPickPulls(github, repo, target, 'open')) {
      await github.rest.issues.addLabels({ ...repo, issue_number: pull.number, labels: [target.slice('release/'.length)] });
    }
  }
}

// cherry-pick を終えられなかったとき、元の PR の作者とマージした人に知らせる。
// backport-action のコメントはあとから書き換えられて通知が届かないので、新しいコメントを作る。
async function reportFailures({ github, context, core }) {
  const repo = context.repo;
  const env = process.env;
  const reasons = [];
  if (env.APP_TOKEN_OUTCOME === 'failure') {
    reasons.push('GitHub App のトークンを作れませんでした。App とリポジトリの設定（CHERRY_PICK_APP_CLIENT_ID・CHERRY_PICK_APP_PRIVATE_KEY）を確かめてください。');
  } else if (env.JOB_STATUS === 'failure') {
    reasons.push('途中のステップが失敗しました。実行の記録を確かめてください。');
  }
  // backport-action は、一部の行き先に cherry-pick できなくてもステップを失敗にせず、結果に false を記録するだけなので、ここで拾う
  // （コンフリクトして draft の PR を作った行き先は true になるので、ここでは知らせない）
  for (const line of (env.RESULTS || '').split('\n')) {
    if (line.endsWith('=false')) reasons.push(`${line.slice(0, -'=false'.length)} に cherry-pick できませんでした。`);
  }
  // 行き先を 1 つも処理せずに終わることもある（PR のコミットにマージコミットがあると判断したときなど。理由は backport-action のコメントにだけ
  // 書かれる）。そのときだけ was_successful も出さない（すべての行き先を飛ばしたとき＝もう入っていたときは、was_successful は出す）
  if (env.BACKPORT_OUTCOME === 'success' && !env.WAS_SUCCESSFUL) {
    reasons.push('backport-action が結果を出さずに終わりました。元の PR の backport-action のコメントと、実行の記録を確かめてください。');
  }
  if (reasons.length === 0) return;

  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber() });
  if (!pr.merged) return; // マージしていない PR を Run workflow で指定したとき（実行した人が結果を見ている）
  const mentions = [...new Set([pr.user.login, pr.merged_by?.login].filter(Boolean))].map((login) => `@${login}`).join(' ');
  const runUrl = `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  await github.rest.issues.createComment({
    ...repo,
    issue_number: pr.number,
    body: [`${mentions} cherry-pick を終えられませんでした（[実行の記録](${runUrl})）。`, '', ...reasons.map((reason) => `- ${reason}`), '', manualGuide(pr.number)].join('\n'),
  });
  core.setFailed(reasons.join('\n'));
}

module.exports = { selectTargets, labelPullRequests, reportFailures };
