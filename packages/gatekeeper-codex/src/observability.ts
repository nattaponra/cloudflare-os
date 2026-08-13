export type CodexLogFields = {
  event: string;
  status?: number;
  retryAfterSeconds?: number;
  accountRecordId?: number;
  modelSlug?: string;
  error?: unknown;
};

export const codexLogger = {
  info(message: string, fields: CodexLogFields): void { console.log(message, fields); },
  warn(message: string, fields: CodexLogFields): void { console.warn(message, fields); },
};
