import TableSchema from "../models/TableSchema.js";
import {
  createTableData,
  fectchSingleTableData,
  fetchTableData,
  modifyTableData,
  removeTableData,
} from "../services/tableService.js";
import mongoose from "mongoose";

export const getTableData = async (req, res) => {
  try {
    const { collection } = req.params;

    const {
      page = 1,
      limit = 10,
      search = "",
      sort = "_id",
      order = "desc",
    } = req.query;

    // fetch table schema
    const schema = await TableSchema.findOne({ tableName: collection });

    if (!schema) {
      return res.status(404).json({ message: "Table schema not found" });
    }

    const visibleColumns = schema.columns.filter((col) => col.showInTable);

    const relationColumns = schema.columns.filter(
      (col) => col.type === "relation" && col.ref
    );

    const result = await fetchTableData(collection, {
      page: Number(page),
      limit: Number(limit),
      search,
      sort,
      order,
    });

    const filteredData = await Promise.all(
      result.data.map(async (row) => {
        const filteredRow = { _id: row._id };

        // normal fields
        for (const col of visibleColumns) {
          const value = row[col.name];

          if (value !== undefined) {
            filteredRow[col.label || col.name] = value;
          }
        }

        // relation populate (return only name)
        for (const relation of relationColumns) {
          const value = row[relation.name];

          if (value) {
            const refData = await mongoose.connection
              .collection(relation.ref)
              .findOne({
                _id: new mongoose.Types.ObjectId(value),
              });

            filteredRow[relation.label || relation.name] =
              refData?.name || "";
          }
        }

        return filteredRow;
      })
    );

    res.json({
      ...result,
      data: filteredData,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Server error",
    });
  }
};

export const insertTableData = async (req, res) => {
  try {
    const { collection } = req.params;
    const payload = req.body;

    const data = await createTableData(collection, payload);

    res.json({
      message: "Data inserted successfully",
      data,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to insert data",
    });
  }
};

export const updateTableData = async (req, res) => {
  try {
    const { collection, id } = req.params;
    const payload = req.body;

    const result = await modifyTableData(collection, id, payload);

    res.json({
      message: "Updated successfully",
      result,
    });
  } catch (error) {
    console.error("Update Error:", error);

    res.status(500).json({
      message: error.message,
    });
  }
};

export const deleteTableData = async (req, res) => {
  try {
    const { collection, id } = req.params;

    const result = await removeTableData(collection, id);

    res.json({
      message: "Deleted successfully",
      result,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to delete data",
    });
  }
};

export const getSingleTableData = async (req, res) => {
  try {
    const { collection, id } = req.params;

    const data = await fectchSingleTableData(collection, id);

    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to fetch single table data",
    });
  }
};
