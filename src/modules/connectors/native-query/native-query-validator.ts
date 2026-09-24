import { NativeQueryIssue, NativeQueryLanguage, NativeQueryValidation } from './native-query.types';
import { QueryIndexCatalog } from './query-index-catalog';

/**
 * Static validation of scheduled native queries (US17.3).
 *
 * Cadena appends its own `updated >= <watermark>` predicate and its own ordering to every scheduled
 * query, so a run is always bounded in time. What validation must still prevent is a query that
 * would read *every record of the source* inside that window: no selective scope means each run
 * walks the whole instance's recent changes, and a lost watermark degrades to a full scan.
 *
 * The scope rule is a static heuristic: it requires a positive scope predicate (a project, a key,
 * a stable reference) on every branch of the query and says exactly which clause to add when one
 * is missing. When the connector's index catalog is supplied (US16.2), every field the query
 * filters on must also be indexed on the target, and each offending field is named.
 */

export const MAX_NATIVE_QUERY_LENGTH = 4000;

// ─── Shared lexical helpers ────────────────────────────────────────────────

/** Returns a problem description, or null when quotes, parentheses and (WIQL) brackets balance. */
function balanceProblem(text: string, brackets: boolean): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (brackets && char === '[') quote = ']';
    else if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth < 0) return 'a closing parenthesis has no matching opening parenthesis';
    }
  }
  if (quote) return quote === ']' ? 'a [field] bracket is not closed' : 'a quoted string is not closed';
  if (depth > 0) return 'an opening parenthesis is not closed';
  return null;
}

/** Splits at a keyword that sits outside quotes and parentheses, matched as a whole word, case-insensitively. */
function splitTopLevel(text: string, keyword: string, brackets: boolean): string[] {
  const matcher = new RegExp(`^(?:${keyword})(?=[\\s(]|$)`, 'i');
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (brackets && char === '[') quote = ']';
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (depth === 0 && /\s|\)/.test(index === 0 ? ' ' : text[index - 1])) {
      const hit = matcher.exec(text.slice(index));
      if (hit && index > start) {
        parts.push(text.slice(start, index));
        start = index + hit[0].length;
        index = start - 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function stripOuterParens(text: string): string {
  let current = text.trim();
  while (current.startsWith('(') && current.endsWith(')')) {
    let depth = 0;
    let quote: string | null = null;
    let wrapsAll = true;
    for (let index = 0; index < current.length; index++) {
      const char = current[index];
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === '(') depth++;
      else if (char === ')' && --depth === 0 && index < current.length - 1) {
        wrapsAll = false;
        break;
      }
    }
    if (!wrapsAll) break;
    current = current.slice(1, -1).trim();
  }
  return current;
}

/**
 * True when every OR branch contains at least one AND-ed selective predicate. A scope that only
 * constrains one OR branch leaves the other branch free to read everything, so it does not count.
 */
function isScoped(expression: string, isSelective: (predicate: string) => boolean, brackets: boolean): boolean {
  const stripped = stripOuterParens(expression);
  const branches = splitTopLevel(stripped, 'or', brackets);
  if (branches.length > 1) return branches.every((branch) => isScoped(branch, isSelective, brackets));
  const conjuncts = splitTopLevel(stripped, 'and', brackets);
  if (conjuncts.length > 1) return conjuncts.some((part) => isScoped(part, isSelective, brackets));
  return isSelective(stripped);
}

/** Every leaf predicate of an AND/OR/NOT expression, in order. */
function leafPredicates(expression: string, brackets: boolean): string[] {
  const stripped = stripOuterParens(expression);
  const negated = /^not\s+/i.exec(stripped);
  if (negated) return leafPredicates(stripped.slice(negated[0].length), brackets);
  const branches = splitTopLevel(stripped, 'or', brackets);
  if (branches.length > 1) return branches.flatMap((branch) => leafPredicates(branch, brackets));
  const conjuncts = splitTopLevel(stripped, 'and', brackets);
  if (conjuncts.length > 1) return conjuncts.flatMap((part) => leafPredicates(part, brackets));
  return stripped ? [stripped] : [];
}

const issue = (code: NativeQueryIssue['code'], message: string, hint: string): NativeQueryIssue => ({ code, message, hint });

/**
 * Names every referenced field the target cannot serve from an index (US16.2). A field the
 * catalog does not know is refused too: Cadena cannot vouch for an index it has never seen.
 */
function indexProblems(references: string[], catalog: QueryIndexCatalog | undefined): NativeQueryIssue[] {
  if (!catalog) return [];
  const target = `${catalog.provider === 'jira' ? 'Jira' : 'ServiceNow'} ${catalog.entityType}`;
  if (catalog.unavailable) {
    return [issue('index_catalog_unavailable', catalog.unavailable, 'Run discovery on the connector, then validate the query again.')];
  }
  const suggestions = catalog.indexedFields().slice(0, 8).join(', ');
  const alternative = suggestions ? `Filter on an indexed field instead (for example ${suggestions})` : 'Filter on an indexed field instead';
  const problems: NativeQueryIssue[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const key = reference.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = catalog.lookup(reference);
    if (hit?.indexed) continue;
    const declare = catalog.provider === 'servicenow'
      ? `, or, if an administrator has indexed '${hit?.field || reference}' on this instance, declare it in the connector's query indexes`
      : '';
    problems.push(hit
      ? {
        ...issue(
          'unindexed_field',
          `The field '${reference}' is not indexed on ${target}: ${hit.reason || 'the target reports no index for it'}. Filtering on it makes the target scan the table while holding a database query semaphore.`,
          `${alternative}${declare}.`,
        ),
        field: hit.field,
      }
      : {
        ...issue(
          'unknown_field',
          `The field '${reference}' is not a discovered ${target} field, so Cadena cannot confirm it is indexed.`,
          `Check the spelling against the discovered schema, or run discovery again if the field is new. ${alternative}${declare}.`,
        ),
        field: reference,
      });
  }
  return problems;
}

function finish(language: NativeQueryLanguage, errors: NativeQueryIssue[], warnings: NativeQueryIssue[] = []): NativeQueryValidation {
  return { valid: errors.length === 0, language, errors, warnings };
}

function basicProblems(text: string): NativeQueryIssue[] {
  if (!text.trim()) return [issue('empty_query', 'The query is empty.', 'Provide a query with at least one scope predicate.')];
  if (text.length > MAX_NATIVE_QUERY_LENGTH) {
    return [issue('query_too_long', `The query is ${text.length} characters; the limit is ${MAX_NATIVE_QUERY_LENGTH}.`, 'Split it into several scheduled queries.')];
  }
  return [];
}

// ─── JQL ───────────────────────────────────────────────────────────────────

/** Fields whose equality/IN predicates name a bounded slice of a Jira site. */
const JQL_SCOPE_FIELDS = new Set([
  'project', 'key', 'issuekey', 'id', 'issue', 'filter', 'parent', 'epic link', 'sprint',
  'component', 'fixversion', 'labels', 'assignee', 'reporter', 'team',
]);

function jqlSelective(predicate: string): boolean {
  const match = /^("[^"]+"|'[^']+'|cf\[\d+\]|[A-Za-z][\w.]*)\s*(=|in\b|was\b)/i.exec(predicate);
  if (!match) return false;
  return JQL_SCOPE_FIELDS.has(match[1].replace(/^["']|["']$/g, '').toLowerCase());
}

const JQL_FIELD = /^("[^"]+"|'[^']+'|cf\[\d+\]|[A-Za-z][\w.]*)\s*(?:!?=|!?~|>=|<=|>|<|not\s+in\b|in\b|is\b|was\b|changed\b)/i;

/** The field each JQL predicate filters on, as written (quotes removed). */
function jqlFieldReferences(body: string): string[] {
  return leafPredicates(body, false)
    .map((predicate) => JQL_FIELD.exec(predicate)?.[1])
    .filter((field): field is string => Boolean(field))
    .map((field) => field.replace(/^["']|["']$/g, ''));
}

export function validateJql(text: string, catalog?: QueryIndexCatalog): NativeQueryValidation {
  const errors = basicProblems(text);
  if (errors.length) return finish('jql', errors);
  const unbalanced = balanceProblem(text, false);
  if (unbalanced) return finish('jql', [issue('syntax', `Malformed JQL: ${unbalanced}.`, 'Fix the quoting or parentheses.')]);
  if (/\bin\s*\(\s*\)/i.test(text)) {
    return finish('jql', [issue('syntax', 'Malformed JQL: an IN list is empty.', 'List at least one value, e.g. project in ("CAD").')]);
  }

  if (splitTopLevel(text, 'order\\s+by', false).length > 1) {
    errors.push(issue(
      'order_by_not_allowed',
      'The query has its own ORDER BY.',
      'Remove it. Cadena orders scheduled queries by "updated ASC, key ASC" so the watermark advances safely.',
    ));
  }
  if (/(^|[\s(])(updated|updateddate)\s*(>=|<=|>|<|=|!=)/i.test(text) || /(^|[\s(])updated\s+(after|before|during|by)\b/i.test(text)) {
    errors.push(issue(
      'watermark_conflict',
      'The query filters on "updated", which Cadena manages as the watermark.',
      'Remove the "updated" clause. Cadena adds "updated >= <watermark>"; set start_from to control where the first run begins.',
    ));
  }
  const body = splitTopLevel(text, 'order\\s+by', false)[0];
  if (!errors.length) {
    if (!isScoped(body, jqlSelective, false)) {
      errors.push(issue(
        'unbounded_scan',
        'The query has no selective scope, so each run would read every issue changed anywhere on the Jira site.',
        'Add a positive scope to every OR branch, for example project = "CAD" (or project in ("CAD", "OPS")). Negations, status, priority and text searches do not count as a scope.',
      ));
    }
  }
  errors.push(...indexProblems(jqlFieldReferences(body), catalog));
  return finish('jql', errors);
}

// ─── ServiceNow encoded query ──────────────────────────────────────────────

const ENCODED_OPERATORS = [
  'NOT IN', 'NOT LIKE', '!=', '>=', '<=', '=', '>', '<', 'IN', 'LIKE', 'STARTSWITH', 'ENDSWITH', 'CONTAINS',
  'ISNOTEMPTY', 'ISEMPTY', 'BETWEEN', 'SAMEAS', 'NSAMEAS', 'ANYTHING', 'VALCHANGES', 'CHANGESFROM', 'CHANGESTO',
  'DYNAMIC', 'INSTANCEOF', 'MATCHES',
];
const ENCODED_TERM = new RegExp(`^([a-z_][a-z0-9_.]*)(${ENCODED_OPERATORS.map((op) => op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(.*)$`);
/** Positive operators that narrow to a subset. Range, negation and wildcard operators do not. */
const ENCODED_SELECTIVE = new Set(['=', 'IN', 'STARTSWITH', 'BETWEEN', 'SAMEAS']);

interface EncodedTerm { field: string; operator: string; value: string; or: boolean }

export function validateEncodedQuery(text: string, catalog?: QueryIndexCatalog): NativeQueryValidation {
  const errors = basicProblems(text);
  if (errors.length) return finish('encoded', errors);

  const rawTerms = text.split(/(?<!\^)\^(?!\^)/).map((term) => term.trim());
  const groups: EncodedTerm[][] = [[]];
  for (const raw of rawTerms) {
    if (!raw || raw === 'EQ') continue;
    if (/^ORDERBY(DESC)?/.test(raw) || /^GROUPBY/.test(raw)) {
      errors.push(issue(
        'order_by_not_allowed',
        `The query contains '${raw}'.`,
        'Remove ORDERBY/GROUPBY terms. Cadena orders scheduled queries by sys_updated_on then sys_id so the watermark advances safely.',
      ));
      continue;
    }
    // `NQ` starts a new, independent query whose first term follows it directly (a=1^NQb=2).
    const startsQuery = raw.startsWith('NQ');
    if (startsQuery) groups.push([]);
    const isOr = !startsQuery && raw.startsWith('OR');
    const body = startsQuery || isOr ? raw.slice(2) : raw;
    if (!body) continue;
    const match = ENCODED_TERM.exec(body);
    if (!match) {
      errors.push(issue('syntax', `Cannot parse the term '${raw}'.`, "Use field-name + operator + value, e.g. assignment_group=<sys_id>, and join terms with '^' or '^OR'."));
      continue;
    }
    groups[groups.length - 1].push({ field: match[1], operator: match[2], value: match[3], or: isOr });
  }
  if (errors.length) return finish('encoded', errors);

  if (groups.every((group) => group.length === 0)) {
    return finish('encoded', [issue('empty_query', 'The query has no conditions.', 'Provide at least one condition such as assignment_group=<sys_id>.')]);
  }
  if (groups.some((group) => group.some((term) => term.field === 'sys_updated_on'))) {
    errors.push(issue(
      'watermark_conflict',
      'The query filters on sys_updated_on, which Cadena manages as the watermark.',
      'Remove the sys_updated_on condition. Cadena adds sys_updated_on>=<watermark>; set start_from to control where the first run begins.',
    ));
  }

  groups.forEach((group, groupIndex) => {
    if (group.length === 0) return;
    // ANDed clauses; a term marked OR belongs to the clause before it.
    const clauses: EncodedTerm[][] = [];
    for (const term of group) {
      if (term.or && clauses.length) clauses[clauses.length - 1].push(term);
      else clauses.push([term]);
    }
    const selective = (term: EncodedTerm) =>
      ENCODED_SELECTIVE.has(term.operator) && !(term.operator === '=' && /^(true|false)$/i.test(term.value));
    if (!clauses.some((clause) => clause.every(selective))) {
      errors.push(issue(
        'unbounded_scan',
        groups.length > 1
          ? `Query part ${groupIndex + 1} has no selective condition, so it would read every record in the table.`
          : 'The query has no selective condition, so each run would read every record changed in the table.',
        'Add an equality or IN condition on an indexed field that is not an OR-alternative to an unconstrained term, for example assignment_group=<sys_id> or cmdb_ci=<sys_id>. Boolean flags such as active=true, ranges, negations and LIKE/CONTAINS do not count.',
      ));
    }
  });
  errors.push(...indexProblems(
    groups.flatMap((group) => group.map((term) => term.field)).filter((field) => field !== 'sys_updated_on'),
    catalog,
  ));
  return finish('encoded', errors);
}

// ─── WIQL (validation only: no Azure DevOps runner ships with Cadena) ───────

const WIQL_SCOPE_FIELDS = new Set([
  'system.teamproject', 'system.areapath', 'system.iterationpath', 'system.id', 'system.assignedto', 'system.tags',
]);

function wiqlSelective(predicate: string): boolean {
  const match = /^\[([^\]]+)\]\s*(=|in\b|under\b|contains\b)/i.exec(predicate);
  return Boolean(match && WIQL_SCOPE_FIELDS.has(match[1].toLowerCase()));
}

export function validateWiql(text: string): NativeQueryValidation {
  const errors = basicProblems(text);
  if (errors.length) return finish('wiql', errors);
  const unbalanced = balanceProblem(text, true);
  if (unbalanced) return finish('wiql', [issue('syntax', `Malformed WIQL: ${unbalanced}.`, 'Fix the quoting, [field] brackets or parentheses.')]);

  const shape = /^\s*select\s+[\s\S]+?\s+from\s+(workitems|workitemlinks)\b([\s\S]*)$/i.exec(text);
  if (!shape) {
    return finish('wiql', [issue('syntax', 'WIQL must have the form SELECT [fields] FROM WorkItems WHERE <conditions>.', 'Start with SELECT ... FROM WorkItems WHERE ....')]);
  }
  const tail = shape[2];
  const warnings = [issue(
    'no_runner',
    'WIQL can be validated but not scheduled: Cadena ships no Azure DevOps connector adapter.',
    'Use a Jira (JQL) or ServiceNow (encoded query) connector to schedule a query.',
  )];
  if (!/^\s*where\b/i.test(tail)) {
    if (/^\s*(order\s+by|asof)\b/i.test(tail) || !tail.trim()) {
      errors.push(issue(
        'unbounded_scan',
        'The query has no WHERE clause, so it selects every work item in the organization.',
        "Add a WHERE clause with a scope such as [System.TeamProject] = 'Payments' or [System.AreaPath] UNDER 'Payments\\Core'.",
      ));
      return finish('wiql', errors, warnings);
    }
    return finish('wiql', [issue('syntax', 'Unexpected text after FROM WorkItems.', 'Use WHERE to add conditions.')], warnings);
  }
  const afterWhere = tail.replace(/^\s*where\b/i, '');
  if (splitTopLevel(afterWhere, 'order\\s+by', true).length > 1) {
    errors.push(issue('order_by_not_allowed', 'The query has its own ORDER BY.', 'Remove it; Cadena orders scheduled queries by [System.ChangedDate].'));
  }
  const conditions = splitTopLevel(afterWhere, 'order\\s+by', true)[0].replace(/\basof\b[\s\S]*$/i, '').trim();
  if (/\[System\.ChangedDate\]/i.test(conditions)) {
    errors.push(issue('watermark_conflict', 'The query filters on [System.ChangedDate], which Cadena manages as the watermark.', 'Remove that condition; set start_from to control where the first run begins.'));
  }
  if (!errors.length && !isScoped(conditions, wiqlSelective, true)) {
    errors.push(issue(
      'unbounded_scan',
      'The query has no selective scope, so it would read every work item changed in the organization.',
      "Add a scope to every OR branch, for example [System.TeamProject] = 'Payments' or [System.AreaPath] UNDER 'Payments\\Core'.",
    ));
  }
  return finish('wiql', errors, warnings);
}

/**
 * Validates a query in its native language. With a catalog, fields are also checked against the
 * target's indexes; without one (an ad-hoc check that names no connector) a warning says so.
 */
export function validateNativeQuery(language: NativeQueryLanguage, text: string, catalog?: QueryIndexCatalog): NativeQueryValidation {
  const result = language === 'jql' ? validateJql(text, catalog)
    : language === 'encoded' ? validateEncodedQuery(text, catalog)
      : validateWiql(text);
  if (!catalog && language !== 'wiql') {
    result.warnings.push(issue(
      'indexes_not_checked',
      'Field indexes were not checked because no connector entity was named.',
      'Pass connector_id and entity_type to check every filtered field against that target\'s indexes.',
    ));
  }
  return result;
}
