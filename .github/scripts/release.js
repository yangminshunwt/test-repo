// release.yml から actions/github-script で呼ぶ処理（開発ルールの「リリース手順」）。
// 作業場所に、実行したリリースブランチをすべての履歴（ほかのブランチとタグも）つきで取ってある。
// コミット・ブランチ・タグ・VERSION はこのチェックアウトから読み、PR の一覧とラベルは API から読む。ブランチは、チェックアウトした
// 先頭のときだけ削除する（そのあとに入った PR があれば削除できず、やり直しで読み直す）。
'use strict';

const { listMergedPulls, missingChanges } = require('./changes.js');
const { deleteBranchIfAt, git, prList, report } = require('./github-helpers.js');
const { compareVersions, parseVersionFile, planRelease } = require('./release-labels.js');

const commitOf = (ref) => git('rev-parse', `${ref}^{commit}`);

// ref の VERSION の、その製品のバージョン（読めなければ null）
function versionAt(ref, product) {
  try {
    return parseVersionFile(git('show', `${ref}:VERSION`))[product] ?? null;
  } catch {
    return null;
  }
}

function loadPlan(context) {
  const branch = context.ref.replace(/^refs\/heads\//, '');
  const tags = git('tag', '--list').split('\n').filter(Boolean);
  return { branch, plan: planRelease({ branch, tags }) };
}

async function createTag(github, repo, name, sha, message) {
  const { data: tag } = await github.rest.git.createTag({ ...repo, tag: name, message, object: sha, type: 'commit' });
  await github.rest.git.createRef({ ...repo, ref: `refs/tags/${name}`, sha: tag.sha });
}

// rc もリリースも、main の VERSION を上げてから行う（開発フェーズの入り方の順番）。上げる前にリリースしてブランチを消すと、
// VERSION を上げる PR が「上げる前のバージョンのリリースブランチがない」で通らなくなって main がこのバージョンのままになり、
// main の PR にはリリース済みのこのバージョンのラベルしか付けられず（次のバージョンは VERSION より新しい）、変更がどこにも入らなくなる。
function mainNotBumped(plan) {
  const main = versionAt('origin/main', plan.product);
  if (main && compareVersions(main, plan.version) > 0) return null;
  return `main の VERSION の ${plan.product} が ${main} のままです。先に main の VERSION を上げる PR（Release Preparation が作ったもの）をマージしてください。`;
}

// 手順 1：リリースブランチの先頭に、次の rc タグを打つ（このリリースに入るべき変更がすべて入っていることを確かめてから）。
async function releaseCandidate({ github, context, core }) {
  const repo = context.repo;
  const { branch, plan } = loadPlan(context);
  if (plan.error) return core.setFailed(plan.error);
  if (plan.released) return core.setFailed(`${plan.releaseTag} はもうリリースされています。`);
  const head = git('rev-parse', 'HEAD');
  const error =
    mainNotBumped(plan) ??
    (versionAt(head, plan.product) === plan.version ? null : `${branch} の VERSION の ${plan.product} が ${plan.version} ではありません。先に VERSION を上げる PR をマージしてください。`);
  if (error) return core.setFailed(error);

  const missing = missingChanges(await listMergedPulls(github, repo), plan.product, plan.version, head);
  if (missing.length > 0) {
    return core.setFailed(
      `ラベルではこのリリースに入るはずなのに、${branch} に入っていない変更があります（${prList(missing)}）。` +
        '入れるなら、その cherry-pick の PR が開いていればマージし、なければ Actions の「Cherry-Pick」→「Run workflow」でその PR の番号を指定して、できた PR をマージしてください。' +
        '入れないなら、その PR のリリースラベルをこのブランチより新しいバージョンに付け替えてください。そのあと実行し直してください。',
    );
  }
  await createTag(github, repo, plan.nextRcTag, head, `${plan.product} ${plan.version} release candidate`);
  await report(core, `${branch} の rc`, [
    `${plan.nextRcTag} を ${head.slice(0, 7)} に打ちました。この rc でリリース申請してください（release で commit を入力しなければ、最後の rc をリリースしたものとして扱います）。`,
  ]);
}

// commit に入力した SHA を、このブランチの履歴にあるコミットにする（なければ null）
function resolveCommit(input) {
  if (!/^[0-9a-f]{7,40}$/i.test(input)) return null;
  try {
    const sha = commitOf(input);
    git('merge-base', '--is-ancestor', sha, 'HEAD');
    return sha;
  } catch {
    return null;
  }
}

// リリースしたバージョンのリリースラベルをアーカイブする（ラベルを選ぶ画面に出なくなる）。
// ラベルの決まりはリリースブランチがあるかで判断していて、これには頼っていないので、できなくても進める。
async function archiveLabel(github, repo, label) {
  try {
    await github.rest.issues.updateLabel({ ...repo, name: label, archived: true });
    return `ラベル ${label} をアーカイブしました。`;
  } catch (error) {
    return `ラベル ${label} はアーカイブできませんでした（${error.message}）。`;
  }
}

// 手順 4・5：リリースしたコミットにリリースタグを打ち、リリースブランチを削除する。
// リリースしたコミットは、commit に入力したもの、なければ最後の rc。リリースは、リリースタグが指すコミットのこと。
// それより後にブランチに入ったコミット、開いている PR、入るはずなのに入っていない変更は、このリリースに入っていないものとして
// 書き出してから（ブランチを消したあとは、やり直せないため）、ブランチを削除する。
async function release({ github, context, core }) {
  const repo = context.repo;
  const { branch, plan } = loadPlan(context);
  if (plan.error) return core.setFailed(plan.error);

  let released;
  const lines = [];
  if (plan.released) {
    // タグを打ったあとに止まった実行のやり直し
    released = commitOf(plan.releaseTag);
    lines.push(`${plan.releaseTag} はもう ${released.slice(0, 7)} に打ってあります。`);
  } else {
    const error = mainNotBumped(plan);
    if (error) return core.setFailed(error);
    const input = (process.env.COMMIT ?? '').trim();
    if (input) {
      released = resolveCommit(input);
      if (!released || versionAt(released, plan.product) !== plan.version) {
        return core.setFailed(`commit に入力した ${input} は、${branch} の履歴にある、VERSION の ${plan.product} が ${plan.version} のコミットではありません。リリースタグは打っていません。`);
      }
    } else if (plan.latestRcTag) {
      released = commitOf(plan.latestRcTag);
    } else {
      return core.setFailed('rc タグがないので、どのコミットをリリースしたかがわかりません。Run workflow の commit にリリースしたコミットの SHA を入力して、実行し直してください。');
    }
    await createTag(github, repo, plan.releaseTag, released, `${plan.product} ${plan.version}`);
    lines.push(`${plan.releaseTag} を ${released.slice(0, 7)}（${input ? 'commit に入力したコミット' : plan.latestRcTag}）に打ちました。`);
  }

  const head = git('rev-parse', 'HEAD');
  const late = git('log', '--reverse', '--format=%h %s', `${released}..${head}`).split('\n').filter(Boolean);
  const open = await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', base: branch, per_page: 100 });
  const missing = missingChanges(await listMergedPulls(github, repo), plan.product, plan.version, released);
  const problems = [];
  if (late.length > 0) {
    problems.push(`リリースしたコミットより後に ${branch} に入ったコミットは、このリリースに入っておらず、ブランチの削除で消えます：${late.join('、')}`);
  }
  if (open.length > 0) problems.push(`${branch} に向けた開いている PR（${prList(open)}）は、このリリースに入っておらず、ブランチの削除で閉じられます。`);
  if (missing.length > 0) {
    problems.push(
      `ラベルではこのリリースに入るはずなのに、入っていない変更があります（${prList(missing)}）。修正フェーズに入れるときは、Hotfix Preparation が製品の最新のリリースタグから` +
        `修正フェーズのブランチを作り、main やより新しいリリースブランチにマージした変更を自動で cherry-pick します（このリリースより新しいリリースがあれば、このバージョンの修正フェーズは Hotfix Preparation では作れないので、管理者に作ってもらってください）。` +
        `${branch} に直接マージした変更は自動では入らないので、修正フェーズのブランチに PR を出し直してください。`,
    );
  }
  await report(core, `${plan.releaseTag} のリリース`, [...lines, ...problems, await archiveLabel(github, repo, plan.releaseTag)]);

  if (!(await deleteBranchIfAt(github, repo, branch, head))) {
    return core.setFailed(`この実行を始めたあとに ${branch} にコミットが入ったので、削除していません。実行し直してください。`);
  }
  core.info(`${branch} を削除しました。`);
  await core.summary.addList([`${branch} を削除しました。`]).write();
  if (problems.length > 0) core.setFailed(problems.join('\n'));
}

module.exports = { releaseCandidate, release };
