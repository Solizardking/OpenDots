import { z } from 'zod';

export const launchSchema = z.object({
  type: z.literal('token-launch'),
  mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  name: z.string().max(256),
  symbol: z.string().max(64),
  description: z.string().max(4000).optional(),
  marketCapSol: z.number().finite().nonnegative().nullable().optional(),
  hasGithub: z.boolean().optional(),
});
export type PumpLaunchItem = z.infer<typeof launchSchema> & {
  receivedAt: number;
};
export function receiveLaunch(
  previous: PumpLaunchItem[],
  frame: unknown,
  now = Date.now(),
) {
  const parsed = launchSchema.safeParse(frame);
  if (!parsed.success) return previous;
  return [
    { ...parsed.data, receivedAt: now },
    ...previous.filter((item) => item.mint !== parsed.data.mint),
  ].slice(0, 120);
}

export function filteredLaunches(
  items: PumpLaunchItem[],
  query: string,
  github: boolean,
) {
  const search = query.trim().toLowerCase();
  return items.filter(
    (item) =>
      (!github || item.hasGithub === true) &&
      (!search ||
        [item.name, item.symbol, item.mint].some((value) =>
          value.toLowerCase().includes(search),
        )),
  );
}
