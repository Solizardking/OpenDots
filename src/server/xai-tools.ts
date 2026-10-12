import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { PlatformConfig } from './platform-config.js';
import { DEFAULT_XAI_MODEL } from './model-config.js';
export function xaiSearchTools(
  config: PlatformConfig,
  check: () => void,
  signal: AbortSignal,
) {
  if (!config.xaiApiKey) return [];
  return [
    defineTool({
      name: 'search_x',
      description:
        'Search public X posts with xAI, returning an evidence-based answer and source URLs. Use for explicit research about X posts or users. This is read-only and never posts or sends messages.',
      parameters: z
        .object({ query: z.string().trim().min(3).max(2000) })
        .strict(),
      execute: async ({ query }) => {
        check();
        const response = await fetch('https://api.x.ai/v1/responses', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.xaiApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model:
              config.modelProvider === 'xai' ? config.model : DEFAULT_XAI_MODEL,
            input: [{ role: 'user', content: query }],
            tools: [{ type: 'x_search' }],
            store: false,
            max_output_tokens: 1600,
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        });
        if (!response.ok)
          throw new Error(
            `X search failed with provider status ${response.status}. Check the xAI account and credits.`,
          );
        const data = (await response.json()) as {
          output?: {
            type: string;
            content?: {
              text?: string;
              annotations?: { url?: string; title?: string }[];
            }[];
          }[];
        };
        check();
        const content = (data.output ?? [])
          .filter((item) => item.type === 'message')
          .flatMap((item) => item.content ?? []);
        return {
          text: content.map((item) => item.text ?? '').join('\n'),
          sources: content
            .flatMap((item) => item.annotations ?? [])
            .filter((item) => item.url)
            .map((item) => ({
              url: item.url,
              title: item.title ?? 'X source',
            })),
        };
      },
    }),
  ];
}
