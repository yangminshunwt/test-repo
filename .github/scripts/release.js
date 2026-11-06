// release.yml から actions/github-script で呼ぶ処理（開発ルールの「リリース手順」）。
// スクリプトと main の VERSION は作業場所の直下（main）、リリースブランチは RELEASE_WORK（すべての履歴つき）から読む。
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { mergedPullsOf, prList, report, tagCommit } = require('./github-helpers.js');
const { compareVersions, extractReleaseLabels, parseCherryPickBranch, parseReleaseBranch, parseVersionFile, planRelease } = require('./release-labels.js');

const WORK = process.env.RELEASE_WORK;
const git = (...args) => execFileSync('git', ['-C', WORK, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const isAncestor = (sha, head) => {
  try {
    git('merge-base', '--is-ancestor', sha, head);
    return true;
  } catch {
    return false;
  }
};

async function loadPlan(github, context) {
  const repo = context.repo;
  const branch = context.ref.replace(/^refs\/heads\//, '');
  const product = branch.split('/')[1] ?? '';
  const refs = await github.paginate(github.rest.git.listMatchingRefs, { ...repo, ref: `tags/${product}/v`, per_page: 100 });
  const plan = planRelease({ branch, tags: refs.map((ref) => ref.ref.replace(/^refs\/tags\//, '')) });
  const commitOf = (tag) => tagCommit(github, repo, refs.find((ref) => ref.ref === `refs/tags/${tag}`));
  return { repo, branch, plan, commitOf };
}

async function createTag(github, repo, name, sha, message) {
  const { data: tag } = await github.rest.git.createTag({ ...repo, tag: name, message, object: sha, type: 'commit' });
  await github.rest.git.createRef({ ...repo, ref: `refs/tags/${name}`, sha: tag.sha });
}

// main の VERSION を上げる前にリリースを進めると、そのバージョンのラベルが main で通り続け、変更がどこにも入らなくなる
function checkMainVersion(plan) {
  const mainVersion = parseVersionFile(fs.readFileSync('VERSION', 'utf8'))[plan.product];
  if (mainVersion && compareVersions(mainVersion, plan.version) > 0) return null;
  return `main の VERSION の ${plan.product} が ${mainVersion} のままです。先に main の VERSION を上げる PR（Release prep が作ったもの）をマージしてください。`;
}

// source（main か、同じ製品のより新しいリリースブランチ）にマージされた PR のうち、head に入っていないものを返す。
function pullsNotIn(github, repo, head, source) {
  return mergedPullsOf(github, repo, git('rev-list', `${head}..origin/${source}`).split('\n').filter(Boolean), source);
}

// main とより新しいリリースブランチにマージされた PR のうち、その製品のラベルのバージョンがこのブランチのバージョン以下なのに、
// 変更が head に入っていないもの（cherry-pick の取りこぼし）を返す。
// 入っているかは、元の PR のマージコミットが head の祖先か、head の履歴に cherry-pick の記録（cherry picked from commit）が
// あるか、元の PR の cherry-pick の PR（前のリリースブランチ向けのものも含む）のマージコミットが head の祖先か、で判断する。
async function findMissingChanges(github, repo, head, plan) {
  const picked = new Set([...git('log', head, '--format=%B').matchAll(/cherry picked from commit ([0-9a-f]{40})/g)].map((match) => match[1]));
  const newer = git('for-each-ref', '--format=%(refname:lstrip=3)', `refs/remotes/origin/release/${plan.product}/`)
    .split('\n')
    .filter((name) => {
      const release = parseReleaseBranch(name);
      return release && compareVersions(release.version, plan.version) > 0;
    });
  const missing = [];
  for (const source of ['main', ...newer]) {
    for (const pull of await pullsNotIn(github, repo, head, source)) {
      const { releaseLabels } = extractReleaseLabels(
        pull.labels.map((label) => label.name),
        [plan.product],
      );
      if (!releaseLabels.some(({ version }) => compareVersions(version, plan.version) <= 0)) continue;
      if (picked.has(pull.merge_commit_sha) || isAncestor(pull.merge_commit_sha, head)) continue;
      // 元の PR の cherry-pick の PR（ブランチ名は cherryPickBranch の形）をすべての行き先から探す
      const { data: search } = await github.rest.search.issuesAndPullRequests({
        q: `repo:${repo.owner}/${repo.repo} is:pr is:merged head:cherry-pick-${pull.number}-to-`,
      });
      const merges = await Promise.all(
        search.items.map(async (item) => (await github.rest.pulls.get({ ...repo, pull_number: item.number })).data.merge_commit_sha),
      );
      if (merges.some((sha) => sha && isAncestor(sha, head))) continue;
      missing.push(pull);
    }
  }
  return missing;
}

// リリースブランチの先頭（ジョブを始めた時点の先頭。チェックアウトしたもの）にタグを打つ前に確かめる。
// 問題があれば { error }、なければ確かめた先頭のコミットを { head } で返す。確かめている間にブランチに入ったコミットは
// このタグには入らない（rc なら次の rc に入れ、リリースならリリースに入っていないコミットとして知らせる）。
// afterRelease は、rc なしでリリースするとき（release の手順）。リリースはもう済んでいるので、ブランチに変更を足して
// やり直すようには案内しない（足すと、リリースしていないコミットにリリースタグが付く）。
async function checkBranch(github, repo, branch, plan, { afterRelease = false } = {}) {
  // チェックアウトしたのは、ジョブを始めた時点のリリースブランチの先頭
  const head = git('rev-parse', 'HEAD');
  const version = parseVersionFile(fs.readFileSync(path.join(WORK, 'VERSION'), 'utf8'))[plan.product];
  if (version !== plan.version) {
    const guide = afterRelease
      ? 'rc がないので先頭をリリースしたものとして扱いますが、バージョンが合いません。リリースしたコミットを確かめてください。リリースタグは打っていません。'
      : '先に VERSION を上げる PR をマージしてください。';
    return { error: `${branch} の VERSION の ${plan.product} が ${plan.version} ではありません（${version}）。${guide}` };
  }
  const open = (await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', base: branch, per_page: 100 })).filter(
    (pull) => parseCherryPickBranch(pull.head.ref) !== null,
  );
  if (open.length > 0) {
    const guide = afterRelease
      ? 'リリースしたものには入っていないので、元の PR のリリースラベルをこのブランチより新しいバージョンに付け替えてから、cherry-pick の PR を閉じて実行し直してください（マージすると、リリースしていない変更にリリースタグが付きます）。'
      : 'マージしてから実行し直してください。このリリースに入れない変更なら、元の PR のリリースラベルをこのブランチより新しいバージョンに付け替えてから、cherry-pick の PR を閉じてください。';
    return { error: `${branch} への cherry-pick の PR がまだ開いています（${prList(open)}）。${guide}` };
  }
  const missing = await findMissingChanges(github, repo, head, plan);
  if (missing.length > 0) {
    const guide = afterRelease
      ? 'リリースしたものには入っていないので、その PR のリリースラベルをこのブランチより新しいバージョンに付け替えてから実行し直してください。'
      : '入れるなら、それぞれ Actions の「Cherry-pick」→「Run workflow」で PR の番号を指定してやり直し、できた PR をマージしてください。' +
        '入れないなら、その PR のリリースラベルをこのブランチより新しいバージョンに付け替えてください。そのあと実行し直してください。';
    return { error: `ラベルではこのリリースに入るはずなのに、${branch} に入っていない変更があります（${prList(missing)}）。${guide}` };
  }
  return { head };
}

// 手順 1：リリースブランチの先頭に、次の rc タグを打つ。
async function releaseCandidate({ github, context, core }) {
  const { repo, branch, plan, commitOf } = await loadPlan(github, context);
  if (plan.error) return core.setFailed(plan.error);
  if (plan.released) return core.setFailed(`${plan.releaseTag} はもうリリースされています。`);
  const mainError = checkMainVersion(plan);
  if (mainError) return core.setFailed(mainError);

  const checked = await checkBranch(github, repo, branch, plan);
  if (checked.error) return core.setFailed(checked.error);
  const { head } = checked;

  let message;
  if (plan.latestRcTag && (await commitOf(plan.latestRcTag)) === head) {
    message = `${plan.latestRcTag} がすでに先頭（${head.slice(0, 7)}）にあるので、新しい rc タグは打ちません。この rc でリリース申請してください。`;
  } else {
    await createTag(github, repo, plan.nextRcTag, head, `${plan.product} ${plan.version} release candidate`);
    message = `${plan.nextRcTag} を ${head.slice(0, 7)} に打ちました。この rc でリリース申請してください（release は最後の rc をリリースしたものとして扱うので、申請しない rc は打たないでください）。`;
  }
  await report(core, `${branch} の rc`, [message]);
}

// リリースしたバージョンのリリースラベルをアーカイブする（ラベルを選ぶ画面に出なくなる。付いている PR からは外れない）。
// リリースタグとリリースラベルは同じ名前（<製品名>/vX.Y.Z）。
async function archiveReleaseLabel(github, core, repo, label) {
  try {
    const { data } = await github.rest.issues.getLabel({ ...repo, name: label });
    if (data.archived_at) return `ラベル ${label} はすでにアーカイブされています。`;
    await github.rest.issues.updateLabel({ ...repo, name: label, archived: true });
    return `ラベル ${label} をアーカイブしました。`;
  } catch (error) {
    core.warning(`ラベル ${label} をアーカイブできませんでした（${error.message}）。`);
    return `ラベル ${label} はアーカイブできませんでした。`;
  }
}

// rc より後にリリースブランチに入った PR を、次の修正にどう入れるかの案内を作る
function guideForLateChanges(pulls) {
  const picks = [];
  const direct = [];
  for (const pull of pulls) {
    const original = parseCherryPickBranch(pull.head.ref);
    if (original === null) direct.push(pull);
    else picks.push({ pull, original });
  }
  const guides = [];
  if (picks.length > 0) {
    const originals = picks.map(({ original }) => `#${original}`).join('、');
    guides.push(
      `cherry-pick で入った変更（${prList(picks.map(({ pull }) => pull))}）は、修正フェーズのブランチを作ったあと、元の PR（${originals}）を Cherry-pick の Run workflow でやり直してください。`,
    );
  }
  if (direct.length > 0) {
    guides.push(`このブランチに直接入れた変更（${prList(direct)}）は、修正フェーズのブランチに手で PR を出してください（ラベルはそのブランチのバージョン）。`);
  }
  return guides.join('');
}

// 手順 5・6：リリースタグを打ち、リリースブランチを削除する。
// rc を打っていれば最後の rc と同じコミットに、打っていなければ rc と同じ確認をしてからリリースブランチの先頭に打つ。
// リリースしたコミットより後にブランチに入ったコミットはリリースに入っていないので、そのときはブランチを消さずに知らせる。
async function release({ github, context, core }) {
  const { repo, branch, plan, commitOf } = await loadPlan(github, context);
  if (plan.error) return core.setFailed(plan.error);
  const mainError = checkMainVersion(plan);
  if (mainError) return core.setFailed(mainError);

  const results = [];
  let target;
  if (plan.latestRcTag) {
    target = await commitOf(plan.latestRcTag);
    if (plan.released) {
      if ((await commitOf(plan.releaseTag)) !== target) {
        return core.setFailed(`${plan.releaseTag} が ${plan.latestRcTag} と違うコミットに打たれています。タグを確かめてください。`);
      }
      results.push(`${plan.releaseTag} はすでに ${plan.latestRcTag} と同じコミットにあります。`);
    } else {
      await createTag(github, repo, plan.releaseTag, target, `${plan.product} ${plan.version}`);
      results.push(`${plan.releaseTag} を ${plan.latestRcTag} と同じコミット（${target.slice(0, 7)}）に打ちました。`);
    }
  } else if (plan.released) {
    // rc なしでリリースタグを打ったあと、途中で止まった実行のやり直し。タグがこのブランチのそのバージョンのコミットにあるか確かめる
    target = await commitOf(plan.releaseTag);
    let taggedVersion;
    try {
      taggedVersion = parseVersionFile(git('show', `${target}:VERSION`))[plan.product];
    } catch {
      // VERSION がなければ、このブランチのリリースタグではない
    }
    if (!isAncestor(target, 'HEAD') || taggedVersion !== plan.version) {
      return core.setFailed(`${plan.releaseTag} が ${branch} の ${plan.version} のコミットではないところに打たれています。タグを確かめてください。`);
    }
    results.push(`${plan.releaseTag} はすでにあります（${target.slice(0, 7)}）。`);
  } else {
    const checked = await checkBranch(github, repo, branch, plan, { afterRelease: true });
    if (checked.error) return core.setFailed(checked.error);
    target = checked.head;
    await createTag(github, repo, plan.releaseTag, target, `${plan.product} ${plan.version}`);
    results.push(`rc タグがないので、${branch} の先頭（${target.slice(0, 7)}）に ${plan.releaseTag} を打ちました。`);
  }
  results.push(await archiveReleaseLabel(github, core, repo, plan.releaseTag));

  // このジョブはリリースブランチをチェックアウトして動くので、ブランチはある
  const head = (await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` })).data.object.sha;
  let lateError = null;
  if (head !== target) {
    const late = await pullsNotIn(github, repo, target, branch);
    lateError =
      `${branch} には ${plan.latestRcTag ?? plan.releaseTag} より後のコミットがあり、今回のリリースには入っていません（${prList(late) || '不明'}）。ブランチは消していません。` +
      `次の修正に入れるなら、管理者がこのブランチを削除して Hotfix prep を実行してください。${guideForLateChanges(late)}`;
  } else {
    const open = await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', base: branch, per_page: 100 });
    if (open.length > 0) core.warning(`${branch} に向けた開いている PR（${prList(open)}）は、ブランチの削除で閉じられます。`);
    await github.rest.git.deleteRef({ ...repo, ref: `heads/${branch}` });
    results.push(`${branch} を削除しました。`);
  }
  await report(core, `${plan.releaseTag} のリリース`, results);
  if (lateError) core.setFailed(lateError);
}

module.exports = { releaseCandidate, release };
