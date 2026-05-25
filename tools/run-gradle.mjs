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
import { chmodSync, existsSync, statSync } from 'node:fs';
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

// Repo authored on Windows -> the POSIX gradlew loses its +x bit when
// committed (Windows FS has no executable flag). Force it back here so
// the spawn doesn't silently EACCES.
if (platform !== 'win32') {
  const mode = statSync(wrapperPath).mode;
  if (!(mode & 0o111)) {
    chmodSync(wrapperPath, mode | 0o755);
    console.log(`[run-gradle] chmod +x ${wrapperPath}`);
  }
}

const args = argv.slice(2);
console.log(`[run-gradle] $ ${wrapperName} ${args.join(' ')}`);
const result = spawnSync(wrapperName, args, {
  stdio: 'inherit',
  cwd: cwd(),
  // shell:true on Windows so `gradlew.bat` resolves through cmd; on POSIX
  // the explicit `./gradlew` works without a shell wrapper.
  shell: platform === 'win32',
});
if (result.error) {
  console.error(`[run-gradle] spawn error: ${result.error.message}`);
}
exit(result.status ?? 1);
