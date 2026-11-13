import { mockCore, mockContext, mockGitHub } from './test-helpers.ts';
import type { Context } from './github.ts';
// PR のテスト用マージコミットとキューの合成済みコミットを、一時的な git リポジトリで確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check as checkLabels } from './release-label-check.ts';
import { check as checkVersions } from './version-check.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-checks-test-'));
const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
// parent の上で files を書き換えたコミットを作り、その SHA を返す
function commit(parent: string | null, files: Record<string, string>, message: string) {
  if (parent) git('checkout', '-q', '--detach', parent);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}
function merge(base: string, head: string) {
  git('checkout', '-q', '--detach', base);
  git('merge', '--no-ff', '-q', '-m', 'Test merge', head);
  return git('rev-parse', 'HEAD');
}
const versionFile = (a: string) => `# version\nproduct-a/${a}\nproduct-b/2.0.0\n`;

git('init', '-q');
const root = commit(null, { VERSION: versionFile('1.4.0'), 'ProductA/app.txt': 'a\n', 'ProductB/app.txt': 'b\n' }, 'root');
// main と、main の 1.4.0 から作ったリリースブランチ（チェックアウトしたときのリモートのブランチとして置く）
git('update-ref', 'refs/remotes/origin/main', root);
git('update-ref', 'refs/remotes/origin/release/product-a/v1.4.0', root);
// マージキュー：#11（product-a を 1.5.0 に上げる）の後ろに、#12（product-a を直す）が並んでいる。
// それぞれのマージグループのコミットは、前のマージグループのコミットの上に、その PR の変更を足したもの（main にはまだ入っていない）
const group11 = commit(root, { VERSION: versionFile('1.5.0') }, 'Bump product-a to 1.5.0 (#11)');
const group12 = commit(group11, { 'ProductA/app.txt': 'a fix\n' }, 'Fix product-a (#12)');
const mergeGroup12 = {
  head_sha: group12,
  head_ref: `refs/heads/gh-readonly-queue/main/pr-12-${group11}`,
  base_sha: group11,
  base_ref: 'refs/heads/main',
};
const cwd = process.cwd();
process.chdir(dir);
test.after(() => {
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeCore() {
  const failures: string[] = [];
  return mockCore({ failures, setFailed: (message: string | Error) => failures.push(String(message)), warning() {}, error() {} });
}
// number の PR だけを返す API
const fakeGithub = (number: number, labels: string[], base = 'main') => mockGitHub({
  rest: {
    pulls: {
      get: async ({ pull_number }: { pull_number: number }) => {
        assert.equal(pull_number, number);
        return { data: { number, base: { ref: base }, labels: labels.map((name) => ({ name })) } };
      },
    },
  },
});
const context = (payload: Context['payload']) => mockContext({ repo: { owner: 'o', repo: 'r' }, payload });

async function runChecks(
  baseSha: string,
  labels: string[],
  baseBranch = 'main',
  payload: Context['payload'] = { pull_request: { number: 12, base: { ref: 'old-base' }, labels: [] } },
) {
  const labelCore = fakeCore();
  const versionCore = fakeCore();
  Object.assign(process.env, {
    BASE_SHA: baseSha,
    AFFECTED_PRODUCTS: JSON.stringify(['product-a']),
    HAS_UNLISTED_FILES: 'false',
  });
  const input = { github: fakeGithub(12, labels, baseBranch), context: context(payload) };
  await checkLabels({ ...input, core: labelCore });
  await checkVersions({ ...input, core: versionCore });
  return { labels: labelCore.failures, versions: versionCore.failures };
}

test('マージキュー：合成済みコミットの VERSION とイベントのマージ先で確かめる', async () => {
  git('checkout', '-q', '--detach', group12);
  // 1.4.0 のリリースブランチがあるので、#12 に product-a/v1.4.0 を付けてよい。
  // PR の番号はキューのブランチ名から読む。キューではイベントのマージ先を使う。
  const payload = { merge_group: mergeGroup12 };
  assert.deepEqual(await runChecks(group11, ['product-a/v1.4.0'], 'old-base', payload), { labels: [], versions: [] });
  assert.equal((await runChecks(group11, ['product-a/v1.6.0'], 'old-base', payload)).labels.length, 1);
});

test('PR のマージ結果：main 側の VERSION 更新を PR の変更に含めない', async () => {
  const head = commit(root, { 'ProductA/app.txt': 'a fix\n' }, 'Fix product-a');
  const merged = merge(group11, head);
  const laterMain = commit(group11, { VERSION: versionFile('1.6.0') }, 'Advance main after test merge');
  git('update-ref', 'refs/remotes/origin/main', laterMain);
  git('checkout', '-q', '--detach', merged);

  assert.equal(git('diff', '--name-only', `${group11}..HEAD`), 'ProductA/app.txt');
  assert.deepEqual(await runChecks(group11, ['product-a/v1.4.0']), { labels: [], versions: [] });
  assert.equal((await runChecks(group11, ['product-a/v1.6.0'])).labels.length, 1);
  git('update-ref', 'refs/remotes/origin/main', root);
});

test('VERSION 更新を含む PR も古いラベルを使えるが、cherry-pick 先の VERSION は一致させる', async () => {
  const head = commit(root, { VERSION: versionFile('1.5.0'), 'ProductA/app.txt': 'a next version\n' }, 'Update product-a and VERSION');
  merge(root, head);
  assert.deepEqual(await runChecks(root, ['product-a/v1.5.0']), { labels: [], versions: [] });
  assert.deepEqual(await runChecks(root, ['product-a/v1.4.0']), { labels: [], versions: [] });

  const cherryPick = await runChecks(root, ['cherry-pick', 'product-a/v1.4.0'], 'release/product-a/v1.4.0');
  assert.deepEqual(cherryPick.labels, []);
  assert.equal(cherryPick.versions.length, 1);
});

test('リリース PR の再確認：新しいテスト用マージコミットの VERSION を使う', async () => {
  const baseBranch = 'release/product-a/v1.4.1';
  const labels = ['product-a/v1.4.1'];
  const head = commit(root, { 'ProductA/app.txt': 'a hotfix\n' }, 'Fix product-a for hotfix');
  merge(root, head);
  const before = await runChecks(root, labels, baseBranch);
  assert.deepEqual(before.labels, []);
  assert.equal(before.versions.length, 1);

  const updatedBase = commit(root, { VERSION: versionFile('1.4.1') }, 'Prepare hotfix VERSION');
  git('update-ref', `refs/remotes/origin/${baseBranch}`, updatedBase);
  merge(updatedBase, head);
  assert.equal(git('diff', '--name-only', `${updatedBase}..HEAD`), 'ProductA/app.txt');
  assert.deepEqual(await runChecks(updatedBase, labels, baseBranch), { labels: [], versions: [] });
});

test('VERSION のマージキュー検査は PR やラベルを API で読まず、グループのマージ先を使う', async () => {
  commit(group11, { VERSION: versionFile('1.5.1') }, 'Invalid main patch bump');
  process.env.BASE_SHA = group11;
  const errors: string[] = [];
  const failures: string[] = [];
  await checkVersions({
    github: mockGitHub({}),
    context: context({ merge_group: mergeGroup12 }),
    core: mockCore({ error: (error: string) => errors.push(error), setFailed: (error: string) => failures.push(error) }),
  });
  assert.match(errors[0], /main のバージョンは、パッチを 0/);
  assert.equal(failures.length, 1);
});
