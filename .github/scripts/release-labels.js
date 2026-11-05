// リリースラベルのルール（開発ルールの「保護ブランチに対する保護」）を確かめる。
// GitHub に依存しない関数だけを置き、単体テストできるようにしている。
'use strict';

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

// 変更が影響する製品を、paths-filter が当てたフィルタの名前から決める。
// 次の場合は、すべての製品に影響するとみなす。
// - 製品のパス設定に書かれていないファイルの変更がある（all に当たったファイルが listed より多い）
// - GitHub が返す PR の変更ファイルの上限を超えている
function findAffectedProducts({ matched, products, changedFileCount, allFileCount, listedFileCount }) {
  if (!Number.isInteger(allFileCount) || !Number.isInteger(listedFileCount)) {
    throw new Error('paths-filter の all と listed の件数がありません。.github/product-paths.yml を確かめてください。');
  }
  if (changedFileCount > MAX_LISTED_FILES) {
    return { products: [...products], reason: `変更ファイルが ${MAX_LISTED_FILES} 件を超えるため、すべての製品に影響するとみなしました。` };
  }
  if (allFileCount > listedFileCount) {
    return {
      products: [...products],
      reason: '.github/product-paths.yml に書かれていないパスの変更があるため、すべての製品に影響するとみなしました。そのパスを使う製品に書き足してください。',
    };
  }
  return { products: products.filter((product) => matched.includes(product)), reason: null };
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
  // main で上げるときは、上げる前のバージョンのリリースブランチを先に作っておく（開発フェーズの入り方の順番）。
  for (const product of bumpedProducts) {
    if (release && product !== release.product) continue;
    const [before, after] = [baseVersions[product], versions[product]];
    if (before !== undefined && compareVersions(after, before) < 0) {
      errors.push(`VERSION の ${product} を ${before} から ${after} に下げています。`);
    } else if (!release && before !== undefined && !branches.includes(`release/${product}/v${before}`)) {
      errors.push(`VERSION の ${product} を上げる前に、release/${product}/v${before} を作ってください（Actions の「Release prep」を使うと順番どおりに進みます）。`);
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

// マージされた PR の変更を cherry-pick するブランチを決める。
// 製品ごとに、ラベルのバージョン以上、マージ先のバージョンまでのリリースブランチを返す（マージ先自身は除く）。
// マージ先のバージョンは、main ならマージ後の VERSION、リリースブランチならブランチ名で数える。
// main と同じバージョンのリリースブランチ（VERSION を上げる前に作ったもの）も行き先に入れる。
// cherry-pick の PR には行き先のブランチのバージョンのラベルを付けるので、その PR がマージされても先へは広がらない。
// missing には、ラベルのバージョンのリリースブランチがないもの（リリース後に消したか、まだ作っていない）を返す。
function findCherryPickTargets({ baseBranch, labels, versionFile, branches }) {
  const versions = parseVersionFile(versionFile);
  const products = Object.keys(versions);
  const { releaseLabels, errors: problems } = extractReleaseLabels(labels, products);
  const release = baseBranch === 'main' ? null : parseReleaseBranch(baseBranch);
  if (baseBranch !== 'main' && !release) {
    problems.push(`マージ先の ${baseBranch} は、main でも release/<製品名>/vX.Y.Z の形式のリリースブランチでもありません。`);
    return { targets: [], problems, missing: [] };
  }

  const releaseBranches = branches.map(parseReleaseBranch).filter(Boolean);
  const targets = [];
  const missing = [];
  for (const { label, product, version } of releaseLabels) {
    // リリースブランチへの PR に付いた他の製品のラベルは、ラベルのチェックで止めているので無視する
    if (release && product !== release.product) continue;
    const upper = release ? release.version : versions[product];
    if (compareVersions(version, upper) > 0) {
      problems.push(`${label}：マージ先のバージョン（v${upper}）より新しいバージョンです。`);
      continue;
    }
    const productBranches = releaseBranches.filter((branch) => branch.product === product);
    if (compareVersions(version, upper) < 0 && !productBranches.some((branch) => branch.version === version)) {
      missing.push({ label, product, version });
    }
    const belowUpper = (branchVersion) => (release ? compareVersions(branchVersion, upper) < 0 : compareVersions(branchVersion, upper) <= 0);
    for (const branch of productBranches) {
      if (compareVersions(branch.version, version) >= 0 && belowUpper(branch.version)) {
        targets.push(`release/${branch.product}/v${branch.version}`);
      }
    }
  }
  return { targets: [...new Set(targets)].sort(), problems, missing };
}

// リリースの準備（開発ルールの「main ブランチにおいて機能の開発は終了しリリース前の準備フェーズに入りたい場合」）で、
// main の今のバージョンから作るリリースブランチと、次のバージョン（bump は minor か major）とそのリリースラベルを決める。
function planReleasePrep({ versionFile, product, bump }) {
  const versions = parseVersionFile(versionFile);
  if (!(product in versions)) {
    return { errors: [`製品 ${product} は VERSION ファイルにありません（${Object.keys(versions).join('、')}）。`] };
  }
  const currentVersion = versions[product];
  const [major, minor] = parseVersion(currentVersion);
  const nextVersions = { minor: `${major}.${minor + 1}.0`, major: `${major + 1}.0.0` };
  if (!(bump in nextVersions)) {
    return { errors: [`上げ方 ${bump} は minor か major にしてください。`] };
  }
  const nextVersion = nextVersions[bump];
  return {
    errors: [],
    currentVersion,
    nextVersion,
    releaseBranch: `release/${product}/v${currentVersion}`,
    nextLabel: `${product}/v${nextVersion}`,
  };
}

// VERSION ファイルの、その製品の行だけを書き換える（コメントやほかの行はそのまま）。
function setVersion(versionFile, product, version) {
  let found = false;
  const lines = versionFile.split('\n').map((line) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.split('/')[0] !== product) return line;
    found = true;
    return `${product}/${version}`;
  });
  if (!found) throw new Error(`VERSION ファイルに ${product} がありません`);
  return lines.join('\n');
}

module.exports = {
  checkReleaseLabels,
  compareVersions,
  findAffectedProducts,
  findCherryPickTargets,
  parseReleaseBranch,
  parseVersionFile,
  planReleasePrep,
  setVersion,
};
