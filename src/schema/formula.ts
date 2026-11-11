import type pg from "pg";
import { dataTable } from "../db/dataTables.js";
import { query, quoteLiteral } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import type { Column, TableSchema } from "../types.js";

// Formula columns: a value worked out from the record's other fields, e.g.
//   {basic} + {allowances} - {deductions}
//   DAYS({to}, {from}) + 1
//   IF({stock} < {reorder_level}, "Low", "")
//
// An expression is parsed here (never eval'd), type-checked against the
// table's columns and compiled to a SQL expression over the record's JSON.
// The same SQL computes values on save, on import and when a whole table is
// recomputed (one UPDATE), so there is exactly one implementation.
// Empty number *fields* count as 0 in arithmetic (like a spreadsheet), so
// {basic} + {bonus} works when there's no bonus. Anything else that's empty
// (DAYS between missing dates, a division by zero) stays empty: the result is
// empty, never an error.

export type FormulaType = "number" | "text" | "date" | "boolean";

type Node =
  | { k: "num"; v: string }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "ref"; name: string }
  | { k: "call"; fn: string; args: Node[] }
  | { k: "bin"; op: string; l: Node; r: Node }
  | { k: "neg"; e: Node }
  | { k: "not"; e: Node };

const MAX_LENGTH = 1_000;
const fail = (message: string): never => {
  throw new HttpError(400, message);
};

/* ---------------- tokens ---------------- */

type Token = { t: "num" | "str" | "ref" | "id" | "op"; v: string; at: number };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const at = i;
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+(\.\d*)?|\.\d+)/.exec(src.slice(i));
      if (!m) fail(`Unexpected "${c}" at position ${i + 1}`);
      tokens.push({ t: "num", v: m![0], at });
      i += m![0].length;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let text = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) j++;
        text += src[j++];
      }
      if (j >= src.length) fail("Text is missing its closing quote");
      tokens.push({ t: "str", v: text, at });
      i = j + 1;
    } else if (c === "{") {
      const end = src.indexOf("}", i);
      if (end === -1) fail("A column name is missing its closing }");
      tokens.push({ t: "ref", v: src.slice(i + 1, end).trim(), at });
      i = end + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      tokens.push({ t: "id", v: m[0], at });
      i += m[0].length;
    } else {
      const two = src.slice(i, i + 2);
      if (["<=", ">=", "!=", "<>", "=="].includes(two)) {
        tokens.push({ t: "op", v: two === "==" ? "=" : two === "<>" ? "!=" : two, at });
        i += 2;
      } else if ("+-*/(),<>=".includes(c)) {
        tokens.push({ t: "op", v: c, at });
        i++;
      } else fail(`Unexpected "${c}" at position ${i + 1}`);
    }
  }
  return tokens;
}

/* ---------------- parser (precedence climbing) ---------------- */

export function parseFormula(src: string): Node {
  if (typeof src !== "string" || !src.trim()) fail("Enter a formula");
  if (src.length > MAX_LENGTH) fail(`The formula is too long (max ${MAX_LENGTH} characters)`);
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === "op" && peek().v === v;
  const isWord = (v: string) => peek()?.t === "id" && peek().v.toLowerCase() === v;
  const expect = (v: string) => {
    if (!isOp(v)) fail(peek() ? `Expected "${v}" at position ${peek().at + 1}` : `Expected "${v}" at the end`);
    pos++;
  };

  const or = (): Node => {
    let l = and();
    while (isWord("or")) {
      pos++;
      l = { k: "bin", op: "or", l, r: and() };
    }
    return l;
  };
  const and = (): Node => {
    let l = not();
    while (isWord("and")) {
      pos++;
      l = { k: "bin", op: "and", l, r: not() };
    }
    return l;
  };
  const not = (): Node => {
    if (isWord("not")) {
      pos++;
      return { k: "not", e: not() };
    }
    return compare();
  };
  const compare = (): Node => {
    const l = additive();
    const t = peek();
    if (t?.t === "op" && ["=", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      pos++;
      return { k: "bin", op: t.v, l, r: additive() };
    }
    return l;
  };
  const additive = (): Node => {
    let l = multiplicative();
    while (isOp("+") || isOp("-")) {
      const op = tokens[pos++].v;
      l = { k: "bin", op, l, r: multiplicative() };
    }
    return l;
  };
  const multiplicative = (): Node => {
    let l = unary();
    while (isOp("*") || isOp("/")) {
      const op = tokens[pos++].v;
      l = { k: "bin", op, l, r: unary() };
    }
    return l;
  };
  const unary = (): Node => {
    if (isOp("-")) {
      pos++;
      return { k: "neg", e: unary() };
    }
    if (isOp("+")) {
      pos++;
      return unary();
    }
    return primary();
  };
  const primary = (): Node => {
    const t = peek();
    if (!t) return fail("The formula ends too early");
    pos++;
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "str") return { k: "str", v: t.v };
    if (t.t === "ref") return t.v ? { k: "ref", name: t.v } : fail("Empty column name {}");
    if (t.t === "op" && t.v === "(") {
      const e = or();
      expect(")");
      return e;
    }
    if (t.t === "id") {
      const word = t.v.toLowerCase();
      if (word === "true" || word === "false") return { k: "bool", v: word === "true" };
      if (!isOp("(")) fail(`Unknown word "${t.v}". Put column names in braces, like {${t.v}}`);
      pos++;
      const args: Node[] = [];
      if (!isOp(")")) {
        args.push(or());
        while (isOp(",")) {
          pos++;
          args.push(or());
        }
      }
      expect(")");
      return { k: "call", fn: t.v.toUpperCase(), args };
    }
    return fail(`Unexpected "${t.v}" at position ${t.at + 1}`);
  };

  const node = or();
  if (pos < tokens.length) fail(`Unexpected "${tokens[pos].v}" at position ${tokens[pos].at + 1}`);
  return node;
}

/* ---------------- types and SQL ---------------- */

// field: a column's value as is (an empty number field then counts as 0)
type Compiled = { sql: string; type: FormulaType; emptyText?: boolean; field?: boolean };

const TYPE_NAMES: Record<FormulaType, string> = { number: "a number", text: "text", date: "a date", boolean: "yes/no" };

// What a column holds, as far as formulas are concerned
const columnType = (column: Column): FormulaType | null => {
  switch (column.type) {
    case "number":
      return "number";
    case "date":
      return "date";
    case "boolean":
      return "boolean";
    case "text":
    case "textarea":
    case "autonumber":
      return "text";
    case "choice":
      return column.multiple ? null : "text";
    case "formula":
      return column.formula?.type ?? null;
    case "rollup":
      return column.rollup?.type ?? null;
    default:
      return null;
  }
};

const FUNCTIONS = ["ROUND", "MIN", "MAX", "ABS", "IF", "DAYS", "ADD_DAYS", "CONCAT", "BLANK"];
const label = (c: Column) => c.label || c.name;

// Compile one formula column. `stack` = formulas being compiled (cycle check).
function compileColumn(column: Column, columns: Column[], stack: string[] = []): Compiled {
  if (stack.includes(column.name)) {
    const names = [...stack.slice(stack.indexOf(column.name)), column.name]
      .map((n) => label(columns.find((c) => c.name === n) ?? column))
      .join(" → ");
    fail(`Formulas can't depend on each other in a circle: ${names}`);
  }
  const node = parseFormula(column.formula?.expression ?? "");
  return compileNode(node, columns, [...stack, column.name]);
}

function compileNode(node: Node, columns: Column[], stack: string[]): Compiled {
  const sub = (n: Node) => compileNode(n, columns, stack);
  const need = (c: Compiled, type: FormulaType, what: string) => {
    if (c.type !== type) fail(`${what} needs ${TYPE_NAMES[type]}, not ${TYPE_NAMES[c.type]}`);
    return c.sql;
  };
  const num0 = (c: Compiled, what: string) => (c.field ? `COALESCE(${need(c, "number", what)}, 0)` : need(c, "number", what));

  switch (node.k) {
    case "num":
      return { sql: `${node.v.startsWith(".") ? `0${node.v}` : node.v}::numeric`, type: "number" };
    case "str":
      return { sql: quoteLiteral(node.v), type: "text", emptyText: node.v === "" };
    case "bool":
      return { sql: node.v ? "TRUE" : "FALSE", type: "boolean" };
    case "ref": {
      // by column name (not label), so renaming a label never breaks a formula
      const column = columns.find((c) => c.name === node.name);
      if (!column) {
        const byLabel = columns.find((c) => label(c).toLowerCase() === node.name.toLowerCase());
        return fail(`Unknown column {${node.name}}${byLabel ? `. Did you mean {${byLabel.name}}?` : ""}`);
      }
      if (column.type === "formula") {
        const inner = compileColumn(column, columns, stack);
        return { sql: `(${inner.sql})`, type: inner.type };
      }
      if (column.type === "rollup") {
        const inner = compileRollup(column);
        return { sql: `(${inner.sql})`, type: inner.type, field: inner.type === "number" };
      }
      const type = columnType(column);
      if (!type) return fail(`{${node.name}} can't be used in a formula (only text, number, date, yes/no and single choices)`);
      const field = `(t.data ->> ${quoteLiteral(column.name)})`;
      const sql =
        type === "number"
          ? `erp_try_numeric${field}`
          : type === "date"
            ? `erp_try_date${field}`
            : type === "boolean"
              ? `((t.data -> ${quoteLiteral(column.name)}) = 'true'::jsonb)`
              : field;
      return { sql, type, field: true };
    }
    case "neg":
      return { sql: `(-${num0(sub(node.e), "A minus sign")})`, type: "number" };
    case "not":
      return { sql: `(NOT COALESCE(${need(sub(node.e), "boolean", "NOT")}, FALSE))`, type: "boolean" };
    case "bin": {
      const l = sub(node.l);
      const r = sub(node.r);
      if (node.op === "and" || node.op === "or") {
        return {
          sql: `(COALESCE(${need(l, "boolean", node.op.toUpperCase())}, FALSE) ${node.op.toUpperCase()} COALESCE(${need(r, "boolean", node.op.toUpperCase())}, FALSE))`,
          type: "boolean",
        };
      }
      if (["+", "-", "*", "/"].includes(node.op)) {
        if (node.op === "+" && (l.type === "text" || r.type === "text")) fail("Use CONCAT(…) to join text");
        if (l.type === "date" || r.type === "date") fail("Use DAYS(…) or ADD_DAYS(…) to work with dates");
        const what = `"${node.op}"`;
        if (node.op === "/") return { sql: `(${num0(l, what)} / NULLIF(${num0(r, what)}, 0))`, type: "number" };
        return { sql: `(${num0(l, what)} ${node.op} ${num0(r, what)})`, type: "number" };
      }
      // comparisons: same kind on both sides
      if (l.type !== r.type) fail(`Can't compare ${TYPE_NAMES[l.type]} with ${TYPE_NAMES[r.type]}`);
      const op = node.op === "!=" ? "<>" : node.op;
      const side = (c: Compiled) => (c.type === "text" ? `COALESCE(${c.sql}, '')` : c.sql);
      return { sql: `COALESCE(${side(l)} ${op} ${side(r)}, FALSE)`, type: "boolean" };
    }
    case "call": {
      const { fn, args } = node;
      if (!FUNCTIONS.includes(fn)) fail(`Unknown function ${fn}(). Available: ${FUNCTIONS.join(", ")}`);
      const count = (min: number, max = min) => {
        if (args.length < min || args.length > max) {
          fail(`${fn}() takes ${min === max ? min : `${min} to ${max === Infinity ? "any number of" : max}`} value${max === 1 ? "" : "s"}`);
        }
      };
      const c = args.map(sub);
      switch (fn) {
        case "ROUND": {
          count(1, 2);
          const places = args[1];
          if (places && (places.k !== "num" || !/^\d+$/.test(places.v) || Number(places.v) > 10)) {
            fail("ROUND's second value is the number of decimals: a whole number from 0 to 10");
          }
          return { sql: `round(${need(c[0], "number", "ROUND")}, ${places ? Number((places as { v: string }).v) : 0})`, type: "number" };
        }
        case "ABS":
          count(1);
          return { sql: `abs(${need(c[0], "number", "ABS")})`, type: "number" };
        case "MIN":
        case "MAX": {
          count(1, Infinity);
          const type = c[0].type;
          if (type !== "number" && type !== "date") fail(`${fn}() works on numbers or dates`);
          return { sql: `${fn === "MIN" ? "LEAST" : "GREATEST"}(${c.map((x) => need(x, type, fn)).join(", ")})`, type };
        }
        case "IF": {
          count(3);
          const cond = need(c[0], "boolean", "IF's first value (the condition)");
          // IF(cond, {x}, "") reads naturally: "" then means empty
          let [a, b] = [c[1], c[2]];
          if (a.emptyText && b.type !== "text") a = { sql: "NULL", type: b.type };
          if (b.emptyText && a.type !== "text") b = { sql: "NULL", type: a.type };
          if (a.type !== b.type) fail(`IF's two results must be the same kind, not ${TYPE_NAMES[a.type]} and ${TYPE_NAMES[b.type]}`);
          return { sql: `(CASE WHEN COALESCE(${cond}, FALSE) THEN ${a.sql} ELSE ${b.sql} END)`, type: a.type };
        }
        case "DAYS":
          count(2);
          return { sql: `(${need(c[0], "date", "DAYS")} - ${need(c[1], "date", "DAYS")})::numeric`, type: "number" };
        case "ADD_DAYS":
          count(2);
          return {
            sql: `(${need(c[0], "date", "ADD_DAYS")} + LEAST(GREATEST(COALESCE(${need(c[1], "number", "ADD_DAYS")}, 0), -100000), 100000)::int)`,
            type: "date",
          };
        case "CONCAT": {
          count(1, Infinity);
          const parts = c.map((x) =>
            x.type === "number"
              ? `trim_scale(${x.sql})::text`
              : x.type === "date"
                ? `to_char(${x.sql}, 'YYYY-MM-DD')`
                : x.type === "boolean"
                  ? `(CASE WHEN ${x.sql} THEN 'Yes' WHEN NOT ${x.sql} THEN 'No' END)`
                  : x.sql
          );
          return { sql: `concat(${parts.join(", ")})`, type: "text" };
        }
        case "BLANK": {
          count(1);
          const x = c[0];
          return { sql: x.type === "text" ? `(COALESCE(${x.sql}, '') = '')` : `(${x.sql} IS NULL)`, type: "boolean" };
        }
      }
      return fail(`Unknown function ${fn}()`);
    }
  }
}

// A roll-up: an aggregate over the records of another table that link to
// this one (alias t). Reads their stored values, which are kept current
// because a record's own formulas are worked out before its parents' roll-ups.
function compileRollup(column: Column): Compiled {
  const r = column.rollup;
  if (!r?.type) return fail(`Roll-up "${label(column)}" isn't set up`);
  const value = (name: string) =>
    r.type === "date" ? `erp_try_date(c.data ->> ${quoteLiteral(name)})` : `erp_try_numeric(c.data ->> ${quoteLiteral(name)})`;
  const agg =
    r.fn === "count"
      ? "count(*)::numeric"
      : r.fn === "sum"
        ? `COALESCE(sum(${value(r.field!)}), 0)`
        : `${r.fn}(${value(r.field!)})`;
  const list = (items: string[]) => `ARRAY[${items.map(quoteLiteral).join(", ")}]::text[]`;
  const where = [
    // the link may hold one id or a list of ids; uses the link column's GIN index
    `c.data -> ${quoteLiteral(r.via)} @> to_jsonb(t._id)`,
    ...(r.where?.in ? [`COALESCE(c.data -> ${quoteLiteral(r.where.column)} ?| ${list(r.where.in)}, FALSE)`] : []),
    ...(r.where?.notIn ? [`NOT COALESCE(c.data -> ${quoteLiteral(r.where.column)} ?| ${list(r.where.notIn)}, FALSE)`] : []),
  ];
  return { sql: `(SELECT ${agg} FROM ${dataTable(r.from)} c WHERE ${where.join(" AND ")})`, type: r.type };
}

// The stored (JSON) value of a compiled formula
const asJson = (c: Compiled) =>
  c.type === "number"
    ? `to_jsonb(trim_scale(round((${c.sql})::numeric, 6)))`
    : c.type === "date"
      ? `to_jsonb(to_char(${c.sql}, 'YYYY-MM-DD'))`
      : `to_jsonb(${c.sql})`;

/* ---------------- public API ---------------- */

// Check every formula in a column list and record each one's result type
// (in place). Throws a readable 400 on the first problem.
export function checkFormulas(columns: Column[]): void {
  for (const column of columns) {
    if (column.type !== "formula") continue;
    try {
      const compiled = compileColumn(column, columns);
      column.formula = { expression: column.formula!.expression, type: compiled.type };
    } catch (error) {
      if (error instanceof HttpError) throw new HttpError(400, `Formula "${label(column)}": ${error.message}`);
      throw error;
    }
  }
}

// Try a formula that isn't saved yet (the column settings "Check" button):
// its result type and its value on the latest record.
export async function tryFormula(schema: TableSchema, expression: string, columnName?: string) {
  const self: Column = {
    ...(schema.columns.find((c) => c.name === columnName) ?? ({ name: columnName || "__new_formula__" } as Column)),
    type: "formula",
    formula: { expression },
  };
  const columns = [...schema.columns.filter((c) => c.name !== self.name), self];
  const compiled = compileColumn(self, columns);
  const { rows } = await query<{ value: unknown }>(
    `SELECT ${asJson(compiled)} AS value FROM ${dataTable(schema.tableName)} t ORDER BY t.created_at DESC LIMIT 1`
  );
  return { type: compiled.type, sample: rows[0]?.value ?? null, hasRecords: rows.length > 0 };
}

// Work out the formula columns of some records (ids), or of every record
// (null). Runs inside the caller's transaction, after the write.
export async function applyFormulas(schema: TableSchema, ids: string[] | null, client: pg.PoolClient) {
  // formulas and roll-ups: both are worked out here, in one statement
  const formulas = schema.columns.filter((c) => c.type === "formula" || c.type === "rollup");
  if (!formulas.length || (ids && !ids.length)) return;
  // jsonb_build_object takes at most 100 arguments: 40 formulas per pass
  for (let i = 0; i < formulas.length; i += 40) {
    const pairs = formulas
      .slice(i, i + 40)
      .map(
        (column) =>
          `${quoteLiteral(column.name)}, ${asJson(column.type === "rollup" ? compileRollup(column) : compileColumn(column, schema.columns))}`
      );
    await query(
      `UPDATE ${dataTable(schema.tableName)} t SET data = t.data || jsonb_build_object(${pairs.join(", ")})
       ${ids ? "WHERE t._id = ANY($1::text[])" : ""}`,
      ids ? [ids] : [],
      client
    );
  }
}

// The columns a formula uses (by name), for the "used by" check on delete
export function formulaRefs(column: Column): string[] {
  const refs: string[] = [];
  const walk = (n: Node) => {
    if (n.k === "ref") refs.push(n.name);
    else if (n.k === "call") n.args.forEach(walk);
    else if (n.k === "bin") {
      walk(n.l);
      walk(n.r);
    } else if (n.k === "neg" || n.k === "not") walk(n.e);
  };
  try {
    walk(parseFormula(column.formula?.expression ?? ""));
  } catch {
    // an invalid formula uses nothing
  }
  return refs;
}
