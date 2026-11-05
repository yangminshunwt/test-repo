// release.yml から actions/github-script で呼ぶ処理（開発ルールの「リリース手順」）。
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const { tagCommit } = require('./release-branch.js');
const { compareVersions, extractReleaseLabels, parseVersionFile, planRelease } = require('./release-labels.js');

const list = (pulls) => pulls.map((pull) => `#${pull.number}`).join('、');

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

// base から head までに入ったコミットの PR（マージ済み）を返す
async function mergedPullsBetween(github, repo, base, head, { into }) {
  const pulls = new Map();
  for (let page = 1; ; page++) {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${base}...${head}`, per_page: 100, page });
    for (const commit of data.commits) {
      const { data: associated } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ ...repo, commit_sha: commit.sha });
      for (const pull of associated) {
        if (pull.merged_at && pull.base.ref === into) pulls.set(pull.number, pull);
      }
    }
    if (data.commits.length < 100) break;
  }
  return [...pulls.values()];
}

// main にマージされたのに、このリリースブランチに入っていない変更（cherry-pick の取りこぼし）を探す。
// リリースブランチを作った後に main に入った PR のうち、その製品のラベルのバージョンがこのブランチのバージョン以下のものは、
// cherry-pick の PR（cherry-pick-<番号>-to-<ブランチ>）がマージされていなければならない。
async function findMissingCherryPicks(github, repo, branch, plan) {
  const missing = [];
  for (const pull of await mergedPullsBetween(github, repo, branch, 'main', { into: 'main' })) {
    const { releaseLabels } = extractReleaseLabels(
      pull.labels.map((label) => label.name),
      [plan.product],
    );
    if (!releaseLabels.some(({ version }) => compareVersions(version, plan.version) <= 0)) continue;
    const { data: picks } = await github.rest.pulls.list({
      ...repo,
      state: 'closed',
      base: branch,
      head: `${repo.owner}:cherry-pick-${pull.number}-to-${branch}`,
    });
    if (!picks.some((pick) => pick.merged_at)) missing.push(pull);
  }
  return missing;
}

// 手順 1：リリースブランチの先頭に、次の rc タグを打つ。
async function releaseCandidate({ github, context, core }) {
  const { repo, branch, plan, commitOf } = await loadPlan(github, context);
  if (plan.errors.length > 0) return core.setFailed(plan.errors.join('\n'));
  if (plan.released) return core.setFailed(`${plan.releaseTag} はもうリリースされています。`);

  // チェックアウトしたのは、ジョブを始めた時点のリリースブランチの先頭
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const version = parseVersionFile(fs.readFileSync('VERSION', 'utf8'))[plan.product];
  if (version !== plan.version) {
    return core.setFailed(`${branch} の VERSION の ${plan.product} が ${plan.version} ではありません（${version}）。先に VERSION を上げる PR をマージしてください。`);
  }
  const open = (await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', base: branch, per_page: 100 })).filter((pull) =>
    pull.head.ref.startsWith('cherry-pick-'),
  );
  if (open.length > 0) {
    return core.setFailed(`${branch} への cherry-pick の PR がまだ開いています（${list(open)}）。マージするか、このリリースに入れないなら閉じてから、実行し直してください。`);
  }
  const missing = await findMissingCherryPicks(github, repo, branch, plan);
  if (missing.length > 0) {
    return core.setFailed(
      `main にマージされたのに ${branch} に入っていない変更があります（${list(missing)}）。それぞれ Actions の「Cherry-pick」→「Run workflow」で PR の番号を指定してやり直し、できた PR をマージしてから実行し直してください。`,
    );
  }

  if (plan.latestRcTag && (await commitOf(plan.latestRcTag)) === head) {
    core.info(`${plan.latestRcTag} がすでに先頭（${head.slice(0, 7)}）にあるので、新しい rc タグは打ちません。`);
    await core.summary.addHeading(`${branch} の rc`, 3).addList([`${plan.latestRcTag} がすでに先頭にあります。この rc でリリース申請してください。`]).write();
    return;
  }
  await createTag(github, repo, plan.nextRcTag, head, `${plan.product} ${plan.version} release candidate`);
  core.info(`${plan.nextRcTag} を ${head.slice(0, 7)} に打ちました。`);
  await core.summary.addHeading(`${branch} の rc`, 3).addList([`${plan.nextRcTag} を ${head.slice(0, 7)} に打ちました。この rc でリリース申請してください。`]).write();
}

// 手順 5・6：最後の rc タグと同じコミットにリリースタグを打ち、リリースブランチを削除する。
// rc より後にブランチに入ったコミットはリリースに入っていないので、そのときはブランチを消さずに知らせる。
async function release({ github, context, core }) {
  const { repo, branch, plan, commitOf } = await loadPlan(github, context);
  if (plan.errors.length > 0) return core.setFailed(plan.errors.join('\n'));
  if (!plan.latestRcTag) return core.setFailed(`${plan.product} ${plan.version} の rc タグがまだありません。先に rc を実行してください。`);

  const results = [];
  const rc = await commitOf(plan.latestRcTag);
  if (plan.released) {
    if ((await commitOf(plan.releaseTag)) !== rc) {
      return core.setFailed(`${plan.releaseTag} が ${plan.latestRcTag} と違うコミットに打たれています。タグを確かめてください。`);
    }
    results.push(`${plan.releaseTag} はすでに ${plan.latestRcTag} と同じコミットにあります。`);
  } else {
    await createTag(github, repo, plan.releaseTag, rc, `${plan.product} ${plan.version}`);
    results.push(`${plan.releaseTag} を ${plan.latestRcTag} と同じコミット（${rc.slice(0, 7)}）に打ちました。`);
  }

  let head;
  try {
    head = (await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` })).data.object.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (head && head !== rc) {
    const after = await mergedPullsBetween(github, repo, rc, branch, { into: branch });
    await core.summary.addHeading(`${plan.releaseTag} のリリース`, 3).addList(results).write();
    return core.setFailed(
      `${branch} には ${plan.latestRcTag} より後のコミットがあり、今回のリリースには入っていません（${list(after) || '不明'}）。ブランチは消していません。` +
        `その変更を次の修正に入れるなら、管理者がこのブランチを削除して Hotfix prep を実行し、元の PR を Cherry-pick の Run workflow でやり直してください。`,
    );
  }
  if (head) {
    const open = await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', base: branch, per_page: 100 });
    if (open.length > 0) core.warning(`${branch} に向けた開いている PR（${list(open)}）は、ブランチの削除で閉じられます。`);
    await github.rest.git.deleteRef({ ...repo, ref: `heads/${branch}` });
    results.push(`${branch} を削除しました。`);
  } else {
    results.push(`${branch} はすでに削除されています。`);
  }
  for (const line of results) core.info(line);
  await core.summary.addHeading(`${plan.releaseTag} のリリース`, 3).addList(results).write();
}

module.exports = { releaseCandidate, release };
