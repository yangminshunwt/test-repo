// リリースラベルのルール（開発ルールの「保護ブランチに対する保護」）を確かめる。
// GitHub に依存しない関数だけを置き、単体テストできるようにしている。
'use strict';

const path = require('path');

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_BRANCH_PATTERN = /^release\/([^/]+)\/v(\d+\.\d+\.\d+)$/;
const RELEASE_LABEL_VERSION_PATTERN = /^v(\d+\.\d+\.\d+)$/;
// GitHub の API が返す PR の変更ファイルの上限
const MAX_LISTED_FILES = 3000;

function parseVersion(text) {
  const match = VERSION_PATTERN.exec(text);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

// VERSION ファイルの中身を { 製品名: 'X.Y.Z' } にする。
function parseVersionFile(text) {
  const versions = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [product, version, ...rest] = line.split('/');
    if (!product || rest.length > 0 || !parseVersion(version ?? '')) {
      throw new Error(`VERSION ファイルの行の形式が不正です: ${line}`);
    }
    if (product in versions) {
      throw new Error(`VERSION ファイルに ${product} が複数あります`);
    }
    versions[product] = version;
  }
  return versions;
}

// release/<製品名>/vX.Y.Z なら { product, version } を、そうでなければ null を返す。
function parseReleaseBranch(name) {
  const match = RELEASE_BRANCH_PATTERN.exec(name);
  return match ? { product: match[1], version: match[2] } : null;
}

// 変更が影響する製品を、labeler が付けた製品のラベルから決める。
// labeler は移動元のパスを見ず、GitHub が返す変更ファイルも上限があるので、
// ディレクトリをまたぐ移動がある場合と、変更ファイルが上限を超える場合は、すべての製品に影響するとみなす。
// files: GitHub が返す変更ファイル（filename、status、previous_filename）
function findAffectedProducts({ labels, products, files, changedFileCount }) {
  if (changedFileCount > MAX_LISTED_FILES) {
    return { products: [...products], reason: `変更ファイルが ${MAX_LISTED_FILES} 件を超えるため、すべての製品に影響するとみなしました。` };
  }
  const moved = files.find(
    (file) => file.status === 'renamed' && path.posix.dirname(file.previous_filename) !== path.posix.dirname(file.filename),
  );
  if (moved) {
    return {
      products: [...products],
      reason: `ディレクトリをまたぐファイルの移動（${moved.previous_filename} → ${moved.filename} など）があるため、すべての製品に影響するとみなしました。`,
    };
  }
  return { products: labels.filter((label) => products.includes(label)), reason: null };
}

// PR のラベルのうち、リリースラベル（<製品名>/vX.Y.Z）とその形式の誤りを取り出す。
// <製品名>/ で始まるか、/v<数字> を含むラベルをリリースラベルのつもりとみなす。
function extractReleaseLabels(labels, products) {
  const releaseLabels = [];
  const errors = [];
  for (const label of labels) {
    const slash = label.indexOf('/');
    if (slash < 0) continue;
    const product = label.slice(0, slash);
    const rest = label.slice(slash + 1);
    const known = products.includes(product);
    if (!known && !/^v\d/.test(rest)) continue;
    if (!known) {
      errors.push(`${label}：製品 ${product} は VERSION ファイルにありません。`);
      continue;
    }
    const match = RELEASE_LABEL_VERSION_PATTERN.exec(rest);
    if (!match) {
      errors.push(`${label}：リリースラベルの形式（${product}/vX.Y.Z）になっていません。`);
      continue;
    }
    releaseLabels.push({ label, product, version: match[1] });
  }
  return { releaseLabels, errors };
}

// baseBranch: PR のマージ先
// labels: PR に付いているラベル
// affectedProducts: 変更が影響する製品
// versionFile / baseVersionFile: マージ後とマージ前の VERSION ファイルの中身
// branches: 今あるブランチの名前（リリースブランチを含む）
function checkReleaseLabels({ baseBranch, labels, affectedProducts, versionFile, baseVersionFile, branches }) {
  const versions = parseVersionFile(versionFile);
  const baseVersions = parseVersionFile(baseVersionFile);
  const products = Object.keys(versions);
  const warnings = [];
  const { releaseLabels: allReleaseLabels, errors } = extractReleaseLabels(labels, products);
  let releaseLabels = allReleaseLabels;

  const bumpedProducts = products.filter((product) => baseVersions[product] !== versions[product]);
  for (const product of Object.keys(baseVersions)) {
    if (!(product in versions)) warnings.push(`VERSION ファイルから ${product} がなくなります。`);
  }

  let release = null;
  let requiredProducts;
  if (baseBranch === 'main') {
    requiredProducts = [...new Set([...affectedProducts.filter((product) => products.includes(product)), ...bumpedProducts])];
  } else {
    release = parseReleaseBranch(baseBranch);
    if (!release || !products.includes(release.product)) {
      errors.push(`マージ先の ${baseBranch} は、main でも release/<製品名>/vX.Y.Z の形式のリリースブランチでもありません。`);
      return { errors, warnings, releaseLabels };
    }
    requiredProducts = [release.product];
    warnings.push(`main 以外（${baseBranch}）に向けた PR です。main にデグレが出ないか確認してください。`);
    for (const { label, product } of releaseLabels) {
      if (product !== release.product) {
        errors.push(`${label}：${release.product} のリリースブランチへの PR には、${release.product} のリリースラベルだけを付けてください。`);
      }
    }
    releaseLabels = releaseLabels.filter(({ product }) => product === release.product);
    if (versions[release.product] !== release.version) {
      errors.push(
        `マージ後の VERSION（${release.product}/${versions[release.product]}）が、マージ先のブランチのバージョン（v${release.version}）と一致しません。先に VERSION を上げるか、作業ブランチを切ったブランチを確かめてください。`,
      );
    }
  }

  const labelsByProduct = new Map();
  for (const releaseLabel of releaseLabels) {
    const list = labelsByProduct.get(releaseLabel.product) ?? [];
    list.push(releaseLabel);
    labelsByProduct.set(releaseLabel.product, list);
  }

  if (allReleaseLabels.length === 0 && requiredProducts.length === 0) {
    errors.push('リリースラベルが付いていません。');
  }
  for (const product of requiredProducts) {
    if (!labelsByProduct.has(product)) {
      errors.push(`${product} に影響する変更ですが、${product} のリリースラベルが付いていません。`);
    }
  }
  if (!release && requiredProducts.length > 0) {
    for (const product of labelsByProduct.keys()) {
      if (!requiredProducts.includes(product)) {
        warnings.push(`${product} に影響する変更は見つかりませんでしたが、${product} のリリースラベルが付いています。`);
      }
    }
  }
  for (const [product, list] of labelsByProduct) {
    if (list.length > 1) {
      errors.push(`${product} のリリースラベルが複数あります（${list.map((l) => l.label).join('、')}）。製品ごとに 1 つだけ付けてください。`);
    }
  }

  // VERSION を変える PR では、バージョンは上げるだけで、ラベルは上げた後のバージョンにする。
  for (const product of bumpedProducts) {
    if (release && product !== release.product) continue;
    const [before, after] = [baseVersions[product], versions[product]];
    if (before !== undefined && compareVersions(after, before) < 0) {
      errors.push(`VERSION の ${product} を ${before} から ${after} に下げています。`);
    }
    for (const { label, version } of labelsByProduct.get(product) ?? []) {
      if (version !== after) {
        errors.push(`${label}：VERSION の ${product} を ${after} にする PR には、${product}/v${after} を付けてください。`);
      }
    }
  }

  // ラベルのバージョンは、マージ後の VERSION 以下で、その製品のブランチのどれかと一致していなければならない。
  // main のバージョンはマージ後の VERSION、リリースブランチのバージョンはブランチ名で数える。
  const knownVersions = new Map(products.map((product) => [product, new Set()]));
  if (!release) {
    for (const product of products) knownVersions.get(product).add(versions[product]);
  }
  for (const name of branches) {
    const branch = parseReleaseBranch(name);
    if (branch && knownVersions.has(branch.product)) {
      knownVersions.get(branch.product).add(branch.version);
    }
  }
  for (const { label, product, version } of releaseLabels) {
    if (compareVersions(version, versions[product]) > 0) {
      errors.push(`${label}：マージ後の VERSION（${product}/${versions[product]}）より新しいバージョンです。`);
    } else if (!knownVersions.get(product).has(version)) {
      errors.push(`${label}：${product} に v${version} のブランチがありません。main の VERSION か、今あるリリースブランチのバージョンを付けてください。`);
    }
  }

  return { errors, warnings, releaseLabels };
}

module.exports = {
  checkReleaseLabels,
  compareVersions,
  findAffectedProducts,
  parseReleaseBranch,
  parseVersionFile,
};
