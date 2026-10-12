import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Frozen build receipt contains no credentials and is read from the deployed client bundle. */
export function releaseInfo(
  root = process.cwd(),
): { releaseId: string; sourceHash: string } | undefined {
  try {
    const receipt = JSON.parse(
      readFileSync(join(root, 'dist/client/opendots-release.json'), 'utf8'),
    ) as Record<string, unknown>;
    if (
      typeof receipt.releaseId !== 'string' ||
      !/^opendots-[a-zA-Z0-9_-]+$/.test(receipt.releaseId) ||
      typeof receipt.sourceHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt.sourceHash)
    )
      return undefined;
    return { releaseId: receipt.releaseId, sourceHash: receipt.sourceHash };
  } catch {
    return undefined;
  }
}
