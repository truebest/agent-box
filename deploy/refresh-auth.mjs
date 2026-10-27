import fs from 'node:fs';
import { openaiCodexOAuth } from '/opt/agents/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js';

const path = '/auth/codex-auth.json';
try {
  const auth = JSON.parse(fs.readFileSync(path, 'utf8'));
  const claims = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url'));
  if (process.argv.includes('--force') || claims.exp * 1000 < Date.now() + 3600000) {
    const credential = await openaiCodexOAuth.refresh({ type: 'oauth', refresh: auth.tokens.refresh_token }, AbortSignal.timeout(30000));
    if (!credential.access || !credential.refresh) throw Error('Incomplete refresh');
    auth.tokens.access_token = credential.access;
    auth.tokens.refresh_token = credential.refresh;
    if (credential.accountId) auth.tokens.account_id = credential.accountId;
    auth.last_refresh = new Date().toISOString();
    fs.writeFileSync(path + '.new', JSON.stringify(auth), { mode: 0o600 });
    fs.renameSync(path + '.new', path);
    console.log('Central OAuth refreshed');
  }
} catch {
  console.error('Central OAuth refresh failed; credential details withheld');
  process.exitCode = 1;
}
