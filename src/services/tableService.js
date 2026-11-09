import {
  deleteCollectionData,
  getCollectionData,
  getSingleCollectionData,
  insertCollectionData,
  updateCollectionData,
} from "../repo/tableRepository.js";
import { updateTableSettings } from "../repo/schemaRepository.js";

export const fetchTableData = (collectionName, options) =>
  getCollectionData(collectionName, options);

export const createTableData = (collectionName, payload, departmentId) =>
  insertCollectionData(collectionName, payload, departmentId);

export const modifyTableData = (collection, id, payload, options) =>
  updateCollectionData(collection, id, payload, options);

export const removeTableData = (collection, id, departmentIds) =>
  deleteCollectionData(collection, id, departmentIds);

export const fectchSingleTableData = (collection, id, departmentIds) =>
  getSingleCollectionData(collection, id, departmentIds);

export const updateTableSettingsService = (table, settings) =>
  updateTableSettings(table, settings);
