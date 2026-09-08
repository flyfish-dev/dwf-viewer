import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const [name, status, token, success] of [
  ['both packages authorized', 201, true, true],
  ['binding denied', 404, false, false],
  ['invalid success without credential', 201, false, false]
]) test(name + ' without publishing or leaking credentials', () => {
  const program = `
    let requests = 0;
    globalThis.fetch = async (url, options) => {
      requests += 1;
      if (requests === 1) {
        if (new URL(url).searchParams.get('audience') !== 'npm:registry.npmjs.org') throw Error('Wrong audience');
        return {ok:true,json:async()=>({value:'PRIVATE_IDENTITY_SENTINEL'})};
      }
      if (!String(url).startsWith('https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/')) throw Error('Unexpected endpoint');
      if (options.method !== 'POST' || options.headers.Authorization !== 'Bearer PRIVATE_IDENTITY_SENTINEL') throw Error('Invalid exchange');
      return {ok:${status === 201},status:${status},json:async()=>(${token ? "{token:'PRIVATE_REGISTRY_SENTINEL'}" : '{}'})};
    };
    await import(${JSON.stringify(new URL('./check-npm-authorization.mjs', import.meta.url).href)});
    if (requests !== 3) throw Error('Expected both package authorizations');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8', timeout: 10000,
    env: {
      GITHUB_ACTIONS: 'true',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://identity.example.test/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'PRIVATE_REQUEST_SENTINEL'
    }
  });
  assert.equal(result.status === 0, success, result.stderr);
  assert(!`${result.stdout}${result.stderr}`.includes('_SENTINEL'));
  const rows = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert(rows.every(row => row.authorized === success && row.status === status));
});
