import { defineTool } from '@copilotkit/runtime/v2';
import { dflowQuoteInput } from '../shared/dflow-types.js';
import { DflowError, DflowService } from './dflow-service.js';

export function dflowTools(check: () => void, signal?: AbortSignal) {
  const service = new DflowService();
  if (!service.enabled) return [];
  return [
    defineTool({
      name: 'dflow_quote',
      description:
        'Get a fresh SOL/token DFlow quote with explicit platform fees. The app automatically renders a successful result as an inline quote card; summarize it without claiming the card cannot render. Buy amount uses SOL; sell amount uses token units. Read-only. No wallet, signing or execution. Use the Pump.fun panel to build a separate wallet-approved launch or trade; a quote is never a completed trade.',
      parameters: dflowQuoteInput,
      execute: async (input) => {
        check();
        try {
          const result = await service.quote(input, signal);
          check();
          return result;
        } catch (error) {
          return {
            error:
              error instanceof DflowError
                ? error.message
                : 'DFlow quote failed. Please retry.',
          };
        }
      },
    }),
  ];
}
