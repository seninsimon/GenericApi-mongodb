import {
  createTableSchema,
  getAllSchemas,
  getSchemaByName,
  addColumn,
  deleteColumn,
} from "../repo/core/schemaRepository.js";

export const createTable = async (payload) => {
  return await createTableSchema(payload);
};

export const fetchTables = async () => {
  return await getAllSchemas();
};

export const fetchTableSchema = async (tableName) => {
  return await getSchemaByName(tableName);
};

export const addTableColumn = async (tableName, column) => {
  return await addColumn(tableName, column);
};

export const removeTableColumn = async (tableName, columnName) => {
  return await deleteColumn(tableName, columnName);
};