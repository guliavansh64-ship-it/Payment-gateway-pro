import request from 'supertest';
import { createApp } from '../src/web/app';
import { query } from '../src/db/pool';

const app = createApp();
const agent = request.agent(app);

async function walk(agent: request.SuperAgentTest, paths: string[]) {
  for (const p of paths) {
    const res = await agent.get(p);
    const body = res.text ?? '';
    const hint = /<p class="hint">([^<]*)</.exec(body)?.[1] ?? '';
    console.log(res.status, p, res.status >= 400 ? hint.slice(0, 120) : '');
  }
}

async function main() {
const users = await query<{email:string;password_hash:string}>('select email, password_hash from users');
console.log(users.rows);

for (const email of ['merchant@upiverify.test','admin@upiverify.test']) {
  const a = request.agent(app);
  const page = await a.get('/login');
  const csrf = /name="_csrf" value="([^"]*)"/.exec(page.text)?.[1] ?? '';
  const res = await a.post('/login').type('form').send({ _csrf: csrf, email, password: 'ChangeMeNow!2026', next: '/dashboard' });
  console.log('login', email, res.status, res.headers.location);
  if (res.status === 302) {
    await walk(a, email.startsWith('admin')
      ? ['/dashboard','/dashboard/orders','/dashboard/transactions','/dashboard/review','/dashboard/gmail','/dashboard/providers','/dashboard/reconciliation','/dashboard/audit','/admin','/admin/providers','/admin/merchants','/admin/users','/admin/security']
      : ['/dashboard','/dashboard/orders','/dashboard/transactions','/dashboard/review','/dashboard/gmail','/dashboard/providers','/dashboard/reconciliation','/dashboard/audit']);
  }
}
// public
const pub = request.agent(app);
for (const p of ['/', '/login', '/pay-return', '/does-not-exist', '/pay/PAY-20261022-AAAAAAAA?t=nope']) {
  const r = await pub.get(p);
  console.log('public', r.status, p);
}
process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
