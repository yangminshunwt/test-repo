// 各スクリプトから使う、GitHub の API を使う小さな処理。
'use strict';

// PR の一覧を「#1、#2」の形にする
function prList(pulls) {
  return pulls.map((pull) => `#${pull.number}`).join('、');
}

// 404 なら false、あれば true（ほかのエラーはそのまま投げる）
async function exists(request) {
  try {
    await request;
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

const branchExists = (github, repo, branch) => exists(github.rest.git.getRef({ ...repo, ref: `heads/${branch}` }));

// 今あるリリースブランチ（release/...）の名前を返す
async function listReleaseBranches(github, repo) {
  const refs = await github.paginate(github.rest.git.listMatchingRefs, { ...repo, ref: 'heads/release/', per_page: 100 });
  return refs.map((ref) => ref.ref.replace(/^refs\/heads\//, ''));
}

// リリースブランチ branch を sha から作る（やり直したときも続きから進められるよう、すでにあればそのまま使う）。結果の文を返す。
async function createReleaseBranch(github, repo, branch, sha) {
  if (await branchExists(github, repo, branch)) return `${branch} はすでにあるので、そのまま使います。`;
  await github.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha });
  return `${branch} を作りました（${sha.slice(0, 7)} から）。`;
}

// リリースラベルを作る（すでにあればそのまま使う）。結果の文を返す。
async function createReleaseLabel(github, repo, label) {
  if (await exists(github.rest.issues.getLabel({ ...repo, name: label }))) return `ラベル ${label} はすでにあります。`;
  await github.rest.issues.createLabel({ ...repo, name: label, color: '1d76db', description: 'Release label' });
  return `ラベル ${label} を作りました。`;
}

// ブランチを、先頭が sha のときだけ消す（確かめてから消すまでの間にブランチが進んでいれば消さない）。消せた（もうない）なら true。
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
    // 消したあとの応答が届かずにやり直したときは、もうないので消せている。先頭が進んでいれば false、ほかの理由ならそのまま投げる
    if (!(await branchExists(github, repo, branch))) return true;
    const { data: ref } = await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
    if (ref.object.sha !== sha) return false;
    throw error;
  }
}

// base...head の比較で、head にあって base にないコミットを { sha, subject } で返す（1 回の応答では取り切れないことがあるので、ページを分けて取る）
async function commitsBetween(github, repo, base, head) {
  const commits = [];
  for (let page = 1; ; page++) {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${base}...${head}`, per_page: 100, page });
    commits.push(...data.commits.map((commit) => ({ sha: commit.sha, subject: commit.commit.message.split('\n')[0] })));
    if (data.commits.length === 0 || commits.length >= data.total_commits) return commits;
  }
}

// 結果をログとジョブのまとめ（summary）に書く
async function report(core, heading, lines) {
  for (const line of lines) core.info(line);
  await core.summary.addHeading(heading, 3).addList(lines).write();
}

module.exports = { branchExists, commitsBetween, createReleaseBranch, createReleaseLabel, deleteBranchIfAt, listReleaseBranches, prList, report };
