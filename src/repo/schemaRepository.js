import TableSchema from "../models/TableSchema.js";

export const createTableSchema = async (data) => {
  return await TableSchema.create(data);
};

export const getAllSchemas = async () => {
  return await TableSchema.find();
};

export const getSchemaByName = async (tableName) => {
  return await TableSchema.findOne({ tableName });
};

export const addColumn = async (tableName, column) => {
  return await TableSchema.updateOne(
    { tableName },
    { $push: { columns: column } }
  );
};

export const deleteColumn = async (tableName, columnName) => {
  return await TableSchema.updateOne(
    { tableName },
    { $pull: { columns: { name: columnName } } }
  );
};