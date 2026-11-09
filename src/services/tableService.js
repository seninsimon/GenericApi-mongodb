import {
  deleteCollectionData,
  getCollectionData,
  getSingleCollectionData,
  insertCollectionData,
  updateCollectionData,
} from "../repo/tableRepository.js";
import { updateTableSettings } from "../repo/schemaRepository.js";

export const fetchTableData = async (collectionName, options) => {
  const data = await getCollectionData(collectionName, options);
  return data;
};

export const createTableData = async (collectionName, payload) => {
  return await insertCollectionData(collectionName, payload);
};

export const modifyTableData = (collection, id, payload) => {
  return updateCollectionData(collection, id, payload);
};

export const removeTableData = (collection, id) => {
  return deleteCollectionData(collection, id);
};

export const fectchSingleTableData = async (collection, id) => {
  return await getSingleCollectionData(collection, id);
};

export const updateTableSettingsService = async (table, showInMenu) => {
  return await updateTableSettings(table, showInMenu);
};
