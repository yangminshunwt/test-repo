// 各スクリプトから使う、GitHub の API を使う小さな処理。
'use strict';

// PR の一覧を「#1、#2」の形にする
function prList(pulls) {
  return pulls.map((pull) => `#${pull.number}`).join('、');
}

// ref（ブランチやコミット）のファイルの中身を返す。ファイルがなければ null。
async function readFile(github, repo, path, ref) {
  try {
    const { data } = await github.rest.repos.getContent({ ...repo, path, ref });
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

// ブランチがあるかを返す（ない＝404 なら false。ほかのエラーはそのまま投げる）
async function branchExists(github, repo, branch) {
  try {
    await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

// ラベルがあるかを返す（ない＝404 なら false。ほかのエラーはそのまま投げる）
async function labelExists(github, repo, name) {
  try {
    await github.rest.issues.getLabel({ ...repo, name });
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

// 今あるリリースブランチ（release/...）の名前を返す
async function listReleaseBranches(github, repo) {
  const refs = await github.paginate(github.rest.git.listMatchingRefs, { ...repo, ref: 'heads/release/', per_page: 100 });
  return refs.map((ref) => ref.ref.replace(/^refs\/heads\//, ''));
}

// base（ブランチ名。ほかのブランチも受け入れるときは ref を受け取る関数）にマージされた PR のうち、マージコミットが shas にあるものを pulls で返す。
// PR が見つからなかったコミットは unmatched で返す（黙って飛ばさない）。
// 「このコミットを含む PR」の API はマージの直後には反映されていないことがあるので、まずマージした PR の一覧と突き合わせる。
// 一覧はページ送りの間に PR が更新されると並びがずれて見落とすことがあるので、残ったコミットは 1 つずつ確かめ直す
// （squash のコミットの件名の末尾の (#番号) の PR を取り、マージコミットとマージ先が合っているかを確かめる）。
async function mergedPullsForCommits(github, repo, shas, base) {
  const wanted = new Set(shas);
  const pulls = new Map();
  if (wanted.size === 0) return { pulls: [], unmatched: [] };
  const accepts = typeof base === 'function' ? base : (ref) => ref === base;
  const listed = typeof base === 'function' ? {} : { base };
  await github.paginate(github.rest.pulls.list, { ...repo, state: 'closed', ...listed, sort: 'updated', direction: 'desc', per_page: 100 }, (response, done) => {
    for (const pull of response.data) {
      if (pull.merged_at && accepts(pull.base.ref) && wanted.delete(pull.merge_commit_sha)) pulls.set(pull.number, pull);
    }
    if (wanted.size === 0) done();
    return [];
  });
  for (const sha of [...wanted]) {
    const { data: commit } = await github.rest.git.getCommit({ ...repo, commit_sha: sha });
    const number = /\(#(\d+)\)$/.exec(commit.message.split('\n')[0])?.[1];
    if (!number) continue;
    let pull;
    try {
      ({ data: pull } = await github.rest.pulls.get({ ...repo, pull_number: Number(number) }));
    } catch (error) {
      if (error.status === 404) continue; // (#番号) が PR ではなかった（Issue など）
      throw error;
    }
    if (pull.merged_at && pull.merge_commit_sha === sha && accepts(pull.base.ref)) {
      wanted.delete(sha);
      pulls.set(pull.number, pull);
    }
  }
  return { pulls: [...pulls.values()], unmatched: [...wanted] };
}

// basehead（a...b）の比較で、b にあって a にないコミットの SHA をすべて返す（1 回の応答では取り切れないことがあるので、ページを分けて取る）
async function compareShas(github, repo, basehead) {
  const shas = [];
  for (let page = 1; ; page++) {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead, per_page: 100, page });
    shas.push(...data.commits.map((commit) => commit.sha));
    if (data.commits.length === 0 || shas.length >= data.total_commits) return shas;
  }
}

// ブランチを、先頭が sha のときだけ消す（確かめてから消すまでの間に、ブランチにマージがあれば消さない）。消せたら true。
async function deleteBranchIfAt(github, repo, branch, sha) {
  const { data } = await github.rest.repos.get(repo);
  try {
    await github.graphql(
      `mutation($id: ID!, $name: GitRefname!, $before: GitObjectID!) {
        updateRefs(input: { repositoryId: $id, refUpdates: [{ name: $name, beforeOid: $before, afterOid: "0000000000000000000000000000000000000000" }] }) { clientMutationId }
      }`,
      { id: data.node_id, name: `refs/heads/${branch}`, before: sha },
    );
    return true;
  } catch (error) {
    // 先頭が変わっていれば消えない（エラーになる）。そのときは false、ほかの理由で消せなかったならそのまま投げる
    if (!(await branchExists(github, repo, branch))) return true;
    const { data: ref } = await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
    if (ref.object.sha !== sha) return false;
    throw error;
  }
}

// PR の作者とマージした人へのメンション（@a @b）
function mentionsOf(pr) {
  return [...new Set([pr.user?.login, pr.merged_by?.login].filter(Boolean))].map((login) => `@${login}`).join(' ');
}

// タグ（refs/tags/... の ref）が指すコミットを返す（注釈付きタグが入れ子になっていても、コミットまでたどる）
async function tagCommit(github, repo, ref) {
  let { type, sha } = ref.object;
  while (type === 'tag') {
    ({ type, sha } = (await github.rest.git.getTag({ ...repo, tag_sha: sha })).data.object);
  }
  return sha;
}

// 結果をログとジョブのまとめ（summary）に書く
async function report(core, heading, lines) {
  for (const line of lines) core.info(line);
  await core.summary.addHeading(heading, 3).addList(lines).write();
}

module.exports = { branchExists, compareShas, deleteBranchIfAt, labelExists, listReleaseBranches, mentionsOf, mergedPullsForCommits, prList, readFile, report, tagCommit };
