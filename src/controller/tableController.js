import {
  allowedDepartments,
  can,
  departmentFilter,
  isAdmin,
} from "../auth/access.js";
import { pickDisplayField } from "../models/TableSchema.js";
import { getSchemaByName } from "../repo/schemaRepository.js";
import {
  assignUnassignedRecords,
  getRecordOptions,
  getRecordsByIds,
} from "../repo/tableRepository.js";
import { existingDepartmentIds } from "../repo/userRepository.js";
import {
  createTableData,
  fectchSingleTableData,
  fetchTableData,
  modifyTableData,
  removeTableData,
  updateTableSettingsService,
} from "../services/tableService.js";
import { HttpError, toIdList } from "./validation.js";

const ACTION_VERBS = { view: "view", create: "add", edit: "edit", delete: "delete" };

// Loads the table schema and checks the user may perform `action` on it.
// Tables the user can't see at all are reported as 404 so they stay hidden.
const loadTable = async (req, action) => {
  const schema = await getSchemaByName(req.params.collection);
  if (!schema || !can(req.user, schema, "view")) {
    throw new HttpError(404, "Table not found");
  }
  if (!can(req.user, schema, action)) {
    throw new HttpError(
      403,
      `You don't have permission to ${ACTION_VERBS[action]} records in this table`
    );
  }
  return schema;
};

// Decide which department a created/edited record goes to.
// requested: value of payload._departmentId (undefined = not sent).
// Returns undefined to leave an existing record's department unchanged.
const resolveDepartment = (user, schema, requested, { creating }) => {
  const allowed = allowedDepartments(user, schema).map((d) => d._id);

  if (requested === undefined) {
    if (!creating) return undefined;
    if (allowed.length === 1) return allowed[0];
    if (allowed.length === 0 && isAdmin(user)) return null;
    throw new HttpError(400, "Please choose a department for this record");
  }

  if (requested === null || requested === "") {
    if (isAdmin(user)) return null; // admins may leave records unassigned
    throw new HttpError(400, "Please choose a department for this record");
  }

  if (!allowed.includes(requested)) {
    throw new HttpError(400, "You can't assign records to that department");
  }
  return requested;
};

// Rich text is stored as HTML; the list shows a short plain-text preview.
const HTML_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const htmlToPreview = (html, maxLength = 120) => {
  if (typeof html !== "string") return html;
  const text = html
    .replace(/<(br|\/p|\/h\d|\/li)\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => HTML_ENTITIES[entity])
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
};

// Show a Department column when the user works with more than one department here.
const showDepartmentColumn = (user, schema) =>
  isAdmin(user) || allowedDepartments(user, schema).length > 1;

export const getTableData = async (req, res) => {
  const { collection } = req.params;
  const schema = await loadTable(req, "view");

  const {
    page = 1,
    limit = 10,
    search = "",
    sort = "_id",
    order = "desc",
  } = req.query;

  const visibleColumns = schema.columns.filter((col) => col.showInTable);
  const relationColumns = schema.columns.filter((col) => col.type === "relation" && col.ref);

  // the table UI sorts by column label; records are keyed by column name
  const sortColumn = schema.columns.find((col) => col.name === sort || col.label === sort);

  const result = await fetchTableData(collection, {
    page: Number(page),
    limit: Number(limit),
    search,
    sort: sortColumn ? sortColumn.name : sort,
    order,
    departmentIds: departmentFilter(req.user, schema),
  });

  const rows = result.data;

  // resolve relation ids to display names, only for records the user may see
  const relationMaps = {};
  for (const relation of relationColumns) {
    const ids = new Set();
    for (const row of rows) {
      const value = row[relation.name];
      if (Array.isArray(value)) value.forEach((id) => id && ids.add(id));
      else if (value) ids.add(value);
    }
    if (!ids.size) continue;

    const refSchema = await getSchemaByName(relation.ref);
    if (!can(req.user, refSchema, "view")) continue;

    const displayColumn = pickDisplayField(refSchema, relation.displayField);
    const refData = await getRecordsByIds(
      relation.ref,
      [...ids],
      departmentFilter(req.user, refSchema)
    );

    const map = {};
    for (const item of refData) {
      map[item._id] = item[displayColumn] || item._id;
    }
    relationMaps[relation.name] = map;
  }

  const withDepartment = showDepartmentColumn(req.user, schema);
  const relationLabel = (map, id) => (id ? (map[id] ?? "—") : "");

  const filteredData = rows.map((row) => {
    const filteredRow = { _id: row._id };

    for (const col of visibleColumns) {
      const value = row[col.name];
      const key = col.label || col.name;

      if (col.type === "richtext" || col.type === "richText") {
        filteredRow[key] = htmlToPreview(value);
        continue;
      }

      if (col.type !== "relation") {
        filteredRow[key] = value;
        continue;
      }

      const map = relationMaps[col.name] || {};
      filteredRow[key] = Array.isArray(value)
        ? value.map((id) => relationLabel(map, id))
        : relationLabel(map, value);
    }

    if (withDepartment) {
      filteredRow._department = row._departmentName ?? "Unassigned";
    }

    return filteredRow;
  });

  res.json({ ...result, data: filteredData });
};

// GET /table/:collection/options -> [{ value, label }] for relation dropdowns
export const getTableOptions = async (req, res) => {
  const { collection } = req.params;
  const schema = await loadTable(req, "view");

  const displayField = pickDisplayField(schema, req.query.displayField);
  res.json(await getRecordOptions(collection, displayField, departmentFilter(req.user, schema)));
};

export const insertTableData = async (req, res) => {
  const { collection } = req.params;
  const schema = await loadTable(req, "create");
  const payload = req.body ?? {};

  const departmentId = resolveDepartment(req.user, schema, payload._departmentId, {
    creating: true,
  });
  const data = await createTableData(collection, payload, departmentId);

  res.json({ message: "Data inserted successfully", data });
};

export const updateTableData = async (req, res) => {
  const { collection, id } = req.params;
  const schema = await loadTable(req, "edit");
  const payload = req.body ?? {};

  const newDepartmentId = resolveDepartment(req.user, schema, payload._departmentId, {
    creating: false,
  });

  const result = await modifyTableData(collection, id, payload, {
    departmentIds: departmentFilter(req.user, schema),
    newDepartmentId,
  });
  if (!result) throw new HttpError(404, "Record not found");

  res.json({ message: "Updated successfully", result });
};

export const deleteTableData = async (req, res) => {
  const { collection, id } = req.params;
  const schema = await loadTable(req, "delete");

  const result = await removeTableData(collection, id, departmentFilter(req.user, schema));
  if (!result.deletedCount) throw new HttpError(404, "Record not found");

  res.json({ message: "Deleted successfully", result });
};

export const getSingleTableData = async (req, res) => {
  const { collection, id } = req.params;
  const schema = await loadTable(req, "view");

  const data = await fectchSingleTableData(collection, id, departmentFilter(req.user, schema));
  if (!data) throw new HttpError(404, "Record not found");

  res.json(data);
};

// PUT /schema/:table/unassigned { departmentId } (admin only)
// Moves every record without a department into departmentId.
export const assignUnassigned = async (req, res) => {
  const { table } = req.params;
  const schema = await getSchemaByName(table);
  if (!schema) throw new HttpError(404, "Table not found");

  const { departmentId } = req.body ?? {};
  if (!schema.departments.some((d) => d._id === departmentId)) {
    throw new HttpError(400, "Choose one of this table's departments");
  }

  const updated = await assignUnassignedRecords(table, departmentId);
  res.json({ message: `${updated} record(s) assigned`, updated });
};

// PUT /schema/:table { showInMenu?, departmentIds? } (admin only)
export const updateTableSettings = async (req, res) => {
  const { table } = req.params;
  const { showInMenu } = req.body ?? {};

  let departmentIds;
  if (req.body?.departmentIds !== undefined) {
    departmentIds = toIdList(req.body.departmentIds);
    const found = await existingDepartmentIds(departmentIds);
    if (found.length !== departmentIds.length) {
      throw new HttpError(400, "Unknown department selected");
    }
  }

  const updated = await updateTableSettingsService(table, { showInMenu, departmentIds });
  if (!updated) throw new HttpError(404, "Table not found");

  res.json({ message: "Table settings updated", data: updated });
};
