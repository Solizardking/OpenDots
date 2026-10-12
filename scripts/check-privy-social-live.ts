/** Check real Privy/provider OAuth handoffs without using anyone's social account. */
import { strict as assert } from 'node:assert';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const origin = 'https://chatgptee.ai';
const preflight = !!process.env.HYBRID_CANDIDATE_BROWSER;
const directory = preflight
  ? 'artifacts/hybrid-auth/social-preflight'
  : 'artifacts/hybrid-auth/social-live';
mkdirSync(directory, { recursive: true });
const candidate = JSON.parse(
  readFileSync('artifacts/hybrid-auth/social-release-candidate.json', 'utf8'),
);
const served = JSON.parse(
  execFileSync(
    'curl',
    [
      '--fail',
      '-sS',
      origin + '/hybrid-auth-release.json?v=' + candidate.release.releaseId,
    ],
    { encoding: 'utf8' },
  ),
);
if (!preflight) assert.equal(served.sourceHash, candidate.release.sourceHash);
const config = JSON.parse(
  execFileSync('curl', ['--fail', '-sS', origin + '/api/auth/config'], {
    encoding: 'utf8',
  }),
);
if (!preflight)
  assert.deepEqual(config.privySocialProviders, [
    'google',
    'twitter',
    'github',
  ]);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const results: unknown[] = [];
try {
  for (const [provider, label, hosts] of [
    ['google', 'Google', ['accounts.google.com']],
    ['twitter', 'X', ['x.com', 'twitter.com']],
    ['github', 'GitHub', ['github.com']],
  ] as const) {
    if (
      process.env.PRIVY_CHECK_PROVIDER &&
      process.env.PRIVY_CHECK_PROVIDER !== provider
    )
      continue;
    const context = await browser.newContext();
    const page = await context.newPage();
    if (preflight) {
      const dist = join(candidate.stage, 'dist/client');
      await page.route(origin + '/', (route) =>
        route.fulfill({
          path: join(dist, 'index.html'),
          contentType: 'text/html',
        }),
      );
      await page.route(origin + '/assets/**', (route) => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({
          path: join(dist, path),
          contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      });
      await page.route(origin + '/api/auth/config', (route) =>
        route.fulfill({
          json: {
            ...config,
            privySocialProviders: ['google', 'twitter', 'github'],
          },
        }),
      );
    }
    const errors: string[] = [];
    let authorization: URL | undefined;
    let initStatus: number | undefined;
    let providerFailure: string | undefined;
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (
        !authorization &&
        request.isNavigationRequest() &&
        hosts.some((host) => url.hostname === host) &&
        url.searchParams.get('client_id') &&
        url.searchParams.get('redirect_uri')
      )
        authorization = url;
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', async (response) => {
      if (!response.url().includes('/oauth/init')) return;
      initStatus = response.status();
      try {
        const body = await response.json();
        const url = body.url || body.authorization_url || body.authorizationUrl;
        if (typeof url === 'string') authorization = new URL(url);
        if (!authorization)
          console.log(
            JSON.stringify({ provider, initFields: Object.keys(body) }),
          );
        if (response.status() >= 400 && typeof body.code === 'string')
          providerFailure = body.code;
      } catch {
        /* Navigated or non-JSON response. */
      }
    });
    await page.goto(origin);
    await page
      .getByRole('button', { name: 'Continue with ' + label, exact: true })
      .waitFor();
    await page.waitForFunction(
      (label) =>
        [...document.querySelectorAll('button')].some(
          (button) =>
            button.textContent?.trim() === 'Continue with ' + label &&
            !button.disabled,
        ),
      label,
    );
    await page
      .getByRole('button', { name: 'Continue with ' + label, exact: true })
      .click();
    let navigated = false;
    try {
      await page.waitForURL(
        (url) => hosts.some((host) => url.hostname === host),
        { waitUntil: 'domcontentloaded', timeout: 20000 },
      );
      navigated = true;
    } catch {
      /* Record handoff failures without secrets or OAuth state. */
    }
    if (authorization) {
      assert.equal(authorization.protocol, 'https:');
      assert(hosts.some((host) => authorization!.hostname === host));
      assert(authorization.searchParams.get('client_id'));
      assert(authorization.searchParams.get('state'));
    }
    const callback = authorization?.searchParams.get('redirect_uri');
    const providerText = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    const providerError = providerText.match(
      /(?:Error\s+(?:400|401):\s*(?:redirect_uri_mismatch|invalid_client)|HTTP ERROR 403)/i,
    )?.[0];
    const result = {
      provider,
      enabled: true,
      initStatus,
      authorizationHost: authorization?.hostname,
      callbackHost: callback ? new URL(callback).hostname : undefined,
      callbackURL: callback,
      clientConfigured: !!authorization?.searchParams.get('client_id'),
      providerPageReached: navigated,
      providerFailure,
      providerError,
      callbackVerified: false,
      pageErrors: errors,
    };
    results.push(result);
    await page
      .screenshot({
        path: directory + '/' + provider + '-handoff.png',
        animations: 'disabled',
      })
      .catch(() => {});
    console.log(JSON.stringify(result));
    await context.close();
  }
  const report = {
    checkedAt: new Date().toISOString(),
    sourceHash: preflight ? candidate.release.sourceHash : served.sourceHash,
    scope:
      (preflight
        ? 'Candidate client bundles over the normal chatgptee.ai origin, with candidate public config. '
        : 'Deployed normal chatgptee.ai browser route. ') +
      'Real Privy OAuth initiation. No social account sign-in performed; callbacks remain unverified.',
    results,
  };
  writeFileSync(
    directory + '/oauth-handoffs.json',
    JSON.stringify(report, null, 2) + '\n',
  );
} finally {
  await browser.close();
}
