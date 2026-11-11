// release-label-check.yml と ci.yml から actions/github-script で呼ぶ。
// 作業場所には、PR の先頭（マージキューでは、マージグループのコミット）を、すべての履歴（ほかのブランチも）つきで取ってある。
// マージ後の中身は、マージ前の中身（findBase の before）と作業場所の先頭を手元でマージして作る（GitHub がテスト用のマージコミットを作るのを待たない）。
// - pull_request：マージ前の中身は、今のマージ先の先頭。ルールセットで「マージ先の最新を取り込んでから」マージするので、
//   マージできるときは PR の先頭の中身と同じになる（マージキューを使う main では、最新に合わせなくてもキューに入れられるので、
//   main に入る中身は下の merge_group で確かめる）。
// - merge_group（マージキュー）：マージ前の中身は、マージグループの親（マージ先に、キューで前にある PR を足したもの）。
//   マージグループのコミットがそのままマージ先に入るので、手元でマージしても中身は変わらない。親からの変更は、この PR の変更だけになる。
'use strict';

const { git, localReleaseBranches } = require('./github-helpers.js');
const { checkReleaseLabels, findAffectedProducts, parseMergeQueueBranch, parseVersionFile } = require('./rules.js');

// PR の今のマージ先とラベル（イベントの後に変わっていても今の状態で判定するため、API で取り直す）と、
// マージ前の中身（before）と、作業場所の先頭とマージ前の中身との分かれ目（paths-filter が変更を探す起点）を出力する。
async function findBase({ github, context, core }) {
  const group = context.payload.merge_group;
  const number = group ? parseMergeQueueBranch(group.head_ref) : context.payload.pull_request.number;
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
  const baseRef = group ? group.base_ref.replace(/^refs\/heads\//, '') : pr.base.ref;
  const before = group ? group.base_sha : git('rev-parse', `refs/remotes/origin/${baseRef}`);
  core.setOutput('base_ref', baseRef);
  core.setOutput('before', before);
  core.setOutput('base_sha', git('merge-base', 'HEAD', before));
  core.setOutput('labels', JSON.stringify(pr.labels.map((label) => label.name)));
}

async function check({ core }) {
  const env = process.env;
  const baseBranch = env.BASE_REF;
  const before = env.BEFORE;
  const labels = JSON.parse(env.LABELS);
  let merged;
  try {
    merged = git('merge-tree', '--write-tree', before, 'HEAD').split('\n')[0];
  } catch {
    return core.setFailed(`${baseBranch} とコンフリクトしています。解消して push すると、もう一度チェックします。`);
  }
  const versionFile = git('show', `${merged}:VERSION`);
  const affected = findAffectedProducts({
    matched: JSON.parse(env.AFFECTED_PRODUCTS),
    products: Object.keys(parseVersionFile(versionFile)),
    allFileCount: Number(env.ALL_FILE_COUNT),
    listedFileCount: Number(env.LISTED_FILE_COUNT),
  });
  const { errors } = checkReleaseLabels({
    baseBranch,
    labels,
    affectedProducts: affected.products,
    versionFile,
    baseVersionFile: git('show', `${before}:VERSION`),
    branches: localReleaseBranches(),
  });

  await core.summary
    .addHeading('リリースラベルのチェック', 3)
    .addTable([
      [{ data: '項目', header: true }, { data: '内容', header: true }],
      ['マージ先', baseBranch],
      ['影響する製品', affected.products.join('、') || '（なし）'],
      ['ラベル', labels.join('、') || '（なし）'],
      ['結果', errors.length === 0 ? 'OK' : `NG（${errors.length} 件）`],
    ])
    .addList(affected.reason ? [affected.reason, ...errors] : errors)
    .write();
  if (affected.reason) core.warning(affected.reason);
  for (const error of errors) core.error(error);
  if (errors.length > 0) core.setFailed(`リリースラベルのルールを満たしていません（${errors.length} 件）。`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// release-label-recheck.yml から呼ぶ。ラベルのチェックの結果は、マージ先の VERSION と今あるリリースブランチでも変わるが、
// それらが変わっても PR のイベントは起きない。そこで、リリースブランチを作ったり削除したりしたとき（create・delete）と、
// main やリリースブランチの VERSION が変わったとき（push）に、影響する開いている PR の、今の先頭での最後のチェックをやり直す。
// ラベルは変えない（ラベルは PR を出した人が決めるもの）。
async function recheck({ github, context, core }) {
  const repo = context.repo;
  // push はそのブランチに向けた PR、リリースブランチの create・delete は main とリリースブランチに向けたすべての PR
  const pushed = context.eventName === 'push' ? context.ref.replace(/^refs\/heads\//, '') : null;
  const pulls = (await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', per_page: 100 })).filter((pull) =>
    pushed ? pull.base.ref === pushed : pull.base.ref === 'main' || pull.base.ref.startsWith('release/'),
  );
  const failed = [];
  for (const pull of pulls) {
    const { data } = await github.rest.actions.listWorkflowRuns({ ...repo, workflow_id: 'release-label-check.yml', head_sha: pull.head.sha, per_page: 1 });
    let run = data.workflow_runs[0];
    if (!run) continue; // まだ動いていない（これから動く実行は、今の状態で判定する）
    // 動いている実行は、変わる前の状態を読んだかもしれないので、終わるのを待ってからやり直す
    for (let attempt = 0; attempt < 60 && run.status !== 'completed'; attempt++) {
      await sleep(5000);
      run = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: run.id })).data;
    }
    try {
      await github.rest.actions.reRunWorkflow({ ...repo, run_id: run.id });
      core.info(`#${pull.number}：ラベルのチェックをやり直しました（実行 ${run.id}）。`);
    } catch (error) {
      failed.push(`#${pull.number}（${error.message}）`);
    }
  }
  if (failed.length > 0) {
    core.setFailed(`ラベルのチェックをやり直せなかった PR があります。ラベルを付け直すか push して、チェックをやり直してください：${failed.join('、')}`);
  }
}

module.exports = { findBase, check, recheck };
