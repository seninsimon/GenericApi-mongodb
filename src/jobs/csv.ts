import { htmlToText } from "../lib/text.js";
import type { Column } from "../types.js";

// CSV conventions shared by export and import, so files round-trip:
//   header = column labels (import also accepts names), plus "Visible to" (the
//   record's departments, separated by ";"; only for tables shared with several
//   departments; import also accepts the old header "Department")
//   multiple values (multi-relations, several choices, images, files) separated by ";"
//   choices as the option label (import ignores case)
//   relations exported as the linked record's display label (import also accepts ids)
//   users exported as their name (import also accepts usernames and ids)
//   department columns exported as the department name (import also accepts ids)
//   "Created by" is exported for information and skipped on import
//   booleans true/false (import also accepts yes/no/1/0)

export const DEPARTMENT_HEADER = "Visible to";
export const LEGACY_DEPARTMENT_HEADER = "Department";
export const CREATED_BY_HEADER = "Created by";
export const LIST_SEPARATOR = ";";

// Spreadsheet apps run cells starting with = + - @ as formulas; prefix such
// text with ' so an exported file can't execute anything when opened.
const neutralizeFormula = (text: string) =>
  /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;

// `labels` maps ids to names for relation and user columns.
export function formatCell(column: Column, value: unknown, labels?: Map<string, string>): string {
  if (value === null || value === undefined) return "";
  const list = Array.isArray(value) ? value : [value];

  let text: string;
  switch (column.type) {
    case "relation":
    case "user":
    case "department":
      text = list.map((id) => labels?.get(String(id)) ?? String(id)).join(LIST_SEPARATOR);
      break;
    case "richtext":
      text = String(htmlToText(value));
      break;
    case "images":
    case "files":
    case "choice":
      text = list.map(String).join(LIST_SEPARATOR);
      break;
    case "boolean":
      text = value === true ? "true" : value === false ? "false" : String(value);
      break;
    default:
      text = typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  return neutralizeFormula(text);
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0"]);

const splitList = (cell: string) =>
  cell
    .split(LIST_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);

// Turn a CSV cell into the value the API would receive from the form.
// Relations are returned as label/id strings and resolved by the importer.
export function parseCell(column: Column, raw: string): unknown {
  const cell = raw.trim().replace(/^'(?=[=+\-@])/, ""); // undo neutralizeFormula
  if (cell === "") return null;

  switch (column.type) {
    case "number":
      return Number(cell);
    case "boolean": {
      const word = cell.toLowerCase();
      return TRUE_WORDS.has(word) ? true : FALSE_WORDS.has(word) ? false : cell;
    }
    case "relation":
    case "user":
    case "department":
    case "images":
    case "files":
      return splitList(cell);
    case "choice":
      return column.multiple ? splitList(cell) : cell;
    default:
      return cell;
  }
}
