import { mockCore, mockContext, mockGitHub } from './test-helpers.ts';
// 正式タグを基準にした修正ブランチで、rc の欠落チェックを確かめる。GitHub API は呼ばない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { releaseCandidate } from './release.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
function commit(parent: string | null, files: Record<string, string>) {
  if (parent) git('checkout', '-q', '--detach', parent);
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  git('add', '-A');
  git('commit', '-q', '-m', 'test');
  return git('rev-parse', 'HEAD');
}
git('init', '-q');
const released = commit(null, { VERSION: 'product-a/1.3.0\n', 'app.txt': 'old\n' });
git('tag', 'product-a/v1.3.0', released);
const original = commit(released, { 'app.txt': 'fix\n' });
const main = commit(original, { VERSION: 'product-a/1.4.0\n' });
git('update-ref', 'refs/remotes/origin/main', main);
const hotfix = commit(released, { VERSION: 'product-a/1.3.1\n' });
const cwd = process.cwd();
process.chdir(dir);
test.after(() => {
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function runRc(label: string) {
  const tags: { tag: string; object: string }[] = [];
  const refs: { ref: string }[] = [];
  const failures: string[] = [];
  const summary = { addHeading: () => summary, addList: () => summary, write: async () => {} };
  await releaseCandidate({
    context: mockContext({ repo: { owner: 'o', repo: 'r' }, ref: 'refs/heads/release/product-a/v1.3.1' }),
    core: mockCore({ setFailed: (message: string | Error) => failures.push(String(message)), info() {}, summary }),
    github: mockGitHub({
      graphql: async () => ({ repository: { pullRequests: {
        pageInfo: { hasNextPage: false },
        nodes: [{ number: 100, baseRefName: 'main', headRefName: 'fix', mergeCommit: { oid: original }, labels: { nodes: [{ name: label }] } }],
      } } }),
      rest: { git: {
        createTag: async (args: { tag: string; object: string }) => { tags.push(args); return { data: { sha: 'tag-object' } }; },
        createRef: async (args: { ref: string }) => { refs.push(args); },
      } },
    }),
  });
  return { tags, refs, failures };
}

test('rc：前の正式タグに入らなかった旧ラベルの変更があっても、修正バージョンを作れる', async () => {
  const { tags, refs, failures } = await runRc('product-a/v1.3.0');
  assert.deepEqual(failures, []);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].tag, 'product-a/v1.3.1-rc.1');
  assert.equal(tags[0].object, hotfix);
  assert.equal(refs[0].ref, 'refs/tags/product-a/v1.3.1-rc.1');
});

test('rc：本修正バージョンを明示した変更が入っていなければ、タグを作らない', async () => {
  const { tags, refs, failures } = await runRc('product-a/v1.3.1');
  assert.deepEqual(tags, []);
  assert.deepEqual(refs, []);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /入っていない変更があります（#100）/);
});
