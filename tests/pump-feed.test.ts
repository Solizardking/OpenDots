import { expect, it } from 'vitest';
import {
  filteredLaunches,
  receiveLaunch,
  type PumpLaunchItem,
} from '../src/shared/pump-feed';
const frame = {
  type: 'token-launch',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  name: 'Example launch',
  symbol: 'EX',
  marketCapSol: 10,
  hasGithub: true,
};
it('rejects invalid provider data without replacing previous launches', () => {
  const items = receiveLaunch([], frame, 1);
  expect(receiveLaunch(items, { ...frame, marketCapSol: -1 })).toBe(items);
  expect(receiveLaunch(items, { ...frame, mint: 'javascript:alert(1)' })).toBe(
    items,
  );
});
it('keeps only the latest occurrence of a mint and bounds the session buffer', () => {
  const previous = Array.from({ length: 120 }, (_, i) => ({
    ...frame,
    mint: String(i),
    receivedAt: i,
  })) as PumpLaunchItem[];
  const items = receiveLaunch(previous, frame, 200);
  expect(items).toHaveLength(120);
  expect(
    receiveLaunch(items, { ...frame, marketCapSol: 12 }, 201)[0],
  ).toMatchObject({ marketCapSol: 12, receivedAt: 201 });
  expect(
    receiveLaunch(items, frame).filter((item) => item.mint === frame.mint),
  ).toHaveLength(1);
});
it('searches name, symbol and mint while preserving GitHub-only filters', () => {
  const items = receiveLaunch([], frame);
  expect(filteredLaunches(items, 'EXAMPLE', true)).toHaveLength(1);
  expect(filteredLaunches(items, 'EPjFW', false)).toHaveLength(1);
  expect(
    filteredLaunches(
      items.map((item) => ({ ...item, hasGithub: false })),
      'EX',
      true,
    ),
  ).toHaveLength(0);
});
