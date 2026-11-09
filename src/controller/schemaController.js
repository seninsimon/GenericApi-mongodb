import { allowedDepartments, can, isAdmin, tablePermissions } from "../auth/access.js";
import { countUnassignedRecords, removeUploadedFiles } from "../repo/tableRepository.js";
import { deleteTableSchema, findRelationsTo } from "../repo/schemaRepository.js";
import { FILE_COLUMN_TYPES } from "../models/TableSchema.js";
import { HttpError } from "./validation.js";
import { ValidationError } from "../models/TableSchema.js";
import { updateColumnInSchema } from "../repo/schemaRepository.js";
import {
  createTable,
  fetchTables,
  fetchTableSchema,
  addTableColumn,
  removeTableColumn,
} from "../services/schemaService.js";

export const createNewTable = async (req, res) => {
  try {
    const data = await createTable(req.body);

    res.json({
      message: "Table created",
      data,
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ message: error.message });
    }
    // 23505 = unique_violation on table_name
    if (error.code === "23505") {
      return res.status(409).json({ message: "Table already exists" });
    }
    console.error(error);
    res.status(500).json({ message: "Error creating table" });
  }
};

// Adds what the current user may do with the table:
//   permissions: { view, create, edit, delete }
//   allowedDepartments: departments the user can file records under
const withAccess = (user, schema) => ({
  ...schema,
  permissions: tablePermissions(user, schema),
  allowedDepartments: allowedDepartments(user, schema),
});

// Admins get every table; other users only the tables they can view.
export const getTables = async (req, res) => {
  const tables = await fetchTables();
  res.json(
    tables
      .filter((schema) => can(req.user, schema, "view"))
      .map((schema) => withAccess(req.user, schema))
  );
};

export const getTableSchema = async (req, res) => {
  const { table } = req.params;
  const schema = await fetchTableSchema(table);
  if (!schema || !can(req.user, schema, "view")) {
    return res.status(404).json({ message: "Table not found" });
  }
  const result = withAccess(req.user, schema);
  // admins: how many records still need a department
  if (isAdmin(req.user)) result.unassignedCount = await countUnassignedRecords(table);
  res.json(result);
};

// DELETE /schema/:table (admin): drops the table with all its records and files.
export const deleteTable = async (req, res) => {
  const { table } = req.params;
  const schema = await fetchTableSchema(table);
  if (!schema) throw new HttpError(404, "Table not found");

  // don't leave relation columns in other tables pointing at nothing
  const references = await findRelationsTo(table);
  if (references.length) {
    const list = references.map((r) => `${r.tableName}.${r.column}`).join(", ");
    throw new HttpError(
      409,
      `Other tables link to "${table}" (${list}). Delete those relation columns first.`
    );
  }

  const fileColumns = schema.columns
    .filter((c) => FILE_COLUMN_TYPES.includes(c.type))
    .map((c) => c.name);

  const fileUrls = await deleteTableSchema(table, fileColumns);
  await removeUploadedFiles(fileUrls);

  res.json({ message: `Table "${table}" deleted`, deletedFiles: fileUrls.length });
};

export const addColumnToTable = async (req, res) => {
  const { table } = req.params;

  const data = await addTableColumn(table, req.body);

  res.json({
    message: "Column added",
    data,
  });
};

export const deleteColumnFromTable = async (req, res) => {
  const { table, column } = req.params;

  const data = await removeTableColumn(table, column);

  res.json({
    message: "Column removed",
    data,
  });
};


export const updateColumn = async (req, res) => {
  try {
    const { table, name } = req.params;
    const payload = req.body;

    const result = await updateColumnInSchema(table, name, payload);

    res.json({
      message: "Column updated successfully",
      result,
    });

  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ message: error.message });
    }
    console.error(error);
    res.status(500).json({
      message: "Failed to update column",
    });
  }
};