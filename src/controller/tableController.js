import TableSchema from "../models/TableSchema.js";
import {
  createTableData,
  fectchSingleTableData,
  fetchTableData,
  modifyTableData,
  removeTableData,
  updateTableSettingsService
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

    const schema = await TableSchema.findOne({ tableName: collection });

    if (!schema) {
      return res.status(404).json({ message: "Table schema not found" });
    }

    const visibleColumns = schema.columns.filter((col) => col.showInTable);

    const relationColumns = schema.columns.filter(
      (col) => col.type === "relation" && col.ref,
    );

    const result = await fetchTableData(collection, {
      page: Number(page),
      limit: Number(limit),
      search,
      sort,
      order,
    });

    const rows = result.data;

    const relationIds = {};

    for (const relation of relationColumns) {
      relationIds[relation.name] = new Set();
    }

    for (const row of rows) {
      for (const relation of relationColumns) {
        const value = row[relation.name];

        if (!value) continue;

        if (Array.isArray(value)) {
          value.forEach((id) => relationIds[relation.name].add(id));
        } else {
          relationIds[relation.name].add(value);
        }
      }
    }

    const relationMaps = {};

    for (const relation of relationColumns) {
      const ids = Array.from(relationIds[relation.name]);
      if (!ids.length) continue;
      const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
      const refCollection = relation.ref;
      const refSchema = await TableSchema.findOne({ tableName: refCollection });
      const displayColumn =
        refSchema?.columns.find((c) => c.showInTable)?.name || "_id";

      const refData = await mongoose.connection
        .collection(refCollection)
        .find({ _id: { $in: objectIds } })
        .toArray();

      const map = {};

      for (const item of refData) {
        map[item._id.toString()] = item[displayColumn] || item._id.toString();
      }

      relationMaps[relation.name] = map;
    }

    const filteredData = rows.map((row) => {
      const filteredRow = { _id: row._id };

      for (const col of visibleColumns) {
        const value = row[col.name];

        if (col.type !== "relation") {
          filteredRow[col.label || col.name] = value;
          continue;
        }

        const relationMap = relationMaps[col.name] || {};

        if (Array.isArray(value)) {
          filteredRow[col.label || col.name] = value.map(
            (id) => relationMap[id] || id,
          );
        } else {
          filteredRow[col.label || col.name] =
            relationMap[value] || value || "";
        }
      }

      return filteredRow;
    });

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





export const updateTableSettings = async (req, res) => {
  try {
    const { table } = req.params;
    const { showInMenu } = req.body;

    const updated = await updateTableSettingsService(table, showInMenu);

    res.json({
      message: "Table settings updated",
      data: updated,
    });
  } catch (error) {
  
    res.status(500).json({
      message: "Failed to update table settings",
    });
  }
};