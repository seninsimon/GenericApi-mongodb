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

export const getTables = async (req, res) => {
  const data = await fetchTables();
  res.json(data);
};

export const getTableSchema = async (req, res) => {
  const { table } = req.params;
  const data = await fetchTableSchema(table);
  res.json(data);
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
    console.error(error);
    res.status(500).json({
      message: "Failed to update column",
    });
  }
};