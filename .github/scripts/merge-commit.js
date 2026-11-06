// pull_request のワークフロー（Release Label Check と CI）から actions/github-script で呼ぶ。
// 今のマージ先の先頭と PR の先頭とのテスト用マージコミットができるまで待ち、sha（チェックアウトするコミット）と
// base_ref（今のマージ先）を出力する。マージ先を変えた（edited）直後は、GitHub がマージコミットを作り直す前に
// 実行が始まり、イベントのマージコミットが前のマージ先とのままのことがあるため（Re-run しても同じコミットになる）。
'use strict';

async function waitForMergeCommit({ github, context, core }) {
  const repo = context.repo;
  const pull_number = context.payload.pull_request.number;
  for (let attempt = 0; attempt < 30; attempt++) {
    const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number });
    if (pr.state !== 'open') {
      // 閉じた PR（マージ後にラベルを直したときなど）はマージコミットが作り直されないので待たない。
      // マージ済みなら、実際にマージしたコミットを使う
      core.setOutput('sha', pr.merged ? pr.merge_commit_sha : context.sha);
      core.setOutput('base_ref', pr.base.ref);
      return;
    }
    if (pr.mergeable === false) {
      return core.setFailed(`${pr.base.ref} とコンフリクトしています。解消して push すると、もう一度チェックします。`);
    }
    if (pr.mergeable && pr.merge_commit_sha) {
      const { data: base } = await github.rest.repos.getBranch({ ...repo, branch: pr.base.ref });
      const { data: merge } = await github.rest.git.getCommit({ ...repo, commit_sha: pr.merge_commit_sha });
      const parents = merge.parents.map((parent) => parent.sha);
      if (parents[0] === base.commit.sha && parents[1] === pr.head.sha) {
        core.setOutput('sha', pr.merge_commit_sha);
        core.setOutput('base_ref', pr.base.ref);
        return;
      }
    }
    core.info(`今のマージ先（${pr.base.ref}）とのマージコミットができるのを待っています（${attempt + 1} 回目）。`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  core.setFailed('今のマージ先とのマージコミットを GitHub から取れませんでした。しばらくしてから Re-run してください。');
}

module.exports = { waitForMergeCommit };
