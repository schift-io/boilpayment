# Release procedure

This is the exact, ordered set of commands to publish every `boilpayment-*` (npm) and
`boilpayment-*` (PyPI) package, plus `boilpayment` (the CLI) and
`boilpayment-sdk` / `boilpayment` (the single-install facade — see
`packages/sdk/ts/README.md` / `packages/sdk/py/README.md`; `boilpayment init` points every generated
project at this facade, not at the 13 packages it wraps). It is written for a maintainer to run
by hand — nothing here is automated.

**End-user install stays one line per language regardless of how many internal packages exist:**
`npm install boilpayment-sdk` / `pip install boilpayment`. The facade's own
dependencies pin all 13 internal packages to the exact version published alongside it (npm:
`workspace:*` rewritten to an exact version by `pnpm publish`/`pnpm pack`; PyPI: `==<version>`
literal in `packages/sdk/py/pyproject.toml`, bump it in lockstep with step 1 below), so version
skew between the facade and what it wraps can't happen.

**Repository:** every `package.json` (`homepage`/`repository`/`bugs`) and `pyproject.toml`
(`[project.urls]`) points at `https://github.com/schift-io/boilpayment`. See "저장소 URL" below.

## 0. Pre-flight checklist

Run from the repo root, in this order, and stop if any step fails:

```bash
pnpm run build                                              # tsc -p every ts package
.venv/bin/ruff check packages                                # py lint
pnpm run test                                                # vitest, every ts package
bash scripts/ci-pytest.sh                                    # pytest, every py package
pnpm run ec-coverage                                         # EC references map to spec+TS+Python; not behavioral test coverage
pnpm run parity                                               # ts/py behavioral parity
bash scripts/live.sh                                          # live-verified providers only — see below
```

`pnpm run check:all` runs all of the above in one shot. **Live verification status** (as of this
writing — re-check `docs/PUBLIC_SANDBOX_VERIFICATION.md` for the current state before you rely on this):

| provider | verified against |
|---|---|
| Toss | real Toss test API (public test keys) — `listPayments` has a known real bug, `INVALID_DATE` (see `packages/providers/toss/spec/toss.pseudo.md`) |
| Stripe | `stripe-mock` only — not Stripe's real API |
| PortOne | local mock (`tools/mocks/portone`, checked against the real OpenAPI spec) only — no real account keys used |
| Polar | local mock (`tools/mocks/polar`) only — no real account keys used |

If you have real PortOne/Polar sandbox keys, run `bash scripts/live.sh` with them set and update
this table before publishing those two provider packages.

## 1. Version bump

All packages are at `0.1.0` right now, kept in lockstep manually. For a coordinated release, bump
every `version` field in the same commit:

```bash
# TS packages
for f in packages/*/ts/package.json packages/providers/*/ts/package.json apps/cli/package.json; do
  node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('$f'));p.version='0.2.0';fs.writeFileSync('$f',JSON.stringify(p,null,2)+'\n')"
done

# Python packages
for f in packages/*/py/pyproject.toml packages/providers/*/py/pyproject.toml; do
  sed -i '' 's/^version = "0.1.0"$/version = "0.2.0"/' "$f"
done
```

The two loops above already cover `packages/sdk/ts/package.json` and `packages/sdk/py/pyproject.toml`
(the facade) since both live directly under `packages/*`. **One thing they don't cover**: unlike
every other package, the facade's Python `dependencies` pin the 13 internal packages with a literal
`==0.1.0` (not the bare unpinned form the other packages use — see step 2) *in the committed file*,
so the version bump above must also update those 13 pins in the same commit or `uv sync` breaks
(the facade would still ask for `==0.1.0` while the packages it wraps are now `0.2.0`):

```bash
sed -i '' 's/==0\.1\.0/==0.2.0/g' packages/sdk/py/pyproject.toml
```

(The npm facade needs no equivalent step — its `dependencies` are `workspace:*`, rewritten to the
exact version only at `pnpm publish`/`pnpm pack` time, same as every other TS package's internal
deps.)

Then `pnpm install` (relinks the workspace at the new version) and re-run the pre-flight
checklist. Individually-versioned packages (skip the ones that didn't change) is also fine —
`pnpm publish`/`uv publish` are per-package regardless.

## 2. Python workspace deps → real PyPI version constraints

Every `boilpayment-*` package that depends on another one in this repo (e.g. `credits` on
`core`) declares that dependency **unpinned** in `pyproject.toml`
(`dependencies = ["boilpayment-core"]`) — locally this is fine because
`[tool.uv.sources]` in the root `pyproject.toml` overrides it to the workspace member
(`{ workspace = true }`), which is *not* published metadata; it only affects local `uv sync`.

If you publish with the dependency left unpinned, `pip install boilpayment-credits` would
accept **any** version of `boilpayment-core` off PyPI, including a future breaking one.
Pin it right before building, then put the unpinned form back afterward so local dev keeps
working. This does **not** touch `[tool.uv.sources]` (that stays; it's what makes `uv sync` use
the local workspace copy even when the version below is pinned) — only the bare dependency name
gets a version range added:

```bash
# Run from repo root, right before step 3. VERSION must match what you published core/credits/etc.
# as in step 1.
VERSION=0.2.0
python3 - "$VERSION" << 'PYEOF'
import re, sys, pathlib

version = sys.argv[1]
major_minor = ".".join(version.split(".")[:2])
next_minor = f"{major_minor.rsplit('.', 1)[0]}.{int(major_minor.rsplit('.', 1)[1]) + 1}"
INTERNAL = {
    "boilpayment-core", "boilpayment-credits", "boilpayment-usage",
    "boilpayment-lifecycle", "boilpayment-refund", "boilpayment-webhook",
    "boilpayment-notify", "boilpayment-cs", "boilpayment-schema-postgres",
    "boilpayment-stripe", "boilpayment-polar", "boilpayment-toss",
    "boilpayment-portone",
}
for path in pathlib.Path(".").glob("packages/**/py/pyproject.toml"):
    text = path.read_text()
    for name in INTERNAL:
        # only touch a bare, unconstrained occurrence inside dependencies = [...]
        text = re.sub(rf'"{name}"(?!>=)', f'"{name}>={version},<{next_minor}"', text)
    path.write_text(text)
    print("pinned deps in", path)
PYEOF
```

Build and publish (step 3/4) using these pinned files. **Keep a copy of each `pyproject.toml`
before running this script** (e.g. `cp packages/core/py/pyproject.toml /tmp/pyproject-core.bak`
for each of the 13, or just note the `dependencies = [...]` line's original bare-name form before
editing). After publishing, manually put the bare-name form back in every file that was touched —
diff each file against its backup and edit the `dependencies` line back by hand. Do not leave the
pinned constraints committed — the next release's version bump would require editing them again
anyway, and `[tool.uv.sources]` already makes the pin irrelevant for local development.

## 3. Build and verify tarballs/wheels locally (no publish)

### TS — `npm pack --dry-run`

Run in dependency order (doesn't matter for a dry run, but matches step 5's real order); check
that `dist/` is present, tests/`src/` are absent, and package-specific extras are there:

```bash
for d in packages/core/ts packages/credits/ts packages/refund/ts packages/usage/ts \
         packages/webhook/ts packages/notify/ts packages/schema-postgres/ts \
         packages/providers/stripe/ts packages/providers/toss/ts \
         packages/providers/portone/ts packages/providers/polar/ts \
         packages/lifecycle/ts packages/cs/ts apps/cli packages/sdk/ts; do
  echo "== $d =="; (cd "$d" && npm pack --dry-run)
done
```

Check specifically:
- `boilpayment-schema-postgres` — `dist/sql/*.sql` (6 files) must be present (the build
  script copies them from `../sql/`; if you see them missing, the package wasn't rebuilt after a
  clean).
- `boilpayment` (CLI) — `templates/sql/*.sql` (6 files, synced by `prebuild`) and
  `dist/bin.js` must be present, and `dist/bin.js` must start with `#!/usr/bin/env node`
  (`head -1 apps/cli/dist/bin.js`).
- `boilpayment-sdk` (the facade) — `dist/` must contain a `.js`+`.d.ts` pair for every
  subpath in its `package.json` `exports` map (`core`, `credits`, `lifecycle`, `refund`, `usage`,
  `webhook`, `notify`, `cs`, `postgres`, `stripe`, `toss`, `portone`, `polar` — 13 pairs plus
  `index.*`). `npm pack --dry-run` only shows what plain `npm` sees — it does **not** rewrite the
  facade's `workspace:*` dependencies, so it can't verify those resolve to real versions. Use
  `pnpm pack` (or `pnpm publish`, which does the same rewrite) instead, from `packages/sdk/ts`, and
  inspect the produced tarball's `package.json`:
  ```bash
  cd packages/sdk/ts && pnpm pack && tar -xzO -f boilpayment-sdk-*.tgz package/package.json \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['dependencies'])"
  # every value must be a literal version like "0.1.0" — NOT "workspace:*"
  trash boilpayment-sdk-*.tgz
  ```
- Every package — `LICENSE` and `README.md` should appear in the listing (npm includes them
  automatically from each package's own directory; they were copied there, see §"Files added").

### Python — `uv build`

```bash
mkdir -p /tmp/paykit-release-check
for d in packages/core/py packages/credits/py packages/refund/py packages/usage/py \
         packages/webhook/py packages/notify/py packages/schema-postgres/py \
         packages/providers/stripe/py packages/providers/toss/py \
         packages/providers/portone/py packages/providers/polar/py \
         packages/lifecycle/py packages/cs/py packages/sdk/py; do
  echo "== $d =="
  uv build "$d" --out-dir /tmp/paykit-release-check || echo "FAILED: $d"
done
for f in /tmp/paykit-release-check/*.whl; do echo "== $f =="; unzip -l "$f"; done
```

`boilpayment` (the facade wheel) should list `boilpayment/__init__.py` plus one
`.py` per submodule (`core.py`, `credits.py`, `lifecycle.py`, `refund.py`, `usage.py`,
`webhook.py`, `notify.py`, `cs.py`, `postgres.py`, `stripe.py`, `toss.py`, `portone.py`,
`polar.py` — 13 files) and its `METADATA`'s `Requires-Dist` lines should show `==<version>` on
all 13 internal packages (see step 1's note on keeping those pins in lockstep with the version
bump):
```bash
unzip -p /tmp/paykit-release-check/boilpayment-*.whl '*.dist-info/METADATA' | grep '^Requires-Dist'
```

**Known defect — `boilpayment-schema-postgres` fails `uv build` (sdist → wheel-from-sdist)
today.** `pyproject.toml`'s `[tool.hatch.build.targets.wheel.force-include]` reads
`../sql` (i.e. `packages/schema-postgres/sql/`, one level above `py/`, shared with the TS
package). That works when the wheel is built directly from the source checkout, but a plain
`uv build`/`python -m build` first builds an sdist (self-contained, can't reach outside its own
project root) and then builds the wheel **from that sdist**, where `../sql` no longer exists —
confirmed reproduction: `uv build packages/schema-postgres/py` fails with
`FileNotFoundError: Forced include not found: .../sql`, while `uv build packages/schema-postgres/py --wheel`
(skips the sdist stage) succeeds and the wheel does contain the 6 `.sql` files. Two ways to
resolve, both change how this package is packaged (an owner call, not a metadata tweak, so left
undone):
- **Wheel-only release** for this one package: `uv build packages/schema-postgres/py --wheel`,
  then `uv publish` just the `.whl` (no sdist). Simplest, no source changes.
- **Or** physically copy `packages/schema-postgres/sql/*.sql` into
  `packages/schema-postgres/py/src/boilpayment_schema_postgres/sql/` as a checked-in
  duplicate (same pattern already used for `apps/cli/templates/sql/`, synced by
  `apps/cli/scripts/sync-templates.mjs`) and drop the `force-include` entirely. Needs a source
  change under `py/src/`, out of this task's packaging-only scope.

Every other package's `uv build` (sdist + wheel) succeeded as-is when this was last checked; each
wheel's `METADATA` had `License-Expression: MIT` and `License-File: LICENSE` and the right
`Project-URL`s.

## 4. Publish — TS (npm), dependency order

Use **`pnpm publish`**, not `npm publish`. Every internal dependency is declared as
`"workspace:*"` in `package.json` — only `pnpm publish` (or `pnpm pack`) rewrites that to the
real resolved version (`"boilpayment-core": "0.1.0"`) at pack time; a plain `npm publish`
would ship a broken `"workspace:*"` version range that no external installer can resolve.
`publishConfig.access` is already `"public"` on every `boilpayment*` package, but pass `--access
public` explicitly the first time too (npm sometimes still asks for scoped packages' first
publish):

```bash
npm whoami   # confirm you're logged in as the right npm account/org first

# 1st wave — only depend on core
for d in packages/core/ts packages/credits/ts packages/refund/ts packages/usage/ts \
         packages/webhook/ts packages/notify/ts packages/schema-postgres/ts \
         packages/providers/stripe/ts packages/providers/toss/ts \
         packages/providers/portone/ts packages/providers/polar/ts; do
  (cd "$d" && pnpm publish --access public --no-git-checks)
done

# 2nd wave — depend on 1st-wave packages
(cd packages/lifecycle/ts && pnpm publish --access public --no-git-checks)   # needs credits
(cd packages/cs/ts && pnpm publish --access public --no-git-checks)         # needs refund

# 3rd wave — the CLI (needs core + all 4 providers + webhook)
(cd apps/cli && pnpm publish --access public --no-git-checks)

# 4th wave — the single-install facade (needs all 13 packages above, including lifecycle/cs)
(cd packages/sdk/ts && pnpm publish --access public --no-git-checks)
```

`packages/core/ts` **must** go first — everything depends on it. `boilpayment-sdk` **must**
go last — it depends on every other TS package published above. Check after each command that
the version you expect actually shows up: `npm view <name> version`.

## 5. Publish — Python (PyPI)

```bash
uv publish --help   # confirm PYPI credentials (UV_PUBLISH_TOKEN or ~/.pypirc) are set first

# 1st wave
for d in packages/core/py packages/credits/py packages/refund/py packages/usage/py \
         packages/webhook/py packages/notify/py \
         packages/providers/stripe/py packages/providers/toss/py \
         packages/providers/portone/py packages/providers/polar/py; do
  uv build "$d" --out-dir /tmp/paykit-release-dist
done
uv build packages/schema-postgres/py --out-dir /tmp/paykit-release-dist --wheel   # see §3 defect

uv publish /tmp/paykit-release-dist/*core*
uv publish /tmp/paykit-release-dist/*credits* /tmp/paykit-release-dist/*refund* \
           /tmp/paykit-release-dist/*usage* /tmp/paykit-release-dist/*webhook* \
           /tmp/paykit-release-dist/*notify* /tmp/paykit-release-dist/*schema_postgres* \
           /tmp/paykit-release-dist/*stripe* /tmp/paykit-release-dist/*toss* \
           /tmp/paykit-release-dist/*portone* /tmp/paykit-release-dist/*polar*

# 2nd wave
uv build packages/lifecycle/py --out-dir /tmp/paykit-release-dist   # needs credits
uv build packages/cs/py --out-dir /tmp/paykit-release-dist          # needs refund
uv publish /tmp/paykit-release-dist/*lifecycle* /tmp/paykit-release-dist/*_cs-*

# 3rd wave — the single-install facade (needs all 13 packages above, including lifecycle/cs).
# Its pyproject.toml pins every one with `==<version>` already (see step 1) — no pin/unpin dance
# needed for this one, unlike step 2's INTERNAL script for the other 13.
uv build packages/sdk/py --out-dir /tmp/paykit-release-dist
uv publish /tmp/paykit-release-dist/boilpayment-*
```

Check after: `pip index versions boilpayment-core` (or the project page on pypi.org). Also
`pip index versions boilpayment` for the facade.

## 6. Tag

After both registries confirm the new versions are live, create an annotated tag `v0.2.0` on the
release commit and push just that tag to the remote (`git push origin <tag>`).

## 7. Rollback

**Neither registry supports true un-publish once other people may have installed a version** —
npm blocks un-publish after 72 hours (and even inside that window it's discouraged, it breaks
anyone who already installed it) and PyPI has no un-publish at all.

- **npm** — `npm deprecate <pkg>@<version> "<reason>"` marks it deprecated (shows a warning on
  install, doesn't remove it). To pull a genuinely broken version within 72h of publish:
  `npm unpublish <pkg>@<version>` (only works repo-wide if the *entire* package is unpublished
  within 72h, otherwise this fails and deprecate is the only option).
- **PyPI** — `uv publish` has no yank command; use the web UI (pypi.org → project → your version
  → "Yank release") — it's a web-only action. Yanking hides the version from
  `pip install <pkg>` (unversioned) but it stays installable by anyone who pins the exact
  version, and the file itself isn't deleted.
- In both cases, the fix is a **new version** with the bug fixed, not overwriting the old one
  (neither registry allows re-publishing the same version number with different content).

## schema-postgres 의 SQL 번들 (2026-09-09 해소)

`uv build` 가 sdist 를 만든 뒤 그 sdist 에서 wheel 을 굽기 때문에, 패키지 루트 위를 가리키던
`force-include "../sql"` 는 표준 빌드에서 항상 실패했다(`FileNotFoundError`). 지금은
`packages/schema-postgres/sql` 을 원본으로 두고 `scripts/sync-sql.mjs` 가 파이썬 패키지 안으로
복사하며, 그 복사본은 커밋되고 `py/tests/test_sql_sync.py` 가 매 테스트마다 바이트 단위로 대조한다
(복사본은 조용히 낡기 때문). 동기화는 `pnpm -r build` 의 prebuild 에 걸려 있다.
**wheel-only 릴리스로 우회할 필요 없다 — sdist·wheel 둘 다 정상이다.**

## 저장소 URL

매니페스트의 `homepage`/`repository`/`bugs` (py: `[project.urls]`) 는 전부
`https://github.com/schift-io/boilpayment` 을 가리킨다. 공개 패키지 15개 + pyproject 15개.
저장소 주소를 바꾸면 발행 전에 아래로 한 번에 교체하고 `npm pack --dry-run` 으로 packed manifest 를 확인한다.

```bash
REAL_URL="https://github.com/<org>/<repo>"
git ls-files '*/package.json' '*/pyproject.toml' README.md \
  | xargs sed -i '' "s#https://github.com/schift-io/boilpayment#$REAL_URL#g"
```
