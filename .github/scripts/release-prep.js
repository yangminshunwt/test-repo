// release-prep.yml から actions/github-script で呼ぶ処理。
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const { branchExists, compareShas, mergedPullsForCommits, prList, readFile, report } = require('./github-helpers.js');
const { createReleaseBranch, createReleaseLabel } = require('./release-branch.js');
const { compareVersions, extractReleaseLabels, parseReleaseBranch, parseVersionFile, planReleasePrep, setVersion } = require('./release-labels.js');

// リリースブランチと次のバージョンのリリースラベルを作り、作業場所の VERSION を次のバージョンに書き換える。
// やり直したときも続きから進められるよう、すでにあるブランチやラベルはそのまま使う。
async function prepare({ github, context, core }) {
  const repo = context.repo;
  if (context.ref !== 'refs/heads/main') return core.setFailed(`main ブランチで実行してください（今は ${context.ref}）。`);
  const product = process.env.PRODUCT;
  // どのバージョンを準備するかは、実行を始めた時点（Run workflow を押したとき）の main の VERSION で決める。
  // Re-run でも同じになるので、その間に VERSION を上げる PR がマージされていても、次のバージョンの準備を始めない
  const plan = planReleasePrep({ versionFile: (await readFile(github, repo, 'VERSION', context.sha)) ?? '', product, bump: process.env.BUMP });
  if (plan.error) return core.setFailed(plan.error);
  // ブランチと VERSION を上げる PR は、チェックアウトした、ジョブを始めた時点の最新の main から作る
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const versionFile = fs.readFileSync('VERSION', 'utf8');
  const version = parseVersionFile(versionFile)[product];
  if (version === plan.nextVersion && (await branchExists(github, repo, plan.releaseBranch))) {
    // この準備の VERSION を上げる PR は、もうマージされている（Re-run したときなど）。cherry-pick のやり直しだけをする
    await report(core, `${product} のリリースの準備（${plan.currentVersion} → ${plan.nextVersion}）`, [
      `main の VERSION の ${product} はもう ${plan.nextVersion} で、${plan.releaseBranch} もあるので、ブランチと PR は作りません。`,
    ]);
    core.setOutput('bumped', 'true');
    core.setOutput('release_branch', plan.releaseBranch);
    return;
  }
  if (version === plan.nextVersion) {
    return core.setFailed(
      `この準備（${product} の ${plan.currentVersion} → ${plan.nextVersion}）は済んでいて、${plan.releaseBranch} ももうありません（リリースして消したもの）。` +
        'することはありません（Re-run しても同じ結果になります）。',
    );
  }
  if (version !== plan.currentVersion) {
    return core.setFailed(
      `実行を始めたあとに main の VERSION の ${product} が ${plan.currentVersion} から ${version} に変わったので、この準備（${plan.currentVersion} → ${plan.nextVersion}）は進められません（Re-run しても同じ結果になります）。` +
        `${version} のリリースの準備が要るときだけ、Actions の「Release Preparation」→「Run workflow」で新しく実行してください。`,
    );
  }

  // 同じ製品を別のバージョンに上げる PR が開いていると、どちらもマージできてしまうので止める
  const prefix = `release-prep/${product}/`;
  const others = (await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', base: 'main', per_page: 100 })).filter(
    (pull) => pull.head.ref.startsWith(prefix) && pull.head.ref !== `${prefix}v${plan.nextVersion}`,
  );
  if (others.length > 0) {
    return core.setFailed(`${product} の VERSION を上げる PR がほかにも開いています（${prList(others)}）。閉じてから実行し直してください。`);
  }

  const branch = await createReleaseBranch({ github, core, repo, branch: plan.releaseBranch, sha });
  if (!branch) return;
  const results = [branch.result, await createReleaseLabel({ github, repo, label: plan.nextLabel })];
  fs.writeFileSync('VERSION', setVersion(versionFile, product, plan.nextVersion));

  await report(core, `${product} のリリースの準備（${plan.currentVersion} → ${plan.nextVersion}）`, results);
  core.setOutput('current_version', plan.currentVersion);
  core.setOutput('next_version', plan.nextVersion);
  core.setOutput('release_branch', plan.releaseBranch);
  core.setOutput('next_label', plan.nextLabel);
}

// リリースブランチが main から分かれたところより後に main にマージされた PR のうち、このブランチに cherry-pick するはずのもの
// （この製品のラベルのバージョンがこのブランチのバージョン以下）の cherry-pick をやり直す。ブランチを作るまでの間にマージされた PR は、
// cherry-pick の時点でブランチがなかったかもしれないため。やり直し（ブランチがもうあったとき）でも、分かれたところから同じように確かめる。
// cherry-pick.yml は作成済みの行き先を飛ばすので、もう入っている PR をやり直しても重ならない。
async function catchUpCherryPicks({ github, context, core }) {
  const repo = context.repo;
  const branch = process.env.RELEASE_BRANCH;
  const release = parseReleaseBranch(branch);
  const shas = await compareShas(github, repo, `${branch}...main`);
  const { pulls, unmatched } = await mergedPullsForCommits(github, repo, shas, 'main');
  for (const pull of pulls) {
    const { releaseLabels } = extractReleaseLabels(
      pull.labels.map((label) => label.name),
      [release.product],
    );
    if (!releaseLabels.some(({ version }) => compareVersions(version, release.version) <= 0)) continue;
    await github.rest.actions.createWorkflowDispatch({ ...repo, workflow_id: 'cherry-pick.yml', ref: 'main', inputs: { pr_number: String(pull.number) } });
    core.info(`${branch} が main から分かれたあとにマージされた #${pull.number} の cherry-pick をやり直しました。`);
  }
  if (unmatched.length > 0) {
    core.setFailed(
      `main の、${branch} が分かれたあとのコミットのうち、マージした PR が見つからないものがあります（${unmatched.map((sha) => sha.slice(0, 7)).join('、')}）。` +
        `${branch} に cherry-pick が要る変更かを確かめてください（VERSION を上げる PR は作ってあります。この実行はやり直しても重なりません）。`,
    );
  }
}

module.exports = { prepare, catchUpCherryPicks };
