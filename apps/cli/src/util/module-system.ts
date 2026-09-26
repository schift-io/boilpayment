// The kit is ESM-only: every package sets "type": "module" and its `exports` has no `require`
// condition. A CommonJS host project therefore fails at `require('boilpayment-sdk/core')`
// with ERR_PACKAGE_PATH_NOT_EXPORTED — a message that reads like the package is broken ("subpath
// './core' is not defined by exports") when the subpath IS defined, just not for require. Detect it
// where the user is standing and say the real cause.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type ModuleSystem = 'esm' | 'cjs' | 'none';

/** Reads the host project's package.json. 'none' means there isn't one (or it is unreadable). */
export async function detectModuleSystem(dir: string): Promise<ModuleSystem> {
  try {
    const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { type?: string };
    return pkg.type === 'module' ? 'esm' : 'cjs';
  } catch {
    return 'none';
  }
}

export const ESM_REQUIRED_MESSAGE =
  '이 킷은 ESM 전용입니다. 호스트 프로젝트 package.json 에 "type": "module" 이 필요합니다. ' +
  'CommonJS 인 채로 require() 하면 ERR_PACKAGE_PATH_NOT_EXPORTED 가 납니다 (패키지가 깨진 게 아니라 ' +
  'require 조건이 없어서입니다). 프로젝트를 통째로 ESM 으로 옮길 수 없다면 호출부에서 ' +
  '`const kit = await import("./paykit/index.js")` 처럼 동적 import 를 쓰세요.';

export const ESM_MISSING_PACKAGE_JSON_MESSAGE =
  'package.json 이 없습니다. 생성된 코드는 ESM 이므로 `npm init -y` 후 "type": "module" 을 넣으세요.';
