.PHONY: check-all build test pytest ruff ec-coverage parity test-verification test-step1 live

# Runs the same sequence as .github/workflows/ci.yml, minus the parts that need CI-only
# infrastructure (pnpm/node/uv/python setup, a fresh `pnpm install` / `uv sync` — run those
# once yourself first) or a live postgres (schema-postgres parity is skipped unless
# schema-postgres is covered by its InMemory-vs-Postgres test, not by parity — see scripts/parity.sh).
check-all: test-verification build ruff test pytest ec-coverage parity test-step1

test-step1:
	pnpm run test:step1

test-verification:
	node --test scripts/verification.test.mjs

build:
	pnpm run build

ruff:
	.venv/bin/ruff check packages

test:
	pnpm run test

pytest:
	bash scripts/ci-pytest.sh

ec-coverage:
	node scripts/ec-coverage.mjs

parity:
	bash scripts/parity.sh

live: ## keys-free live round trips against local provider mocks
	bash scripts/live.sh
