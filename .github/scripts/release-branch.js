// release-prep.js と hotfix-prep.js から使う、リリースブランチとリリースラベルを用意する処理。
// やり直したときも続きから進められるよう、すでにあれば使い回す。作る API が 422 を返しても「すでにある」とは限らない
// （ルールセット違反なども 422 になる）ので、本当にあるかを確かめてから使い回す。
'use strict';

const { branchExists, labelExists } = require('./github-helpers.js');

// リリースブランチ branch を sha から作る。結果を { result } で返す。作れなかったときは失敗にして null を返す。
async function createReleaseBranch({ github, core, repo, branch, sha }) {
  try {
    await github.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha });
    return { result: `${branch} を作りました（${sha.slice(0, 7)} から）。` };
  } catch (error) {
    if (error.status === 422 && (await branchExists(github, repo, branch))) {
      return { result: `${branch} はすでにあるので、そのまま使います。` };
    }
    core.setFailed(`${branch} を作れませんでした（${error.message}）。ルールセットや App の権限を確かめてください。`);
    return null;
  }
}

// リリースラベルを作る。結果の文を返す。
async function createReleaseLabel({ github, repo, label }) {
  try {
    await github.rest.issues.createLabel({ ...repo, name: label, color: '1d76db', description: 'Release label' });
    return `ラベル ${label} を作りました。`;
  } catch (error) {
    if (error.status === 422 && (await labelExists(github, repo, label))) return `ラベル ${label} はすでにあります。`;
    throw error;
  }
}

module.exports = { createReleaseBranch, createReleaseLabel };
