import { describe, expect, it } from 'vitest';
import { checkMappingScriptSyntax, runMappingScript } from '../src/modules/connectors/mapping/script-sandbox';

/**
 * The US17.2 scripting escape hatch: a script executes in an isolated V8 engine (`isolated-vm`,
 * never Node's `vm`/`vm2`), under a hard wall-clock timeout and a hard memory limit, with no
 * ambient network or filesystem access. These tests exercise the actual failure boundaries — a
 * real infinite loop is really killed, a real memory hog is really killed, `require`/`fetch` are
 * really absent — rather than asserting a policy the sandbox merely claims to enforce.
 */
describe('US17.2 field-mapping script sandbox', () => {
  const input = (overrides: Partial<Parameters<typeof runMappingScript>[1]> = {}) => ({
    fields: { priority: 'High', assignee: 'a@acme.test' },
    sourceState: 'In Progress',
    targetState: 'To Do',
    direction: 'source_to_target' as const,
    ...overrides,
  });

  it('runs a well-behaved transform and returns its value', async () => {
    const result = await runMappingScript('return fields.priority === "High" ? "P1" : "P2";', input());
    expect(result).toMatchObject({ ok: true, value: 'P1' });
  });

  it('receives sourceState, targetState and direction as its own arguments', async () => {
    const result = await runMappingScript(
      'return sourceState + ">" + targetState + ":" + direction;',
      input({ direction: 'target_to_source' }),
    );
    expect(result).toMatchObject({ ok: true, value: 'In Progress>To Do:target_to_source' });
  });

  it('returns objects and arrays, deep-copied rather than referenced', async () => {
    const result = await runMappingScript('return { code: fields.priority, tags: ["a", "b"] };', input());
    expect(result).toMatchObject({ ok: true, value: { code: 'High', tags: ['a', 'b'] } });
  });

  it('reports a compile error for invalid syntax without running anything', async () => {
    const result = await runMappingScript('return fields.priority ===;', input());
    expect(result).toMatchObject({ ok: false, reason: 'compile_error' });
    expect((result as any).message).toBeTruthy();
  });

  it('reports a runtime error for a thrown exception, not a raw sandbox stack trace', async () => {
    const result = await runMappingScript('throw new Error("boom from transform");', input());
    expect(result).toMatchObject({ ok: false, reason: 'runtime_error', message: expect.stringContaining('boom from transform') });
  });

  it('kills a real infinite loop at the configured timeout instead of hanging the caller', async () => {
    const startedAt = Date.now();
    const result = await runMappingScript('while (true) {}', input(), { timeoutMs: 200 });
    const elapsedMs = Date.now() - startedAt;
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    // Proves the loop was actually aborted near the timeout, not that the call merely returned an
    // error quickly for an unrelated reason.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('kills a real memory hog at the configured limit instead of exhausting host memory', async () => {
    const result = await runMappingScript(
      'const chunks = []; while (true) { chunks.push(new Array(1_000_000).fill(0)); }',
      input(),
      { timeoutMs: 5000, memoryLimitMb: 8 },
    );
    expect(result).toMatchObject({ ok: false, reason: 'memory_limit' });
  }, 10000);

  it('has no ambient require, fetch, process or filesystem/network capability of any kind', async () => {
    const probes = [
      'return typeof require;',
      'return typeof fetch;',
      'return typeof process;',
      'return typeof global;',
      'return typeof globalThis.require;',
      'return typeof module;',
      'return typeof XMLHttpRequest;',
      'return typeof WebSocket;',
    ];
    for (const probe of probes) {
      const result = await runMappingScript(probe, input());
      expect(result).toMatchObject({ ok: true, value: 'undefined' });
    }
  });

  it('cannot reach the host process even by attempting a constructor-chain escape', async () => {
    // A well-known vm-escape pattern (reaching the host's Function constructor through a
    // generator's constructor chain) fails inside a real isolate because there is no host object
    // graph to walk into — the isolate's `this` and every built-in belong only to that isolate.
    const result = await runMappingScript(
      'try { return (function*(){}).constructor.constructor("return process")().pid ? "escaped" : "no-pid"; } '
      + 'catch (e) { return "blocked:" + e.message; }',
      input(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).value).toMatch(/^blocked:|no-pid$/);
  });

  it('rejects a returned function as an unclonable result rather than silently coercing it', async () => {
    const result = await runMappingScript('return function () {};', input());
    expect(result).toMatchObject({ ok: false, reason: 'unclonable_result' });
  });

  it('rejects an oversized return value', async () => {
    const result = await runMappingScript('return "x".repeat(200000);', input());
    expect(result).toMatchObject({ ok: false, reason: 'oversized_result' });
  });

  it('rejects an oversized input before ever compiling or running the script', async () => {
    const result = await runMappingScript('return 1;', input({ fields: { blob: 'y'.repeat(600_000) } }));
    expect(result).toMatchObject({ ok: false, reason: 'oversized_input' });
  });

  it('rejects a deeply nested return value even when it stays under the byte limit', async () => {
    // 200 levels of nested single-element arrays serialize to well under 64KB but would risk a
    // stack overflow in downstream recursive processing (stableStringify, setPath) if allowed through.
    const result = await runMappingScript('let v = []; for (let i = 0; i < 200; i++) v = [v]; return v;', input());
    expect(result).toMatchObject({ ok: false, reason: 'excessive_nesting' });
  });

  it('rejects a script that exceeds the source-size limit', async () => {
    const result = await runMappingScript(`return ${'1+'.repeat(11000)}1;`, input());
    expect(result).toMatchObject({ ok: false, reason: 'script_too_large' });
  });

  it('gives every run a fresh isolate: no state or timing leaks between calls', async () => {
    const first = await runMappingScript('globalThis.__leak = 42; return "set";', input());
    expect(first).toMatchObject({ ok: true, value: 'set' });
    const second = await runMappingScript('return typeof globalThis.__leak;', input());
    expect(second).toMatchObject({ ok: true, value: 'undefined' });
  });

  it('validates script syntax statically without executing it, for pre-publish checks', async () => {
    const valid = await checkMappingScriptSyntax('return fields.priority;');
    expect(valid).toEqual({ valid: true });
    const invalid = await checkMappingScriptSyntax('return fields.priority ===;');
    expect(invalid.valid).toBe(false);
    // A syntactically valid but infinite script must not hang syntax checking; it is never run.
    const infiniteButSyntacticallyValid = await checkMappingScriptSyntax('while (true) {}');
    expect(infiniteButSyntacticallyValid).toEqual({ valid: true });
  });
});
