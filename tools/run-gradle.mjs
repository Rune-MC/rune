#!/usr/bin/env node
// Cross-platform gradlew launcher. `pnpm run` executes scripts via
// `cmd /c` on Windows, where `./gradlew` is not a valid invocation
// (cmd doesn't search the current dir for executables and doesn't
// understand `./`). This thin wrapper picks the right wrapper script
// for the host OS and forwards all args.
//
// Usage from a workspace's package.json:
//   "build": "node ../tools/run-gradle.mjs shadowJar"

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, cwd, exit, platform } from 'node:process';

const wrapperName = platform === 'win32' ? 'gradlew.bat' : './gradlew';
const wrapperPath = platform === 'win32'
  ? resolve(cwd(), 'gradlew.bat')
  : resolve(cwd(), 'gradlew');

if (!existsSync(wrapperPath)) {
  console.error(`[run-gradle] wrapper not found: ${wrapperPath}`);
  exit(1);
}

const args = argv.slice(2);
const result = spawnSync(wrapperName, args, {
  stdio: 'inherit',
  cwd: cwd(),
  // shell:true on Windows so `gradlew.bat` resolves through cmd; on POSIX
  // the explicit `./gradlew` works without a shell wrapper.
  shell: platform === 'win32',
});
exit(result.status ?? 1);
