import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { BirdeyeMcpError, type BirdeyeMcpService } from './birdeye-mcp.js';
import { BirdeyeMemeError, type BirdeyeMemeService } from './birdeye-meme.js';

export function birdeyeMcpTools(
  services: { mcp?: BirdeyeMcpService; meme?: BirdeyeMemeService },
  check: () => void,
  signal?: AbortSignal,
) {
  const allowed = () => {
    check();
    signal?.throwIfAborted();
  };
  const read = async (operation: () => Promise<unknown>) => {
    allowed();
    try {
      const result = await operation();
      allowed();
      return result;
    } catch (error) {
      allowed();
      return {
        source: 'Birdeye',
        error:
          error instanceof BirdeyeMcpError || error instanceof BirdeyeMemeError
            ? error.message
            : 'Birdeye is temporarily unavailable.',
        ...(error instanceof BirdeyeMcpError ||
        error instanceof BirdeyeMemeError
          ? { status: error.status, code: error.code }
          : {}),
      };
    }
  };
  const tools = [];
  if (services.mcp) {
    tools.push(
      defineTool({
        name: 'birdeye_mcp_catalog',
        description:
          'Discover the current official Birdeye MCP Beta tool catalog and input schemas; optional search selects relevant tools. Call this before birdeye_mcp_call because names and schemas may change. Only entries with callable=true are enabled for read-only data research. The server authenticates with its own API key. Source outage, plan and quota errors are actual limitations; never invent data or silently switch transports.',
        parameters: z
          .object({ search: z.string().trim().max(100).optional() })
          .strict(),
        execute: ({ search }) =>
          read(() => services.mcp!.catalog(search, signal)),
      }),
      defineTool({
        name: 'birdeye_mcp_call',
        description:
          'Call an exact read-only Birdeye tool discovered with birdeye_mcp_catalog using its current input schema. Arguments contain data filters only; never supply credentials, headers or endpoint URLs. Report source and observation time. result.isError means the provider tool failed. Data signals do not authorize trades, copying wallets, signing or external notifications.',
        parameters: z
          .object({
            name: z.string().min(1).max(128),
            arguments: z.record(z.string(), z.unknown()).default({}),
          })
          .strict(),
        execute: ({ name, arguments: args }) =>
          read(() => services.mcp!.call(name, args, signal)),
      }),
    );
  }
  if (services.meme) {
    tools.push(
      defineTool({
        name: 'birdeye_meme_detail',
        description:
          'Read a single Solana meme token’s current detail through Birdeye Data REST /defi/v3/token/meme/detail/single, using its exact public mint address. Returns provider fields, source and observation time. This is a distinct REST read, including when the MCP Beta session service is unavailable. Unknown or missing values are not zero or proof of safety. No signing or trading.',
        parameters: z
          .object({ address: z.string().trim().min(32).max(44) })
          .strict(),
        execute: ({ address }) =>
          read(() => services.meme!.read(address, signal)),
      }),
    );
  }
  return tools;
}
