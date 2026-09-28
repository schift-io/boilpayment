import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const DIST = path.join(PACKAGE_ROOT, 'dist');
const TSC = path.join(PACKAGE_ROOT, 'node_modules/.bin/tsc');
const MODULES = [
  ['boilpayment-core', 'core', 'packages/core/ts'],
  ['boilpayment-credits', 'credits', 'packages/credits/ts'],
  ['boilpayment-lifecycle', 'lifecycle', 'packages/lifecycle/ts'],
  ['boilpayment-refund', 'refund', 'packages/refund/ts'],
  ['boilpayment-usage', 'usage', 'packages/usage/ts'],
  ['boilpayment-webhook', 'webhook', 'packages/webhook/ts'],
  ['boilpayment-notify', 'notify', 'packages/notify/ts'],
  ['boilpayment-cs', 'cs', 'packages/cs/ts'],
  ['boilpayment-schema-postgres', 'postgres', 'packages/schema-postgres/ts'],
  ['boilpayment-stripe', 'stripe', 'packages/providers/stripe/ts'],
  ['boilpayment-toss', 'toss', 'packages/providers/toss/ts'],
  ['boilpayment-portone', 'portone', 'packages/providers/portone/ts'],
  ['boilpayment-polar', 'polar', 'packages/providers/polar/ts'],
];
const MODULE_BY_PACKAGE = new Map(MODULES.map(([packageName, subpath]) => [packageName, subpath]));
const INTERNAL_SPECIFIER = /(['"])(boilpayment-(?:core|credits|lifecycle|refund|usage|webhook|notify|cs|schema-postgres|stripe|toss|portone|polar))(\/[^'"]*)?\1/g;

async function modulesInDependencyOrder() {
  const dependenciesByPackage = new Map();
  for (const [packageName, , relativePackageRoot] of MODULES) {
    const packageJsonPath = path.join(REPO_ROOT, relativePackageRoot, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    if (packageJson.name !== packageName) {
      throw new Error(`module list names ${packageName}, but ${packageJsonPath} names ${packageJson.name}`);
    }

    const internalDependencies = Object.keys(packageJson.dependencies ?? {})
      .filter((dependency) => dependency.startsWith('boilpayment-'));
    for (const dependency of internalDependencies) {
      if (!MODULE_BY_PACKAGE.has(dependency)) {
        throw new Error(`${packageName} depends on unlisted internal module ${dependency}`);
      }
    }
    dependenciesByPackage.set(packageName, internalDependencies);
  }

  const ordered = [];
  const built = new Set();
  const visiting = [];
  function visit(packageName) {
    if (built.has(packageName)) return;
    const cycleStart = visiting.indexOf(packageName);
    if (cycleStart !== -1) {
      throw new Error(`internal module dependency cycle: ${[...visiting.slice(cycleStart), packageName].join(' -> ')}`);
    }

    visiting.push(packageName);
    for (const dependency of dependenciesByPackage.get(packageName)) visit(dependency);
    visiting.pop();
    built.add(packageName);
    ordered.push(MODULES.find(([candidate]) => candidate === packageName));
  }

  for (const [packageName] of MODULES) visit(packageName);
  return { ordered, dependenciesByPackage };
}

function compile(tsconfig, rootDir, outDir) {
  execFileSync(TSC, [
    '-p', tsconfig,
    '--rootDir', rootDir,
    '--outDir', outDir,
    '--removeComments', 'true',
    '--sourceMap', 'false',
  ], { cwd: REPO_ROOT, stdio: 'inherit' });
}

async function filesBelow(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(file) : Promise.resolve([file]);
  }));
  return nested.flat();
}

await fs.mkdir(path.join(DIST, 'internal'), { recursive: true });
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'boilpayment-sdk-build-'));
try {
  const { ordered, dependenciesByPackage } = await modulesInDependencyOrder();
  for (const [packageName, subpath, relativePackageRoot] of ordered) {
    const moduleRoot = path.join(REPO_ROOT, relativePackageRoot);
    const paths = {};
    for (const dependency of dependenciesByPackage.get(packageName)) {
      const dependencySubpath = MODULE_BY_PACKAGE.get(dependency);
      const dependencyDist = path.join(DIST, 'internal', dependencySubpath);
      paths[dependency] = [path.join(dependencyDist, 'index.d.ts')];
      paths[`${dependency}/*`] = [path.join(dependencyDist, '*')];
    }

    const tempTsconfig = path.join(tempDir, `${subpath}.json`);
    await fs.writeFile(tempTsconfig, `${JSON.stringify({
      extends: path.join(moduleRoot, 'tsconfig.json'),
      compilerOptions: {
        paths,
        typeRoots: [path.join(moduleRoot, 'node_modules/@types')],
      },
    }, null, 2)}\n`);
    compile(
      tempTsconfig,
      path.join(moduleRoot, 'src'),
      path.join(DIST, 'internal', subpath),
    );
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

const sqlSource = path.join(REPO_ROOT, 'packages/schema-postgres/sql');
const sqlTarget = path.join(DIST, 'internal/postgres/sql');
await fs.mkdir(sqlTarget, { recursive: true });
for (const file of await fs.readdir(sqlSource)) {
  if (file.endsWith('.sql')) await fs.copyFile(path.join(sqlSource, file), path.join(sqlTarget, file));
}

compile(
  path.join(PACKAGE_ROOT, 'tsconfig.build.json'),
  path.join(PACKAGE_ROOT, 'src'),
  DIST,
);

const builtFiles = (await filesBelow(DIST)).filter((file) => file.endsWith('.js') || file.endsWith('.d.ts'));
for (const file of builtFiles) {
  const source = await fs.readFile(file, 'utf8');
  const rewritten = source.replace(INTERNAL_SPECIFIER, (quoted, quote, packageName, suffix = '') => {
    const subpath = MODULE_BY_PACKAGE.get(packageName);
    if (!subpath) return quoted;
    const requested = suffix ? suffix.slice(1) : 'index.js';
    const target = path.join(DIST, 'internal', subpath, path.extname(requested) ? requested : `${requested}.js`);
    const relative = path.relative(path.dirname(file), target).split(path.sep).join('/');
    return `${quote}${relative.startsWith('.') ? relative : `./${relative}`}${quote}`;
  });
  await fs.writeFile(file, rewritten);
}

const offenders = [];
for (const file of builtFiles) {
  const source = await fs.readFile(file, 'utf8');
  if (INTERNAL_SPECIFIER.test(source)) offenders.push(path.relative(PACKAGE_ROOT, file));
  INTERNAL_SPECIFIER.lastIndex = 0;
}
if (offenders.length > 0) {
  throw new Error(`bare internal specifiers remain:\n${offenders.join('\n')}`);
}
