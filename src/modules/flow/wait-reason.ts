/**
 * Wait-reason vocabulary (US21.2). `unattributed` is derived, never chosen: a wait with no recorded reason,
 * blocking link or state default is reported as unattributed rather than guessed.
 */
export const WAIT_REASON_CATEGORIES = ['customer', 'third_party', 'dependency', 'approval', 'capacity', 'other'] as const;
export type WaitReasonCategory = (typeof WAIT_REASON_CATEGORIES)[number];
export type ReasonCategory = WaitReasonCategory | 'unattributed';
export type ReasonSource = 'transition' | 'blocking_link' | 'state_default' | 'none';

export interface WaitReason {
  category: WaitReasonCategory;
  note: string | null;
}

export class InvalidWaitReasonError extends Error {}

export function isWaitReasonCategory(value: unknown): value is WaitReasonCategory {
  return typeof value === 'string' && (WAIT_REASON_CATEGORIES as readonly string[]).includes(value);
}

/** Validates a caller-supplied `{ category, note? }`; null/undefined means no reason was given. */
export function parseWaitReason(input: unknown): WaitReason | null {
  if (input === undefined || input === null) return null;
  const raw = input as { category?: unknown; note?: unknown };
  if (typeof input !== 'object' || !isWaitReasonCategory(raw.category)) {
    throw new InvalidWaitReasonError(`wait_reason.category must be one of: ${WAIT_REASON_CATEGORIES.join(', ')}`);
  }
  if (raw.note !== undefined && raw.note !== null && (typeof raw.note !== 'string' || raw.note.length > 500)) {
    throw new InvalidWaitReasonError('wait_reason.note must be text of at most 500 characters');
  }
  const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : null;
  return { category: raw.category, note };
}
