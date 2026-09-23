import ivm from 'isolated-vm';

/**
 * The constrained scripting escape hatch for US17.2 field mappings.
 *
 * A script is one function body: `function transform(fields, sourceState, targetState, direction) { ... }`.
 * It runs to completion inside a fresh, disposable V8 isolate (`isolated-vm`), never Node's `vm`
 * module — `vm`/`vm2` share the host's heap and event loop and are not a security boundary; a V8
 * isolate is a genuinely separate engine instance with its own heap, so a script cannot see or
 * touch the host process regardless of what it does. The isolate's bare context starts with no
 * globals at all — no `require`, `fetch`, `process`, or ambient `global` — so there is nothing to
 * strip; network and filesystem access are structurally absent, not merely disabled. A new
 * isolate is created per invocation rather than pooled, so no state or timing signal can leak
 * between tenants, connectors, or calls.
 *
 * Two independent limits bound a run: a hard wall-clock timeout aborts the script if it is still
 * executing (an infinite loop is killed, not merely warned about), and a hard heap-memory limit
 * disposes the isolate outright if the script tries to exceed it (a memory hog is killed the same
 * way). Both are enforced by V8 itself inside the isolate, not by watching the script from
 * outside, so neither can be evaded by code that behaves normally until the last moment.
 */

const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_MEMORY_LIMIT_MB = 16;
/** Bounds the returned value's serialized size, independent of whether V8 could clone it at all. */
const MAX_RESULT_BYTES = 64 * 1024;
/** Bounds the input fed in, so a pathologically large source record cannot inflate isolate cost. */
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_SCRIPT_CHARS = 20_000;

export interface MappingScriptInput {
  fields: Record<string, unknown>;
  sourceState: string | null;
  targetState: string | null;
  direction: 'source_to_target' | 'target_to_source';
}

export type MappingScriptOutcome =
  | { ok: true; value: unknown; durationMs: number }
  | { ok: false; reason: MappingScriptFailureReason; message: string; durationMs: number };

export type MappingScriptFailureReason =
  | 'compile_error'
  | 'timeout'
  | 'memory_limit'
  | 'runtime_error'
  | 'unclonable_result'
  | 'oversized_result'
  | 'oversized_input'
  | 'script_too_large';

export interface MappingScriptOptions {
  timeoutMs?: number;
  memoryLimitMb?: number;
}

/**
 * Compiles and runs one transform script against one input. Every failure mode — a syntax error,
 * a timeout, an exhausted memory cap, a thrown exception, an unclonable or oversized return value
 * — is reported as a structured, non-throwing outcome, since a held work order needs a specific,
 * actionable reason rather than a bare stack trace from a foreign engine.
 */
export async function runMappingScript(
  code: string,
  input: MappingScriptInput,
  options: MappingScriptOptions = {},
): Promise<MappingScriptOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memoryLimitMb = options.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
  const startedAt = Date.now();
  const duration = () => Date.now() - startedAt;

  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, reason: 'compile_error', message: 'Script body is empty', durationMs: duration() };
  }
  if (code.length > MAX_SCRIPT_CHARS) {
    return { ok: false, reason: 'script_too_large', message: `Script exceeds ${MAX_SCRIPT_CHARS} characters`, durationMs: duration() };
  }
  const inputBytes = Buffer.byteLength(safeStringify(input.fields), 'utf8');
  if (inputBytes > MAX_INPUT_BYTES) {
    return {
      ok: false,
      reason: 'oversized_input',
      message: `Source fields are ${inputBytes} bytes, exceeding the ${MAX_INPUT_BYTES}-byte limit for scripted transforms`,
      durationMs: duration(),
    };
  }

  let isolate: ivm.Isolate | undefined;
  try {
    isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
    const context = await isolate.createContext();
    // Deep-copied into the isolate; the script never receives a live reference back to host data.
    await context.global.set('__fields', new ivm.ExternalCopy(input.fields).copyInto());
    await context.global.set('__sourceState', input.sourceState);
    await context.global.set('__targetState', input.targetState);
    await context.global.set('__direction', input.direction);

    const wrapped = `(function(fields, sourceState, targetState, direction) {\n${code}\n})(__fields, __sourceState, __targetState, __direction)`;
    let script: ivm.Script;
    try {
      script = await isolate.compileScript(wrapped, { filename: 'field-mapping-transform.js' });
    } catch (error) {
      return { ok: false, reason: 'compile_error', message: describeSandboxError(error), durationMs: duration() };
    }

    let raw: unknown;
    try {
      raw = await script.run(context, { timeout: timeoutMs, copy: true });
    } catch (error) {
      return { ok: false, reason: classifyRuntimeFailure(error, isolate), message: describeSandboxError(error), durationMs: duration() };
    }

    const resultBytes = Buffer.byteLength(safeStringify(raw), 'utf8');
    if (resultBytes > MAX_RESULT_BYTES) {
      return {
        ok: false,
        reason: 'oversized_result',
        message: `The transform returned ${resultBytes} bytes, exceeding the ${MAX_RESULT_BYTES}-byte limit`,
        durationMs: duration(),
      };
    }
    return { ok: true, value: raw, durationMs: duration() };
  } catch (error) {
    // A failure constructing the isolate/context itself (not the script's own fault).
    return { ok: false, reason: 'runtime_error', message: describeSandboxError(error), durationMs: duration() };
  } finally {
    if (isolate && !isolate.isDisposed) isolate.dispose();
  }
}

/** Static syntax/reference check without executing anything, for validating a mapping before publish. */
export async function checkMappingScriptSyntax(code: string): Promise<{ valid: true } | { valid: false; message: string }> {
  if (typeof code !== 'string' || !code.trim()) return { valid: false, message: 'Script body is empty' };
  if (code.length > MAX_SCRIPT_CHARS) return { valid: false, message: `Script exceeds ${MAX_SCRIPT_CHARS} characters` };
  let isolate: ivm.Isolate | undefined;
  try {
    isolate = new ivm.Isolate({ memoryLimit: 8 });
    const wrapped = `(function(fields, sourceState, targetState, direction) {\n${code}\n})`;
    await isolate.compileScript(wrapped, { filename: 'field-mapping-transform.js' });
    return { valid: true };
  } catch (error) {
    return { valid: false, message: describeSandboxError(error) };
  } finally {
    if (isolate && !isolate.isDisposed) isolate.dispose();
  }
}

function classifyRuntimeFailure(error: unknown, isolate: ivm.Isolate): MappingScriptFailureReason {
  const message = describeSandboxError(error);
  if (isolate.isDisposed && /memory limit/i.test(message)) return 'memory_limit';
  if (/(script execution timed out|execution timed out)/i.test(message)) return 'timeout';
  if (/could not be cloned/i.test(message)) return 'unclonable_result';
  return 'runtime_error';
}

function describeSandboxError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // The isolate's own stack trace refers to a script the operator cannot see the internals of
  // (the host-side function wrapper); only the message is meaningful outside the sandbox.
  return message.split('\n')[0].slice(0, 500);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '';
  }
}
