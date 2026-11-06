// release.yml から actions/github-script で呼ぶ処理（開発ルールの「リリース手順」）。
// スクリプトと main の VERSION は作業場所の直下（main）、リリースブランチは RELEASE_WORK（すべての履歴つき）から読む。
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { compareShas, deleteBranchIfAt, mergedPullsForCommits, prList, report, tagCommit } = require('./github-helpers.js');
const { compareVersions, extractReleaseLabels, parseCherryPickBranch, parseReleaseBranch, parseVersionFile, planRelease } = require('./release-labels.js');

const WORK = process.env.RELEASE_WORK;
// 履歴の全体を読むことがあるので、出力の上限を大きくしておく（既定の 1 MiB を超えると失敗する）
const git = (...args) => execFileSync('git', ['-C', WORK, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).trim();
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
  return `main の VERSION の ${plan.product} が ${mainVersion} のままです。先に main の VERSION を上げる PR（Release Preparation が作ったもの）をマージしてください。`;
}

// source（main か、同じ製品のより新しいリリースブランチ）にマージされた PR のうち、head に入っていないものを返す
// （{ pulls, unmatched }。unmatched は PR が見つからなかったコミット）。
// - --first-parent：マージコミットでマージした PR（自動化を入れる前の履歴など）も、PR ごとに 1 つのコミットで数える
// - リリースブランチは、main から来たコミットを除く（それは main にマージされた PR として、main のほうで数える）。
//   修正フェーズのブランチの履歴には、リリース後に消した前のリリースブランチのコミットも入るので、同じ製品の
//   どのリリースブランチにマージされた PR も受け入れる
function pullsNotIn(github, repo, head, source, product) {
  const range = source === 'main' ? [`${head}..origin/main`] : [`${head}..origin/${source}`, '^origin/main'];
  const base = source === 'main' ? 'main' : (ref) => parseReleaseBranch(ref)?.product === product;
  return mergedPullsForCommits(github, repo, git('rev-list', '--first-parent', ...range).split('\n').filter(Boolean), base);
}

// 後から入ったコミットを API で取る（チェックアウトした時点より後のコミットもあるので、手元の履歴は使わない）
async function lateCommits(github, repo, target, head, branch) {
  return mergedPullsForCommits(github, repo, await compareShas(github, repo, `${target}...${head}`), branch);
}

// PR が見つからなかったコミットの一覧（短い SHA）
function commitList(shas) {
  return shas.map((sha) => sha.slice(0, 7)).join('、');
}

// マージされた cherry-pick の PR（すべての行き先）のマージコミットを、元の PR の番号ごとに返す。
// PR ごとに検索の API で探すと、検索の上限（1 分に 30 回）をすぐに超えるので、閉じた PR の一覧から一度に作る。
async function mergedCherryPicks(github, repo) {
  const picks = new Map();
  for (const pull of await github.paginate(github.rest.pulls.list, { ...repo, state: 'closed', per_page: 100 })) {
    const original = parseCherryPickBranch(pull.head.ref);
    if (original === null || !pull.merged_at) continue;
    picks.set(original, [...(picks.get(original) ?? []), pull.merge_commit_sha]);
  }
  return picks;
}

// main とより新しいリリースブランチにマージされた PR のうち、その製品のラベルのバージョンがこのブランチのバージョン以下なのに、
// 変更が head に入っていないもの（cherry-pick の取りこぼし）を { missing, unmatched } で返す（unmatched は PR が見つからなかったコミット）。
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
  const unmatched = [];
  let cherryPicks = null; // 要るときに一度だけ作る
  for (const source of ['main', ...newer]) {
    const notIn = await pullsNotIn(github, repo, head, source, plan.product);
    unmatched.push(...notIn.unmatched);
    for (const pull of notIn.pulls) {
      const { releaseLabels } = extractReleaseLabels(
        pull.labels.map((label) => label.name),
        [plan.product],
      );
      if (!releaseLabels.some(({ version }) => compareVersions(version, plan.version) <= 0)) continue;
      if (picked.has(pull.merge_commit_sha) || isAncestor(pull.merge_commit_sha, head)) continue;
      cherryPicks ??= await mergedCherryPicks(github, repo);
      if ((cherryPicks.get(pull.number) ?? []).some((sha) => isAncestor(sha, head))) continue;
      missing.push(pull);
    }
  }
  return { missing, unmatched };
}

// 取りこぼしのメッセージ（afterRelease は、リリースが済んだあと）
function missingError(branch, { missing, unmatched }, { afterRelease }) {
  const messages = [];
  if (missing.length > 0) {
    const guide = afterRelease
      ? 'リリースしたものには入っていないので、その PR のリリースラベルをこのブランチより新しいバージョンに付け替えてから実行し直してください。'
      : '入れるなら、それぞれ Actions の「Cherry-Pick」→「Run workflow」で PR の番号を指定してやり直し、できた PR をマージしてください。' +
        '入れないなら、その PR のリリースラベルをこのブランチより新しいバージョンに付け替えてください。そのあと実行し直してください。';
    const where = afterRelease ? `${branch} のリリースしたコミット` : branch;
    messages.push(`ラベルではこのリリースに入るはずなのに、${where}に入っていない変更があります（${prList(missing)}）。${guide}`);
  }
  if (unmatched.length > 0) {
    messages.push(
      `${branch} に入っていないコミットのうち、マージした PR が見つからないものがあります（${commitList(unmatched)}）。` +
        'PR を通さずに入ったコミットは、この自動化ではこのリリースに入るかを判断できないので、管理者に確かめてもらってください。',
    );
  }
  return messages.join('\n');
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
  if (missing.missing.length > 0 || missing.unmatched.length > 0) return { error: missingError(branch, missing, { afterRelease }) };
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
      `cherry-pick で入った変更（${prList(picks.map(({ pull }) => pull))}）は、修正フェーズのブランチを作ったあと、元の PR（${originals}）のリリースラベルをそのブランチのバージョンに付け替えて、Cherry-Pick の Run workflow でやり直してください。`,
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
  const problems = [];
  // アーカイブしたラベルは付け直せないので、付け直しはアーカイブより先にする。ラベルのチェックをやり直させられなかった PR が
  // あれば、アーカイブもブランチの削除もせずに止める（やり直したとき、もう一度その PR のチェックをやり直させるため）
  const recheck = await recheckLabeledPulls(github, core, repo, plan.releaseTag);
  results.push(...recheck.lines);
  if (recheck.unchecked.length > 0) {
    problems.push(
      `${prList(recheck.unchecked)} からラベル ${plan.releaseTag} を外せず、ラベルのチェックをやり直させられませんでした。` +
        'ラベルのアーカイブとブランチの削除はしていません。実行し直してください。',
    );
  } else {
    results.push(await archiveReleaseLabel(github, core, repo, plan.releaseTag));
  }

  // ブランチを消す前に、このリリースに入っていないものが残っていないかを確かめる。残っていれば消さずに止める
  // （消すと、そのブランチへの PR は黙って閉じられ、その変更がどのリリースにも入らなくなる）
  const head = (await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` })).data.object.sha;
  let late = { pulls: [], unmatched: [] };
  if (head !== target) {
    late = await lateCommits(github, repo, target, head, branch);
    const commits = [prList(late.pulls), late.unmatched.length > 0 ? `PR が見つからないコミット ${commitList(late.unmatched)}` : ''].filter(Boolean).join('、');
    problems.push(
      `${branch} には ${plan.latestRcTag ?? plan.releaseTag} より後のコミットがあり、今回のリリースには入っていません（${commits}）。ブランチは消していません。` +
        `次の修正に入れるなら、管理者がこのブランチを削除して Hotfix Preparation を実行してください。${guideForLateChanges(late.pulls)}`,
    );
  }
  if (plan.latestRcTag) {
    // rc なしのときは、タグを打つ前に checkBranch で確かめている。rc より後に cherry-pick で入った変更は、上の
    // 「後から入ったコミット」として知らせているので、ここでは重ねて数えない
    const lateOriginals = new Set(late.pulls.map((pull) => parseCherryPickBranch(pull.head.ref)).filter((number) => number !== null));
    const found = await findMissingChanges(github, repo, target, plan);
    const missing = { missing: found.missing.filter((pull) => !lateOriginals.has(pull.number)), unmatched: found.unmatched };
    if (missing.missing.length > 0 || missing.unmatched.length > 0) problems.push(missingError(branch, missing, { afterRelease: true }));
  }
  // このブランチに向けた PR と、このブランチから出した PR（リリースブランチを main に戻す PR など）。どちらもブランチを消すと閉じられる。
  // 消したあとに比べるため、確かめた時点の PR ごとの閉じた時刻（GitHub の記録）を覚えておく
  const pullsOf = async () => ({
    to: await github.paginate(github.rest.pulls.list, { ...repo, state: 'all', base: branch, per_page: 100 }),
    from: await github.paginate(github.rest.pulls.list, { ...repo, state: 'all', head: `${repo.owner}:${branch}`, per_page: 100 }),
  });
  const checked = await pullsOf();
  const openTo = checked.to.filter((pull) => pull.state === 'open');
  const openFrom = checked.from.filter((pull) => pull.state === 'open');
  if (openFrom.length > 0) {
    problems.push(`${branch} から出した PR がまだ開いています（${prList(openFrom)}）。ブランチを消すと閉じられるので、消していません。マージするか閉じてから実行し直してください。`);
  }
  if (openTo.length > 0) {
    problems.push(
      `${branch} に向けた PR がまだ開いています（${prList(openTo)}）。今回のリリースには入っていないので、ブランチは消していません。` +
        'cherry-pick の PR なら、元の PR のリリースラベルをこのブランチより新しいバージョンに付け替えてから閉じてください。' +
        'それ以外の PR も閉じてください。入れる変更なら、ブランチが消えたあと Hotfix Preparation で作るブランチに出し直してください。そのあと実行し直してください。',
    );
  }
  if (problems.length === 0) {
    let deleted = false;
    try {
      deleted = await deleteBranchIfAt(github, repo, branch, head);
      if (!deleted) problems.push(`確かめている間に ${branch} が更新されたので、ブランチは消していません。実行し直してください。`);
    } catch (error) {
      problems.push(`${branch} を削除できませんでした（${error.message}）。実行し直してください。`);
    }
    if (deleted) {
      results.push(`${branch} を削除しました。`);
      // 確かめたときには開いていなかった（なかったか、閉じていた）のに、そのあと開かれたか開き直された PR を探す。
      // 確かめたときに開いていた PR があれば消していないので、確かめたときから閉じた時刻が変わった PR か、まだ開いている PR がそれにあたる
      const closedAt = new Map([...checked.to, ...checked.from].map((pull) => [pull.number, pull.closed_at]));
      const after = await pullsOf();
      const reopened = (pulls) => pulls.filter((pull) => !pull.merged_at && (pull.state === 'open' || closedAt.get(pull.number) !== pull.closed_at));
      const lateTo = reopened(after.to);
      const lateFrom = reopened(after.from);
      if (lateTo.length > 0) {
        problems.push(
          `確かめたあとに開かれた（開き直された）${branch} に向けた PR（${prList(lateTo)}）があり、マージされないままブランチを消しました。` +
            'これらの PR は閉じられ、今回のリリースには入っていません。入れる変更なら、Hotfix Preparation でブランチを作ったあと、' +
            'cherry-pick の PR なら元の PR のリリースラベルをそのブランチのバージョンに付け替えて Cherry-Pick の Run workflow でやり直し、' +
            'それ以外はそのブランチに PR を出し直してください。',
        );
      }
      if (lateFrom.length > 0) {
        problems.push(
          `確かめたあとに開かれた（開き直された）${branch} から出した PR（${prList(lateFrom)}）があり、ブランチを消したので閉じられます。` +
            `ブランチの中身は ${plan.releaseTag} と同じです。必要なら、タグ ${plan.releaseTag} からブランチを作って PR を出し直してください。`,
        );
      }
    }
  }
  await report(core, `${plan.releaseTag} のリリース`, results);
  if (problems.length > 0) core.setFailed(problems.join('\n'));
}

// リリースしたバージョンのラベルが付いた開いている PR は、ラベルを付け直して、ラベルのチェックをやり直させる
// （リリースしてもイベントは起きないので、前の成功のままマージできてしまう。やり直すとリリース済みのラベルとして止まる）
// 戻り値：{ lines（結果）, unchecked（ラベルを外せず、チェックをやり直させられなかった PR） }
async function recheckLabeledPulls(github, core, repo, label) {
  const none = { lines: [], unchecked: [] };
  // アーカイブしたラベルは付け直せない。アーカイブするのは、すべての PR のチェックをやり直させたあとだけ
  try {
    if ((await github.rest.issues.getLabel({ ...repo, name: label })).data.archived_at) return none;
  } catch (error) {
    if (error.status !== 404) throw error;
    return none;
  }
  const pulls = (await github.paginate(github.rest.issues.listForRepo, { ...repo, labels: label, state: 'open', per_page: 100 })).filter(
    (issue) => issue.pull_request,
  );
  if (pulls.length === 0) return none;
  const unchecked = [];
  const unlabeled = [];
  for (const pull of pulls) {
    try {
      await github.rest.issues.removeLabel({ ...repo, issue_number: pull.number, name: label });
    } catch (error) {
      // ほかの人が先に外していれば、そのイベントでラベルのチェックはやり直される
      if (error.status === 404) continue;
      unchecked.push(pull);
      core.warning(`#${pull.number} からラベル ${label} を外せませんでした（${error.message}）。`);
      continue;
    }
    try {
      await github.rest.issues.addLabels({ ...repo, issue_number: pull.number, labels: [label] });
    } catch (error) {
      // 付け直せなくても、外したことでラベルのチェックはやり直される（ラベルがないとして止まる）
      unlabeled.push(pull);
      core.warning(`#${pull.number} にラベル ${label} を付け直せませんでした（${error.message}）。外したままです。`);
    }
  }
  const lines = [`ラベル ${label} が付いた開いている PR（${prList(pulls)}）は、ラベルを付け直してラベルのチェックをやり直させました（リリース済みのラベルとして止まります）。`];
  if (unlabeled.length > 0) lines.push(`そのうち ${prList(unlabeled)} は、ラベルを付け直せず、外したままです（ラベルのチェックは、ラベルがないとして止まります）。`);
  return { lines, unchecked };
}

module.exports = { releaseCandidate, release };
