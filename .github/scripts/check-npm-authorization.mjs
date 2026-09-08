import assert from 'node:assert/strict';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Authorization checks only run in GitHub Actions');
const requestUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
requestUrl.searchParams.set('audience', 'npm:registry.npmjs.org');
const identityResponse = await fetch(requestUrl, {
  headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  signal: AbortSignal.timeout(30000)
});
assert(identityResponse.ok, `GitHub identity request failed (${identityResponse.status})`);
const identity = await identityResponse.json();
assert(typeof identity.value === 'string' && identity.value, 'GitHub returned no identity');

let denied = false;
for (const name of ['dwf-viewer', '@flyfish-dev/dwf-viewer']) {
  const response = await fetch(`https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${identity.value}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000)
  });
  const result = await response.json();
  const authorized = response.ok && typeof result.token === 'string' && result.token.length > 0;
  // Never print the response or either short-lived credential.
  console.log(JSON.stringify({ package: name, authorized, status: response.status }));
  denied ||= !authorized;
}
assert(!denied, 'npm did not authorize every package for this workflow; no package was published');
