import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { cloudTask, type BrowserUseService } from './browser-use-service.js';

export function browserUseTools(
  service: BrowserUseService,
  dotId: string,
  check: () => void,
  signal: AbortSignal,
) {
  if (!service.configured) return [];
  return [
    defineTool({
      name: 'browser_use_task',
      description:
        'Carry out an explicitly requested cloud browser task with gpt-6-luna and return provider evidence. Browser Use permission must be enabled by the owner. Set followup=true to continue the last session. Never send messages, make purchases, sign transactions, or transfer funds without explicit user authorization. This tool stops its cloud browser after completion and cancels unfinished work on interruption.',
      parameters: cloudTask,
      execute: async (input) => {
        check();
        const state = await service.createRun(dotId, input);
        const result = await service.waitForRun(dotId, state.run!.id, signal);
        check();
        return result;
      },
    }),
    defineTool({
      name: 'browser_use_status',
      description:
        'Inspect this Dot’s Browser Use session and task status without creating a browser or run.',
      parameters: z.object({}).strict(),
      execute: () => {
        check();
        return service.status(dotId);
      },
    }),
  ];
}
