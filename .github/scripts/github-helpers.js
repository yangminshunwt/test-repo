// 各スクリプトから使う、GitHub の API を使う小さな処理。
'use strict';

const { execFileSync } = require('child_process');

// 作業場所（すべての履歴を取ったチェックアウト）で git を動かす
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// PR の一覧を「#1、#2」の形にする
function prList(pulls) {
  return pulls.map((pull) => `#${pull.number}`).join('、');
}

// API の結果の data を返す。ない（404）なら null（ほかのエラーはそのまま投げる）
async function found(request) {
  try {
    return (await request).data;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

// ブランチの今の先頭のコミット（なければ null）
const branchHead = async (github, repo, branch) => (await found(github.rest.git.getRef({ ...repo, ref: `heads/${branch}` })))?.object.sha ?? null;

// チェックアウトしたときのリリースブランチ（release/...）の名前を返す。
// 同じ実行の中のほかの判断（変更が入っているかなど）と同じ時点のものを使うため、API ではなくチェックアウトから読む。
const localReleaseBranches = () => git('for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin/release/').split('\n').filter(Boolean);

// リリースブランチ branch を sha から作る（やり直したときも続きから進められるよう、チェックアウトしたときにあればそのまま使う）。
// 結果の文と、ブランチの先頭（チェックアウトしたときのもの）を返す。
async function createReleaseBranch(github, repo, branch, sha) {
  if (localReleaseBranches().includes(branch)) return { line: `${branch} はすでにあるので、そのまま使います。`, head: git('rev-parse', `refs/remotes/origin/${branch}`) };
  await github.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha });
  return { line: `${branch} を作りました（${sha.slice(0, 7)} から）。`, head: sha };
}

// リリースラベルを作る（すでにあればそのまま使う）。結果の文を返す。
async function createReleaseLabel(github, repo, label) {
  if (await found(github.rest.issues.getLabel({ ...repo, name: label }))) return `ラベル ${label} はすでにあります。`;
  await github.rest.issues.createLabel({ ...repo, name: label, color: '1d76db', description: 'Release label' });
  return `ラベル ${label} を作りました。`;
}

// ブランチを、先頭が sha のときだけ消す（確かめたあとにブランチが進んでいれば消さない）。消せた（もうない）なら true。
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
    const head = await branchHead(github, repo, branch);
    if (head === null) return true;
    if (head !== sha) return false;
    throw error;
  }
}

// 結果をログとジョブのまとめ（summary）に書く
async function report(core, heading, lines) {
  for (const line of lines) core.info(line);
  await core.summary.addHeading(heading, 3).addList(lines).write();
}

module.exports = { branchHead, createReleaseBranch, createReleaseLabel, deleteBranchIfAt, git, localReleaseBranches, prList, report };
