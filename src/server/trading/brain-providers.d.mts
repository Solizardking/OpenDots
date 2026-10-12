export class BrainProviders {
  constructor(options?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch });
  decide(state: unknown): Promise<unknown>;
  command(state: unknown): Promise<unknown>;
  recall(scope: string, query: string): Promise<unknown>;
  remember(scope: string, record: unknown): Promise<unknown>;
  memory_status(scope: string, id: string): Promise<string>;
}
export function namespace_for(scope: string): string;
export function validate_answers(...args: unknown[]): unknown;

export function brain_error(
  message: string,
  status?: number,
): Error & { status: number };
