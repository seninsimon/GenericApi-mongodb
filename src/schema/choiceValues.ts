import type pg from "pg";
import { dataTable } from "../db/dataTables.js";
import { query } from "../db/pool.js";
import type { Column } from "../types.js";

// Keeping stored values in step with a "choice" column's options. Records
// store the option label, so renaming an option, or turning a Text column
// into a Choice (and back), rewrites existing values.

// Distinct non-empty values of a text column (case and spaces ignored), most
// used first, at most `limit`.
export async function distinctTextValues(tableName: string, column: string, limit: number): Promise<string[]> {
  const { rows } = await query<{ value: string }>(
    `SELECT min(btrim(t.data ->> $1)) AS value
       FROM ${dataTable(tableName)} t
      WHERE jsonb_typeof(t.data -> $1) IN ('string', 'number') AND btrim(t.data ->> $1) <> ''
      GROUP BY lower(btrim(t.data ->> $1))
      ORDER BY count(*) DESC, 1
      LIMIT $2`,
    [column, limit]
  );
  return rows.map((r) => r.value);
}

// Bring stored values in line after a column update. Returns how many
// records changed. Record history and "updated at" are left alone: this is a
// change to the column, not to the records.
export async function rewriteChoiceValues(
  tableName: string,
  before: Column,
  after: Column,
  client: pg.PoolClient
): Promise<number> {
  const table = dataTable(tableName);
  const path = [after.name];

  // Text -> Choice: values that match an option apart from case or spaces
  // take the option's exact label ("done " -> "Done").
  if (before.type !== "choice" && after.type === "choice") {
    const labels = after.options!.map((o) => o.label);
    const { rowCount } = await query(
      `UPDATE ${table} t SET data = jsonb_set(t.data, $1::text[], to_jsonb(o.label))
         FROM unnest($3::text[]) o(label)
        WHERE lower(btrim(t.data ->> $2)) = lower(o.label) AND t.data ->> $2 IS DISTINCT FROM o.label`,
      [path, after.name, labels],
      client
    );
    return rowCount ?? 0;
  }

  // Choice -> Text: several picks become "A, B"
  if (before.type === "choice" && after.type !== "choice") {
    const { rowCount } = await query(
      `UPDATE ${table} t
          SET data = jsonb_set(t.data, $1::text[],
                to_jsonb(array_to_string(ARRAY(SELECT jsonb_array_elements_text(t.data -> $2)), ', ')))
        WHERE jsonb_typeof(t.data -> $2) = 'array'`,
      [path, after.name],
      client
    );
    return rowCount ?? 0;
  }

  // Choice -> Choice: renamed options (same id, new label). Done in one
  // statement, so swapping two names works.
  if (before.type !== "choice" || after.type !== "choice") return 0;
  const newLabel = new Map(after.options!.map((o) => [o.id, o.label]));
  const renames = before
    .options!.filter((o) => newLabel.has(o.id) && newLabel.get(o.id) !== o.label)
    .map((o) => ({ from: o.label, to: newLabel.get(o.id)! }));
  if (!renames.length) return 0;
  const from = renames.map((r) => r.from);
  const to = renames.map((r) => r.to);

  const single = await query(
    `UPDATE ${table} t SET data = jsonb_set(t.data, $1::text[], to_jsonb(m.new_label))
       FROM unnest($3::text[], $4::text[]) m(old_label, new_label)
      WHERE t.data ->> $2 = m.old_label AND jsonb_typeof(t.data -> $2) = 'string'`,
    [path, after.name, from, to],
    client
  );
  const several = await query(
    `UPDATE ${table} t
        SET data = jsonb_set(t.data, $1::text[], (
              SELECT COALESCE(jsonb_agg(COALESCE(m.new_label, e.v) ORDER BY e.i), '[]'::jsonb)
                FROM jsonb_array_elements_text(t.data -> $2) WITH ORDINALITY e(v, i)
                LEFT JOIN unnest($3::text[], $4::text[]) m(old_label, new_label) ON m.old_label = e.v))
      WHERE jsonb_typeof(t.data -> $2) = 'array' AND t.data -> $2 ?| $3::text[]`,
    [path, after.name, from, to],
    client
  );
  return (single.rowCount ?? 0) + (several.rowCount ?? 0);
}
