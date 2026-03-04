import {
  createTableData,
  fectchSingleTableData,
  fetchTableData,
  modifyTableData,
  removeTableData,
} from "../services/tableService.js";

export const getTableData = async (req, res) => {
  try {
    const { collection } = req.params;

    const data = await fetchTableData(collection);

    res.json(data);
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
    console.error(error);
    res.status(500).json({
      message: "Failed to update data",
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

export const  getSingleTableData = async (req, res) => {
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
