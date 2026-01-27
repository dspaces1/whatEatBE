import OpenAI from 'openai';

export type OpenAIErrorDetails = {
  status?: number;
  code?: string | null;
  type?: string;
  param?: string | null;
  requestId?: string | null;
  message?: string;
  error?: unknown;
};

export const getOpenAIErrorDetails = (error: unknown): OpenAIErrorDetails | null => {
  if (error instanceof OpenAI.APIError) {
    return {
      status: error.status,
      code: error.code ?? undefined,
      type: error.type,
      param: error.param ?? undefined,
      requestId: error.requestID ?? undefined,
      message: error.message,
      error: error.error ?? undefined,
    };
  }

  return null;
};
