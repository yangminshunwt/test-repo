// release-prep.js と hotfix-prep.js から使う、リリースブランチとリリースラベルを用意する処理。
'use strict';

// 422 は「すでにある」以外（ルールセット違反など）でも返るので、本当にあるかを確かめる
async function ensureExists(createError, check) {
  if (createError.status !== 422) throw createError;
  try {
    await check();
  } catch (error) {
    throw error.status === 404 ? createError : error;
  }
}

// リリースブランチ branch を sha から作る。すでにあれば使い回し、そのブランチに入っていない変更がないかを notes で知らせる。
// 作れなかったときは失敗にして null を返す。
async function createReleaseBranch({ github, core, repo, branch, sha }) {
  try {
    await github.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha });
    return { created: true, results: [`${branch} を作りました（${sha.slice(0, 7)} から）。`], notes: [] };
  } catch (error) {
    try {
      await ensureExists(error, () => github.rest.git.getRef({ ...repo, ref: `heads/${branch}` }));
    } catch (createError) {
      core.setFailed(`${branch} を作れませんでした（${createError.message}）。ルールセットや App の権限を確かめてください。`);
      return null;
    }
  }

  const notes = [];
  const cherryPicks = (await github.paginate(github.rest.pulls.list, { ...repo, state: 'all', base: branch, per_page: 100 })).filter((pull) =>
    pull.head.ref.startsWith('cherry-pick-'),
  );
  const list = (pulls) => pulls.map((pull) => `#${pull.number}`).join('、');
  const closed = cherryPicks.filter((pull) => pull.state === 'closed' && !pull.merged_at);
  const open = cherryPicks.filter((pull) => pull.state === 'open');
  if (closed.length > 0) {
    notes.push(`${branch} には、マージされずに閉じた cherry-pick の PR があります（${list(closed)}）。その変更はこのブランチに入っていません。`);
  }
  if (open.length > 0) {
    notes.push(`${branch} への cherry-pick の PR がまだ開いています（${list(open)}）。リリースまでにマージしてください。`);
  }
  return { created: false, results: [`${branch} はすでにあるので、そのまま使います。`], notes };
}

// リリースラベルを作る（すでにあればそのまま）。結果の文を返す。
async function createReleaseLabel({ github, repo, label }) {
  try {
    await github.rest.issues.createLabel({ ...repo, name: label, color: '1d76db', description: 'Release label' });
    return `ラベル ${label} を作りました。`;
  } catch (error) {
    await ensureExists(error, () => github.rest.issues.getLabel({ ...repo, name: label }));
    return `ラベル ${label} はすでにあります。`;
  }
}

// タグ（refs/tags/... の ref）が指すコミットを返す（注釈付きタグが入れ子になっていても、コミットまでたどる）
async function tagCommit(github, repo, ref) {
  let { type, sha } = ref.object;
  while (type === 'tag') {
    ({ type, sha } = (await github.rest.git.getTag({ ...repo, tag_sha: sha })).data.object);
  }
  return sha;
}

module.exports = { createReleaseBranch, createReleaseLabel, tagCommit };
