export type OpenRouterBatchStatus =
  | 'submitting'
  | 'submission_unknown'
  | 'validating'
  | 'in_progress'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelling'
  | 'cancelled'
  | 'deleted';

export interface OpenRouterBatchResult {
  customId: string;
  prompt: string;
  text: string | null;
  error: string | null;
  statusCode: number | null;
}

export interface OpenRouterBatchJob {
  /** Workspace-local id; upstream ids and credentials remain server-side. */
  id: string;
  requestId: string;
  model: string;
  baseModel: string;
  endpoint: '/v1/chat/completions';
  completionWindow: '24h';
  status: OpenRouterBatchStatus;
  createdAt: number;
  updatedAt: number;
  requestCounts: { total: number; completed: number; failed: number };
  prompts: { customId: string; prompt: string }[];
  maxTokens: number;
  results: OpenRouterBatchResult[] | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number | null;
  } | null;
  error: string | null;
  /** A retrieval failure does not resubmit or discard an accepted batch. */
  pollError: string | null;
}

export interface OpenRouterBatchState {
  configured: boolean;
  configuredModel: string;
  jobs: OpenRouterBatchJob[];
}
