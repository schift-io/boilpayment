// Command router: init, check, migrate, live, --help, --version.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { parseArgv } from './util/argv.js';
import { runInit } from './commands/init.js';
import { runCheck } from './commands/check.js';
import { runLive } from './commands/live.js';
import { runMigrate } from './commands/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HELP = `${pc.bold('paykit')} — boilpayment CLI

${pc.bold('Usage')}
  boilpayment init [--yes] [--out <dir>] [--config [file]] [--providers a,b] [--models a,b] [--languages a,b] [--goods a,b] [--cs]
  boilpayment check [--out <dir>]
  boilpayment live [--out <dir>] [--config <file>] [--env <file>] [--dry-run]

  boilpayment migrate            마이그레이션 적용 (--dry-run, --database-url)
  boilpayment --help
  boilpayment --version

${pc.bold('init')}
  결제 provider · 정책 질문에 답하면 paykit.config.json + paykit/ 코드 + migrations + POLICY.md + .env.example 를 생성합니다.
  --yes             모든 질문에 기본값 사용 (TTY 없이도 동작)
  --out <dir>       출력 디렉터리 (기본: 현재 디렉터리)
  --config [file]   기존 설정을 다시 읽어 빠진 질문만 물음 (기본 파일: <out>/paykit.config.json)
  --providers       stripe,polar,toss,portone 중 콤마로 구분해 미리 선택
  --models          subscription,topup,usage 중 콤마로 구분해 미리 선택
  --languages       ts,py 중 콤마로 구분해 미리 선택
  --goods           credits,usage_quota 중 콤마로 구분해 미리 선택
  --cs              CS 사용량 보고를 활성화 (cs.enabled=true). 환불·미지급 처리는 기본 포함

${pc.bold('check')}
  config 검증 + (DATABASE_URL 있으면) DB 연결·스키마 버전 조회. 읽기 전용.
  DB 가 이 빌드보다 뒤처졌거나(미적용 마이그레이션) 앞서 있으면 종료 코드 1 — 배포 게이트로 쓸 수 있습니다.

${pc.bold('live')}
  paykit.config.json + .env 에 채워진 실 provider 테스트/샌드박스 키로 실제 API 왕복을 검증합니다.
  tools/mocks/* 는 CI 회귀용이고, 이것이 실 검증(live verification)입니다 (docs/PUBLIC_SANDBOX_VERIFICATION.md 참고).
  --out <dir>       프로젝트 디렉터리 (기본: 현재 디렉터리). paykit.config.json · .env 를 여기서 찾습니다
  --config <file>   paykit.config.json 경로 직접 지정
  --env <file>      .env 경로 직접 지정 (기본: <out>/.env)
  --dry-run         네트워크 호출 없이 실행될 단계만 출력
  provider 별로 PASS/FAIL/SKIP 를 단계마다 출력하고, FAIL 이 하나라도 있으면 종료 코드 1.
  키가 없는 provider 는 자동으로 SKIP 됩니다. 비밀 값은 출력에 절대 노출하지 않습니다.
`;

async function getVersion(): Promise<string> {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgv(argv);
  const command = parsed.positional[0];

  if (parsed.flags.version || command === '--version' || command === '-v') {
    console.log(await getVersion());
    return;
  }
  if (parsed.flags.help || command === '--help' || command === '-h' || !command) {
    console.log(HELP);
    return;
  }

  const outDir = path.resolve(String(parsed.flags.out ?? process.cwd()));

  switch (command) {
    case 'init':
      await runInit(parsed);
      return;
    case 'check':
      await runCheck(outDir);
      return;
    case 'live':
      await runLive(outDir, parsed);
      return;
    case 'migrate':
      await runMigrate(outDir, {
        dryRun: Boolean(parsed.flags['dry-run']),
        databaseUrl: typeof parsed.flags['database-url'] === 'string' ? parsed.flags['database-url'] : undefined,
      });
      return;
    default:
      console.error(pc.red(`알 수 없는 명령: ${command}`));
      console.log(HELP);
      process.exitCode = 1;
  }
}
