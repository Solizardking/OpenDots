import { mkdir, writeFile } from 'node:fs/promises';
import { BirdeyeService } from '../src/server/birdeye-service.ts';
import { BirdeyeStream } from '../src/server/birdeye-stream.ts';

// One server-owned subscription, at most 12 seconds. Neither the provider URL
// nor raw frames/errors are logged. No wallet activity or trading is requested.
const service = new BirdeyeService({ env: process.env });
if (!service.status().configured) {
  console.log(
    JSON.stringify({
      verification: 'live-websocket',
      verified: false,
      state: 'missing-configuration',
    }),
  );
  process.exitCode = 2;
} else {
  const stream = new BirdeyeStream({ env: process.env, service });
  const observations = [];
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });
  let receivedPrice = false;
  const timeout = setTimeout(() => finish('timeout'), 12000);
  const unsubscribe = stream.subscribe(
    {
      threadId: 'live-verification',
      prices: ['So11111111111111111111111111111111111111112'],
    },
    (event) => {
      observations.push({
        kind: event.kind,
        state: event.state,
        observedAt: event.observedAt,
      });
      if (event.kind === 'price') {
        receivedPrice = true;
        finish('received-price');
      } else if (event.state === 'unavailable') finish('unavailable');
    },
  );
  try {
    const stoppedReason = await completed;
    const report = {
      verification: 'live-websocket',
      verified: receivedPrice,
      receivedPrice,
      stoppedReason,
      observations: observations.slice(0, 30),
      credentialRecorded: false,
    };
    await mkdir('artifacts/birdeye-fixtures', { recursive: true });
    await writeFile(
      'artifacts/birdeye-fixtures/live-stream.json',
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(JSON.stringify(report, null, 2));
    if (!receivedPrice) process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    unsubscribe();
    await stream.stop();
  }
}
