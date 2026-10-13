import { BirdeyeService } from '../src/server/birdeye-service.ts';
import { mkdir, writeFile } from 'node:fs/promises';

// Run with: node --env-file-if-exists=.env --import tsx scripts/verify-birdeye-provider.mjs
// This uses one batched-price request. It never prints a credential or a raw
// upstream error, and stops on quota/authentication/entitlement failures.
const service = new BirdeyeService({ env: process.env });
if (!service.status().configured) {
  console.log(
    JSON.stringify(
      {
        verification: 'live',
        source: 'Birdeye',
        state: 'missing-configuration',
        verified: false,
        message:
          'Set BIRDEYE_API_KEY on the server, then run this check again.',
      },
      null,
      2,
    ),
  );
  process.exitCode = 2;
} else {
  try {
    const result = await service.read({
      workflow: 'watchlist',
      addresses: ['So11111111111111111111111111111111111111112'],
    });
    const quote = result.data.items?.[0];
    const verified =
      typeof quote?.priceUsd === 'number' &&
      Number.isFinite(quote.priceUsd) &&
      quote.priceUsd > 0 &&
      quote.stale === false;
    const report = { verification: 'live', verified, ...result };
    await mkdir('artifacts/birdeye-fixtures', { recursive: true });
    await writeFile(
      'artifacts/birdeye-fixtures/live-price.json',
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(JSON.stringify(report, null, 2));
    if (!verified) process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          verification: 'live',
          verified: false,
          ...service.status(),
          error:
            error instanceof Error ? error.message : 'Birdeye is unavailable.',
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
