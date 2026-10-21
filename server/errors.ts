export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
