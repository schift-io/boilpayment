# Release procedure

npm publishes exactly two packages:

- `boilpayment-sdk` — the self-contained TypeScript SDK.
- `boilpayment` — the CLI, which depends on the SDK at the same version.

The 13 TypeScript module packages are private workspace packages. Do not publish them.

## 0.3.0 release notes

- npm ships two packages, `boilpayment` and `boilpayment-sdk`. The 13 module packages published at
  0.2.0 (`boilpayment-core`, ...) are not updated; deprecate them after 0.3.0 is live:
  `npm deprecate boilpayment-core@"*" "bundled into boilpayment-sdk since 0.3.0"` (one per package).
- A paid one-time top-up for a banned customer grants no credits and opens one refund review (EC:A85).
- `@types/pg` ships with the SDK, so `skipLibCheck: false` projects compile without extra installs.
- Subscription and one-time fixes from `docs/cases.tsv` (OT-03, OT-17, SB-03, SB-06, SB-07, SB-10, SB-11,
  SB-13, SB-14); each row's `evidence` column names the run that measured it.
- Stripe and Polar discount, payment-link, registration-hold and affiliate behavior adds 14 cases:
  OT-09, DC-01 through DC-06, PL-01 through PL-03 and AF-01 through AF-04.
- Migration `0015_grace_credit_expiry.sql` adds two SQL functions (no table or column change), and
  `0016_affiliate_commissions.sql` adds append-only affiliate commission accounting. After upgrading
  from 0.2.0, run `npx boilpayment migrate` to apply both. There is no upgrade path from 0.1.0.

## 1. Pre-flight

Run each gate from the repository root and stop on failure:

```bash
pnpm run build
.venv/bin/ruff check packages
pnpm run test
bash scripts/ci-pytest.sh
pnpm run ec-coverage
pnpm run parity
pnpm run test:step1
bash scripts/live.sh
```

Confirm `apps/cli/package.json` and `packages/sdk/ts/package.json` have the intended identical
version. Both bundle scripts use `git archive HEAD` and ignore working-tree changes, so run them
only when the intended release contents are already committed at `HEAD`.

## 2. Build npm tarballs

Use an output directory with no existing `.tgz` files:

```bash
bash scripts/pack-npm.sh /tmp/boilpayment-npm
```

For version 0.3.0 the directory must contain only:

- `boilpayment-sdk-0.3.0.tgz`
- `boilpayment-0.3.0.tgz`

The script installs and builds the archived workspace, checks that the SDK has no bare internal
package specifiers, verifies the packed dependency metadata, and fails unless the tarball count is
two.

## 3. Publish npm packages

Publish the SDK first, then the CLI:

```bash
npm publish /tmp/boilpayment-npm/boilpayment-sdk-0.3.0.tgz --access public
npm publish /tmp/boilpayment-npm/boilpayment-0.3.0.tgz --access public
npm view boilpayment-sdk version
npm view boilpayment version
```

## 4. Build and publish PyPI

PyPI continues to receive one `boilpayment` distribution:

```bash
bash scripts/build-pypi-bundle.sh /tmp/boilpayment-pypi
uvx twine check /tmp/boilpayment-pypi/*
uvx twine upload /tmp/boilpayment-pypi/*
pip index versions boilpayment
```

## 5. Tag

After both registries show the intended version, create and push the release tag from the release
commit. Do not reuse a version after either registry accepts it.
