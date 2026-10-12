import type { RunAgentInput } from '@ag-ui/core';
// Browser-supplied metadata can only restrict privileges. It never enables tools.
// The private messaging coordinator supplies this marker for every native turn.
export function isSpectrumTurn(input: RunAgentInput) {
  const last = input.messages.findLast((message) => message.role === 'user') as
    { metadata?: Record<string, unknown> } | undefined;
  return last?.metadata?.opendotsSource === 'spectrum_message';
}
