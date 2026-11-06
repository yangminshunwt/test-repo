// 開発ルールの、リリースラベル・バージョン・ブランチ名のルール。
// GitHub に依存しない関数だけを置き、単体テストできるようにしている。
'use strict';

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_BRANCH_PATTERN = /^release\/([^/]+)\/v(\d+\.\d+\.\d+)$/;
const RELEASE_LABEL_VERSION_PATTERN = /^v(\d+\.\d+\.\d+)$/;
// GitHub の API が返す PR の変更ファイルの上限（これ以上は返さない）
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

// cherry-pick の PR のブランチ名（cherry-pick.yml の branch_name と同じ形）。手で cherry-pick するときも、この名前にしてもらう。
function cherryPickBranch(prNumber, target) {
  return `cherry-pick-${prNumber}-to-${target}`;
}

// cherry-pick の PR のブランチ名なら元の PR の番号を、そうでなければ null を返す。
function parseCherryPickBranch(name) {
  const match = /^cherry-pick-(\d+)-to-/.exec(name);
  return match ? Number(match[1]) : null;
}

// paths-filter の all と listed に当たったファイルの数から、すべての製品に影響するとみなす理由を返す（なければ null）。
// - all に当たったファイルが、GitHub が返す変更ファイルの上限以上ある（一覧が途中で切れているかもしれない。
//   paths-filter は名前の変更を 2 件と数えるので、上限ちょうどでも切れていないことはあるが、安全側に倒す）
// - 製品のパス設定に書かれていないファイルの変更がある（all に当たったファイルが listed より多い）
function reasonForAllProducts({ allFileCount, listedFileCount }) {
  if (!Number.isInteger(allFileCount) || !Number.isInteger(listedFileCount)) {
    throw new Error('paths-filter の all と listed の件数がありません。.github/product-paths.yml を確かめてください。');
  }
  if (allFileCount >= MAX_LISTED_FILES) return `変更ファイルが ${MAX_LISTED_FILES} 件以上あるため、すべての製品に影響するとみなしました。`;
  if (allFileCount > listedFileCount) {
    return '.github/product-paths.yml に書かれていないパスの変更があるため、すべての製品に影響するとみなしました。そのパスを使う製品に書き足してください。';
  }
  return null;
}

// 変更が影響する製品を、paths-filter が当てたフィルタの名前から決める。
function findAffectedProducts({ matched, products, allFileCount, listedFileCount }) {
  const reason = reasonForAllProducts({ allFileCount, listedFileCount });
  if (reason) return { products: [...products], reason };
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
// archivedLabels: PR に付いているラベルのうち、アーカイブ済みのもの（リリース手順でリリース済みのラベルをアーカイブする）
// releasedLabels: リリースタグ（<製品名>/vX.Y.Z）があるラベル。アーカイブより先にタグが打たれるので、タグでも確かめる
function checkReleaseLabels({ baseBranch, labels, affectedProducts, versionFile, baseVersionFile, branches, archivedLabels = [], releasedLabels = [] }) {
  const versions = parseVersionFile(versionFile);
  const baseVersions = parseVersionFile(baseVersionFile);
  const products = Object.keys(versions);
  const warnings = [];
  const { releaseLabels: allReleaseLabels, errors } = extractReleaseLabels(labels, products);
  let releaseLabels = allReleaseLabels;
  const hasBranch = (product, version) => branches.includes(`release/${product}/v${version}`);

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

  for (const product of requiredProducts) {
    if (!labelsByProduct.has(product)) {
      errors.push(`${product} に影響する変更ですが、${product} のリリースラベルが付いていません。`);
    }
  }
  // 影響しない製品のラベルは止める（古いバージョンなら、関係のない変更がその製品のリリースブランチに cherry-pick される）。
  // どの製品にも影響しない変更（docs や自動化だけなど）には、リリースラベルは付けない。
  if (!release) {
    for (const product of labelsByProduct.keys()) {
      if (!requiredProducts.includes(product)) {
        errors.push(
          `${product} に影響する変更はありませんが、${product} のリリースラベルが付いています。外すか、${product} が使うパスなら .github/product-paths.yml に書き足してください。`,
        );
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
    } else if (!release && before !== undefined && !hasBranch(product, before)) {
      errors.push(`VERSION の ${product} を上げる前に、release/${product}/v${before} を作ってください（Actions の「Release Preparation」を使うと順番どおりに進みます）。`);
    }
    for (const { label, version } of labelsByProduct.get(product) ?? []) {
      if (version !== after) {
        errors.push(`${label}：VERSION の ${product} を ${after} にする PR には、${product}/v${after} を付けてください。`);
      }
    }
  }

  // ラベルのバージョンは、マージ先のバージョン以下で、マージ先のバージョンか、今あるリリースブランチのバージョンでなければならない。
  // マージ先のバージョンは、main ならマージ後の VERSION、リリースブランチならブランチ名
  // （リリースブランチで、マージ後の VERSION がブランチ名と違うときは、上の「一致しません」で止まる）。
  for (const { label, product, version } of releaseLabels) {
    const upper = release ? release.version : versions[product];
    if (archivedLabels.includes(label) || releasedLabels.includes(label)) {
      // リリースしたあとも残しているリリースブランチ（リリースより後のコミットがあったもの）への PR は、そのブランチに入れても
      // どのリリースにも入らない
      errors.push(
        release && version === release.version
          ? `${label}：${baseBranch} はリリース済みです（このブランチに入れても、どのリリースにも入りません）。この PR はマージせずに閉じてください。` +
            'cherry-pick の PR なら、先に元の PR のリリースラベルをこのブランチより新しいバージョンに付け替えてください。' +
            '閉じたあと Tag Creation の release を実行し直すと、このブランチは消えます。入れる変更なら、そのあと Hotfix Preparation で作るブランチに出し直してください。'
          : `${label}：リリース済みのバージョンです。これから入るリリースのバージョンを付けてください。`,
      );
    } else if (compareVersions(version, upper) > 0) {
      const target = release ? `マージ先のブランチのバージョン（v${upper}）` : `マージ後の VERSION（${product}/${upper}）`;
      // main で、VERSION を上げる PR（Release Preparation が作ったもの）のマージ待ちのことがある
      const guide = release
        ? ''
        : `${product} の VERSION を上げる PR がマージ待ちなら、ラベルはそのままで、マージされたあとに Update branch してください（ラベルを下げると、リリース準備中のブランチに cherry-pick されます）。`;
      errors.push(`${label}：${target}より新しいバージョンです。${guide}`);
    } else if (version !== upper && !hasBranch(product, version)) {
      const guide = release
        ? `マージ先のブランチのバージョン（v${release.version}）か、それより古い今あるリリースブランチのバージョンを付けてください。`
        : 'マージ後の VERSION か、今あるリリースブランチのバージョンを付けてください。';
      errors.push(`${label}：${product} に v${version} のブランチがありません。${guide}`);
    }
  }

  return { errors, warnings, releaseLabels };
}

// マージされた PR の変更を cherry-pick するブランチを決める。
// 製品ごとに、ラベルのバージョン以上、マージ先のバージョン以下のリリースブランチを返す（マージ先自身は除く）。
// マージ先のバージョンは、main ならマージ後の VERSION（VERSION を上げる前に作った同じバージョンのブランチも入る）、リリースブランチならブランチ名。
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
    for (const branch of productBranches) {
      const name = `release/${product}/v${branch.version}`;
      if (compareVersions(branch.version, version) >= 0 && compareVersions(branch.version, upper) <= 0 && name !== baseBranch) {
        targets.push(name);
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
    return { error: `製品 ${product} は VERSION ファイルにありません（${Object.keys(versions).join('、')}）。` };
  }
  const currentVersion = versions[product];
  const [major, minor] = parseVersion(currentVersion);
  const nextVersions = { minor: `${major}.${minor + 1}.0`, major: `${major + 1}.0.0` };
  if (!(bump in nextVersions)) {
    return { error: `上げ方 ${bump} は minor か major にしてください。` };
  }
  const nextVersion = nextVersions[bump];
  return {
    currentVersion,
    nextVersion,
    releaseBranch: `release/${product}/v${currentVersion}`,
    nextLabel: `${product}/v${nextVersion}`,
  };
}

// 修正フェーズ（開発ルールの「リリース済みのバージョンに対しての修正フェーズに入りたい場合」）で、
// 製品の最新のリリースタグ（<製品名>/vX.Y.Z。rc などは除く）と、そこから作るリリースブランチ（次のパッチバージョン）を決める。
function planHotfixPrep({ versionFile, product, tags }) {
  const products = Object.keys(parseVersionFile(versionFile));
  if (!products.includes(product)) {
    return { error: `製品 ${product} は VERSION ファイルにありません（${products.join('、')}）。` };
  }
  const prefix = `${product}/v`;
  const released = tags.filter((tag) => tag.startsWith(prefix) && parseVersion(tag.slice(prefix.length))).map((tag) => tag.slice(prefix.length));
  if (released.length === 0) {
    return { error: `${product} のリリースタグ（${product}/vX.Y.Z）がまだありません。` };
  }
  const releasedVersion = released.sort(compareVersions).at(-1);
  const [major, minor, patch] = parseVersion(releasedVersion);
  const nextVersion = `${major}.${minor}.${patch + 1}`;
  return {
    releasedTag: `${product}/v${releasedVersion}`,
    releasedVersion,
    nextVersion,
    releaseBranch: `release/${product}/v${nextVersion}`,
    nextLabel: `${product}/v${nextVersion}`,
  };
}

// リリース手順（開発ルールの「リリース手順」）で打つタグを、リリースブランチの名前と今あるタグから決める。
// rc タグは <製品名>/vX.Y.Z-rc.N（N は 1 から順に）、リリースタグは <製品名>/vX.Y.Z。
function planRelease({ branch, tags }) {
  const release = parseReleaseBranch(branch);
  if (!release) {
    return { error: `${branch} はリリースブランチ（release/<製品名>/vX.Y.Z）ではありません。Use workflow from でリリースブランチを選んで実行してください。` };
  }
  const releaseTag = `${release.product}/v${release.version}`;
  const rcNumbers = tags
    .map((tag) => (tag.startsWith(`${releaseTag}-rc.`) ? tag.slice(`${releaseTag}-rc.`.length) : ''))
    .filter((n) => /^[1-9]\d*$/.test(n))
    .map(Number);
  const latestRc = rcNumbers.length > 0 ? Math.max(...rcNumbers) : null;
  return {
    product: release.product,
    version: release.version,
    releaseTag,
    released: tags.includes(releaseTag),
    latestRcTag: latestRc === null ? null : `${releaseTag}-rc.${latestRc}`,
    nextRcTag: `${releaseTag}-rc.${(latestRc ?? 0) + 1}`,
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
  MAX_LISTED_FILES,
  checkReleaseLabels,
  cherryPickBranch,
  compareVersions,
  extractReleaseLabels,
  findAffectedProducts,
  findCherryPickTargets,
  parseCherryPickBranch,
  parseReleaseBranch,
  parseVersionFile,
  planHotfixPrep,
  planRelease,
  planReleasePrep,
  reasonForAllProducts,
  setVersion,
};
