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

// base にマージされた PR のうち、shas のどれかのコミットを含むものを返す（同じ PR は 1 つにまとめる）
async function mergedPullsOf(github, repo, shas, base) {
  const pulls = new Map();
  for (const sha of shas) {
    const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ ...repo, commit_sha: sha });
    for (const pull of data) {
      if (pull.merged_at && pull.base.ref === base) pulls.set(pull.number, pull);
    }
  }
  return [...pulls.values()];
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

module.exports = { branchExists, labelExists, listReleaseBranches, mergedPullsOf, prList, readFile, report, tagCommit };
