export type NativeQueryLanguage = 'jql' | 'wiql' | 'encoded';
export type NativeQueryStatus = 'draft' | 'published' | 'disabled';

/** One actionable finding: what is wrong and the concrete edit that would fix it. */
export interface NativeQueryIssue {
  code:
    | 'empty_query'
    | 'query_too_long'
    | 'syntax'
    | 'order_by_not_allowed'
    | 'watermark_conflict'
    | 'unbounded_scan'
    | 'no_runner';
  message: string;
  hint: string;
}

export interface NativeQueryValidation {
  valid: boolean;
  language: NativeQueryLanguage;
  errors: NativeQueryIssue[];
  warnings: NativeQueryIssue[];
}

export interface NativeQueryDefinition {
  id: string;
  org_id: string;
  connector_id: string;
  name: string;
  language: NativeQueryLanguage;
  entity_type: string;
  query: string;
  interval_seconds: number;
  status: NativeQueryStatus;
  /** Where the first run starts (null = at publication); the query never scans older history. */
  start_from: string | null;
  /** Changes at or before this instant have been enqueued. Null until published. */
  watermark: string | null;
  validation: NativeQueryValidation;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: 'succeeded' | 'failed' | null;
  last_error: string | null;
  last_enqueued: number;
  total_enqueued: number;
  consecutive_failures: number;
  created_by: string;
  created_at: string;
  published_by: string | null;
  published_at: string | null;
}

export interface CreateNativeQueryDto {
  name: string;
  connector_id: string;
  entity_type: string;
  query: string;
  interval_seconds?: number;
  /** ISO timestamp the first run starts from. Defaults to the moment of publication. */
  start_from?: string;
}

export type UpdateNativeQueryDto = Partial<Omit<CreateNativeQueryDto, 'connector_id'>>;

export interface NativeQueryRunResult {
  query_id: string;
  status: 'succeeded' | 'failed' | 'skipped';
  fetched: number;
  enqueued: number;
  watermark: string | null;
  has_more: boolean;
  message?: string;
}

export class InvalidNativeQueryError extends Error {
  constructor(message: string, public readonly validation?: NativeQueryValidation) {
    super(message);
  }
}
export class NativeQueryNotFoundError extends Error {}
export class NativeQueryConflictError extends Error {}
