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