'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkReleaseLabels,
  compareVersions,
  findAffectedProducts,
  findCherryPickTargets,
  parseReleaseBranch,
  parseVersionFile,
} = require('./release-labels.js');

const HEADER = '# Holds the version under development on this branch.\n#\n#    product-name/X.Y.Z\n#---\n\n';

function versionFile(a, b) {
  return `${HEADER}product-a/${a}\nproduct-b/${b}\n`;
}

// 開発ルールの Q＆A と同じ状況：main は v1.5.0、リリースブランチは v1.3.0 と v1.4.0。
const BRANCHES = [
  'release/product-a/v1.3.0',
  'release/product-a/v1.4.0',
  'release/product-b/v1.4.0',
];

// version / baseVersion：マージ後とマージ前の VERSION。baseVersion を省くと VERSION は変えない PR になる。
function check({ baseBranch = 'main', labels, affectedProducts = ['product-a'], version = versionFile('1.5.0', '1.5.0'), baseVersion = version, branches = BRANCHES }) {
  return checkReleaseLabels({ baseBranch, labels, affectedProducts, versionFile: version, baseVersionFile: baseVersion, branches });
}

function assertOk(result) {
  assert.deepEqual(result.errors, []);
}

function assertError(result, pattern) {
  assert.ok(
    result.errors.some((error) => pattern.test(error)),
    `${pattern} に合うエラーがありません: ${JSON.stringify(result.errors)}`,
  );
}

test('VERSION ファイルを読む', () => {
  assert.deepEqual(parseVersionFile(versionFile('1.2.3', '4.5.6')), { 'product-a': '1.2.3', 'product-b': '4.5.6' });
  assert.throws(() => parseVersionFile('product-a/1.2\n'));
  assert.throws(() => parseVersionFile('product-a/1.2.3\nproduct-a/1.2.4\n'));
  assert.throws(() => parseVersionFile('1.2.3\n'));
});

test('バージョンを数値として比べる', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('1.2.3', '1.2.3') === 0);
  assert.ok(compareVersions('0.9.9', '1.0.0') < 0);
});

test('リリースブランチの名前を読む', () => {
  assert.deepEqual(parseReleaseBranch('release/product-a/v1.2.3'), { product: 'product-a', version: '1.2.3' });
  assert.equal(parseReleaseBranch('main'), null);
  assert.equal(parseReleaseBranch('release/product-a/1.2.3'), null);
});

test('main：影響する製品のラベルがあれば OK', () => {
  assertOk(check({ labels: ['product-a', 'product-a/v1.5.0'] }));
});

test('main：ラベルがなければ NG', () => {
  assertError(check({ labels: ['product-a'] }), /product-a のリリースラベルが付いていません/);
});

test('main：どの製品にも影響しない変更でも、ラベルは 1 つ必要', () => {
  assertError(check({ labels: [], affectedProducts: [] }), /リリースラベルが付いていません/);
  assertOk(check({ labels: ['product-b/v1.5.0'], affectedProducts: [] }));
});

test('main：共有コードの変更には、両方の製品のラベルが必要', () => {
  const affectedProducts = ['product-a', 'product-b'];
  assertError(check({ labels: ['product-a/v1.5.0'], affectedProducts }), /product-b のリリースラベルが付いていません/);
  assertOk(check({ labels: ['product-a/v1.5.0', 'product-b/v1.5.0'], affectedProducts }));
});

test('main：影響しない製品のラベルは警告だけ', () => {
  const result = check({ labels: ['product-a/v1.5.0', 'product-b/v1.5.0'] });
  assertOk(result);
  assert.equal(result.warnings.length, 1);
});

test('main：リリースブランチのバージョンを付ければ OK（cherry-pick される）', () => {
  assertOk(check({ labels: ['product-a/v1.3.0'] }));
  assertOk(check({ labels: ['product-a/v1.4.0'] }));
});

test('main：同じ製品のラベルが 2 つあれば NG', () => {
  assertError(check({ labels: ['product-a/v1.3.0', 'product-a/v1.4.0'] }), /product-a のリリースラベルが複数あります/);
});

test('main：VERSION より新しいラベルは NG', () => {
  assertError(check({ labels: ['product-a/v1.6.0'] }), /より新しいバージョンです/);
});

test('main：対応するブランチがないバージョンは NG', () => {
  assertError(check({ labels: ['product-a/v1.4.1'] }), /v1\.4\.1 のブランチがありません/);
  // product-b には v1.3.0 のリリースブランチがない
  assertError(check({ labels: ['product-b/v1.3.0'], affectedProducts: ['product-b'] }), /v1\.3\.0 のブランチがありません/);
});

test('main：VERSION を上げる PR には、上げた後のバージョンを付ける', () => {
  const bump = { affectedProducts: [], version: versionFile('1.6.0', '1.5.0'), baseVersion: versionFile('1.5.0', '1.5.0') };
  assertOk(check({ ...bump, labels: ['product-a/v1.6.0'] }));
  assertError(check({ ...bump, labels: ['product-a/v1.5.0'] }), /product-a\/v1\.6\.0 を付けてください/);
  assertError(check({ ...bump, labels: ['product-b/v1.5.0'] }), /product-a のリリースラベルが付いていません/);
});

test('main：両方の製品の VERSION を上げる PR には、両方のラベルが必要', () => {
  const bump = { affectedProducts: [], version: versionFile('1.6.0', '1.6.0'), baseVersion: versionFile('1.5.0', '1.5.0') };
  assertError(check({ ...bump, labels: ['product-a/v1.6.0'] }), /product-b のリリースラベルが付いていません/);
  assertOk(check({ ...bump, labels: ['product-a/v1.6.0', 'product-b/v1.6.0'] }));
});

test('main：VERSION を下げる PR は NG', () => {
  assertError(
    check({ labels: ['product-a/v1.4.0'], version: versionFile('1.4.0', '1.5.0'), baseVersion: versionFile('1.5.0', '1.5.0') }),
    /1\.5\.0 から 1\.4\.0 に下げています/,
  );
});

test('形式の誤ったラベルや、知らない製品のラベルは NG', () => {
  assertError(check({ labels: ['product-a/1.5.0'] }), /形式/);
  assertError(check({ labels: ['product-a/v1.5'] }), /形式/);
  assertError(check({ labels: ['product-a/v1.5.0', 'product-c/v1.0.0'] }), /product-c は VERSION ファイルにありません/);
});

test('リリースラベルと関係のないラベルは無視する', () => {
  assertOk(check({ labels: ['product-a/v1.5.0', 'bug', 'type/feature'] }));
});

test('リリースブランチ：Q＆A の 3 パターン', () => {
  const v130 = { baseBranch: 'release/product-a/v1.3.0', version: versionFile('1.3.0', '1.3.0') };
  const v140 = { baseBranch: 'release/product-a/v1.4.0', version: versionFile('1.4.0', '1.4.0') };
  assertOk(check({ ...v130, labels: ['product-a/v1.3.0'] }));
  assertOk(check({ ...v140, labels: ['product-a/v1.4.0'] }));
  assertOk(check({ ...v140, labels: ['product-a/v1.3.0'] }));
});

test('リリースブランチ：main 以外への PR は警告を出す', () => {
  const result = check({ baseBranch: 'release/product-a/v1.4.0', version: versionFile('1.4.0', '1.4.0'), labels: ['product-a/v1.4.0'] });
  assert.equal(result.warnings.length, 1);
});

test('リリースブランチ：他の製品のラベルは NG', () => {
  const result = check({
    baseBranch: 'release/product-a/v1.4.0',
    version: versionFile('1.4.0', '1.4.0'),
    labels: ['product-a/v1.4.0', 'product-b/v1.4.0'],
    affectedProducts: ['product-a', 'product-b'],
  });
  assertError(result, /product-a のリリースラベルだけを付けてください/);
  assert.equal(result.errors.length, 1);
});

test('リリースブランチ：その製品のラベルがなければ NG', () => {
  assertError(
    check({ baseBranch: 'release/product-a/v1.4.0', version: versionFile('1.4.0', '1.4.0'), labels: [] }),
    /product-a のリリースラベルが付いていません/,
  );
});

test('リリースブランチ：ブランチより新しいラベルは NG', () => {
  assertError(
    check({ baseBranch: 'release/product-a/v1.4.0', version: versionFile('1.4.0', '1.4.0'), labels: ['product-a/v1.5.0'] }),
    /より新しいバージョンです/,
  );
});

test('リリースブランチ：マージ後の VERSION がブランチ名と違えば NG（別のブランチから切った作業ブランチなど）', () => {
  // release/product-a/v1.4.0 から切った作業ブランチを、誤って v1.3.0 に向けた
  const wrongBase = {
    baseBranch: 'release/product-a/v1.3.0',
    version: versionFile('1.4.0', '1.3.0'),
    baseVersion: versionFile('1.3.0', '1.3.0'),
  };
  assertError(check({ ...wrongBase, labels: ['product-a/v1.4.0'] }), /ブランチのバージョン（v1\.3\.0）と一致しません/);
  assertError(check({ ...wrongBase, labels: ['product-a/v1.3.0'] }), /ブランチのバージョン（v1\.3\.0）と一致しません/);
});

test('修正フェーズ：VERSION を上げるまでは、新しいバージョンのラベルは付けられない', () => {
  const branches = [...BRANCHES, 'release/product-a/v1.2.1'];
  const base = { baseBranch: 'release/product-a/v1.2.1', branches, labels: ['product-a/v1.2.1'] };
  assertError(check({ ...base, version: versionFile('1.2.0', '1.2.0') }), /より新しいバージョンです/);
  const bump = { ...base, affectedProducts: [], baseVersion: versionFile('1.2.0', '1.2.0') };
  assertOk(check({ ...bump, version: versionFile('1.2.1', '1.2.0') }));
  assertError(check({ ...bump, labels: ['product-a/v1.2.0'], version: versionFile('1.2.1', '1.2.0') }), /product-a\/v1\.2\.1 を付けてください/);
  // ブランチ名より先まで上げてしまった
  assertError(check({ ...bump, labels: ['product-a/v1.3.0'], version: versionFile('1.3.0', '1.2.0') }), /一致しません/);
});

const PRODUCTS = ['product-a', 'product-b', 'product-c'];

test('影響する製品：paths-filter が当てたフィルタのうち、VERSION にある製品だけを使う', () => {
  const result = findAffectedProducts({
    matched: ['product-a', 'product-b', 'listed', 'all'],
    products: PRODUCTS,
    changedFileCount: 1,
    allFileCount: 1,
    listedFileCount: 1,
  });
  assert.deepEqual(result.products, ['product-a', 'product-b']);
  assert.equal(result.reason, null);
});

test('影響する製品：パス設定に書かれていないファイルがあれば、すべての製品に影響するとみなす', () => {
  const result = findAffectedProducts({ matched: ['product-a', 'listed', 'all'], products: PRODUCTS, changedFileCount: 2, allFileCount: 2, listedFileCount: 1 });
  assert.deepEqual(result.products, PRODUCTS);
  assert.match(result.reason, /書かれていないパス/);
});

test('影響する製品：変更ファイルが 3000 件を超えれば、すべての製品に影響するとみなす', () => {
  const counts = { allFileCount: 3000, listedFileCount: 3000 };
  assert.deepEqual(findAffectedProducts({ matched: ['product-a'], products: PRODUCTS, changedFileCount: 3001, ...counts }).products, PRODUCTS);
  assert.deepEqual(findAffectedProducts({ matched: ['product-a'], products: PRODUCTS, changedFileCount: 3000, ...counts }).products, ['product-a']);
});

test('影響する製品：all と listed の件数がなければエラー（パス設定の誤り）', () => {
  assert.throws(() => findAffectedProducts({ matched: [], products: PRODUCTS, changedFileCount: 1, allFileCount: NaN, listedFileCount: 1 }));
});

test('マージ先が main でもリリースブランチでもなければ NG', () => {
  assertError(check({ baseBranch: 'release/product-c/v1.0.0', labels: ['product-a/v1.5.0'] }), /マージ先/);
  assertError(check({ baseBranch: 'release/v1.0.0', labels: ['product-a/v1.5.0'] }), /マージ先/);
});

// cherry-pick 先（開発ルールの Q＆A と同じ状況：main は v1.5.0、product-a のリリースブランチは v1.3.0 と v1.4.0）
function targets({ baseBranch = 'main', labels, version = versionFile('1.5.0', '1.5.0'), branches = BRANCHES }) {
  return findCherryPickTargets({ baseBranch, labels, versionFile: version, branches });
}

test('cherry-pick：main で、main のバージョンのラベルならどこにも cherry-pick しない', () => {
  assert.deepEqual(targets({ labels: ['product-a/v1.5.0'] }), { targets: [], problems: [] });
});

test('cherry-pick：main で、リリースブランチのバージョンのラベルなら、そのバージョン以上のリリースブランチすべてに入れる', () => {
  assert.deepEqual(targets({ labels: ['product-a/v1.3.0'] }).targets, ['release/product-a/v1.3.0', 'release/product-a/v1.4.0']);
  assert.deepEqual(targets({ labels: ['product-a/v1.4.0'] }).targets, ['release/product-a/v1.4.0']);
});

test('cherry-pick：リリースブランチで、マージ先より古いバージョンのブランチにだけ入れる（Q＆A の 3 パターン）', () => {
  const v130 = { baseBranch: 'release/product-a/v1.3.0', version: versionFile('1.3.0', '1.3.0') };
  const v140 = { baseBranch: 'release/product-a/v1.4.0', version: versionFile('1.4.0', '1.4.0') };
  assert.deepEqual(targets({ ...v130, labels: ['product-a/v1.3.0'] }).targets, []);
  assert.deepEqual(targets({ ...v140, labels: ['product-a/v1.4.0'] }).targets, []);
  assert.deepEqual(targets({ ...v140, labels: ['product-a/v1.3.0'] }).targets, ['release/product-a/v1.3.0']);
});

test('cherry-pick：共有コードの変更は、製品ごとに入れる', () => {
  assert.deepEqual(targets({ labels: ['product-a/v1.3.0', 'product-b/v1.4.0'] }).targets, [
    'release/product-a/v1.3.0',
    'release/product-a/v1.4.0',
    'release/product-b/v1.4.0',
  ]);
});

test('cherry-pick：cherry-pick の PR（行き先のバージョンのラベル）がマージされても、先へは広がらない', () => {
  const pick = { baseBranch: 'release/product-a/v1.3.0', version: versionFile('1.3.0', '1.3.0'), labels: ['product-a/v1.3.0'] };
  assert.deepEqual(targets(pick), { targets: [], problems: [] });
});

test('cherry-pick：ラベルのバージョンのブランチがなくなっていたら知らせる（それ以上のブランチには入れる）', () => {
  const result = targets({ labels: ['product-a/v1.2.0'] });
  assert.deepEqual(result.targets, ['release/product-a/v1.3.0', 'release/product-a/v1.4.0']);
  assert.match(result.problems[0], /v1\.2\.0 のリリースブランチがない/);
});

test('cherry-pick：リリースブランチへの PR に付いた他の製品のラベルは無視する', () => {
  const result = targets({ baseBranch: 'release/product-a/v1.4.0', version: versionFile('1.4.0', '1.4.0'), labels: ['product-a/v1.4.0', 'product-b/v1.4.0'] });
  assert.deepEqual(result, { targets: [], problems: [] });
});

test('cherry-pick：マージ先より新しいラベルや、形式の誤ったラベルは知らせる', () => {
  assert.match(targets({ labels: ['product-a/v1.6.0'] }).problems[0], /マージ先のバージョン（v1\.5\.0）より新しい/);
  assert.match(targets({ labels: ['product-a/1.5.0'] }).problems[0], /形式/);
});

test('cherry-pick：main で、VERSION を上げる前に作った同じバージョンのリリースブランチにも入れる', () => {
  const branches = [...BRANCHES, 'release/product-a/v1.5.0'];
  assert.deepEqual(targets({ labels: ['product-a/v1.5.0'], branches }).targets, ['release/product-a/v1.5.0']);
  assert.deepEqual(targets({ labels: ['product-a/v1.4.0'], branches }).targets, ['release/product-a/v1.4.0', 'release/product-a/v1.5.0']);
});
