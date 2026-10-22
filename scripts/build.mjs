import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });

const tsc = spawnSync('npx', ['tsc', '-p', 'tsconfig.build.json'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

// EJS templates, static assets and SQL migrations are not TypeScript, so they
// are copied alongside the compiled output:
//   dist/web/app.js  resolves ./views and ./public
//   dist/db/migrate.js resolves ./sql
mkdirSync('dist/web', { recursive: true });
cpSync('src/web/views', 'dist/web/views', { recursive: true });
cpSync('src/web/public', 'dist/web/public', { recursive: true });
mkdirSync('dist/db', { recursive: true });
cpSync('src/db/sql', 'dist/db/sql', { recursive: true });
console.log('[build] compiled to dist/ and copied views + public assets + SQL migrations');
