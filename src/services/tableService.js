import {
  deleteCollectionData,
  getCollectionData,
  getSingleCollecitonData,
  insertCollectionData,
  updateCollectionData,
} from "../repo/tableRepository.js";

export const fetchTableData = async (collectionName) => {
  const data = await getCollectionData(collectionName);
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
  return await getSingleCollecitonData(collection, id);
}
