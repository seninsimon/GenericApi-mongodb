import mongoose from "mongoose";

export const getCollectionData = async (collectionName, options) => {
  const { page, limit, search, sort, order } = options;

  const collection = mongoose.connection.db.collection(collectionName);

  const skip = (page - 1) * limit;

  let query = {};

  // basic search (search in all fields)
  if (search) {
    query = {
      $or: [
        { phone: { $regex: search, $options: "i" } },
        { name: { $regex: search, $options: "i" } },
      ],
    };
  }

  const total = await collection.countDocuments(query);

  const data = await collection
    .find(query)
    .sort({ [sort]: order === "asc" ? 1 : -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  return {
    data,
    total,
    page,
    limit,
  };
};

export const insertCollectionData = async (collectionName, payload) => {
  const collection = mongoose.connection.db.collection(collectionName);
  const result = await collection.insertOne(payload);
  return result;
};

export const updateCollectionData = async (collectionName, id, payload) => {
  const collection = mongoose.connection.db.collection(collectionName);
  console.log("Updating collection:", collection);
  return await collection.updateOne(
    { _id: new mongoose.Types.ObjectId(id) },
    { $set: payload },
  );
};

export const deleteCollectionData = async (collectionName, id) => {
  const collection = mongoose.connection.db.collection(collectionName);
  return await collection.deleteOne({
    _id: new mongoose.Types.ObjectId(id),
  });
};

export const getSingleCollectionData = async (collectionName, id) => {
  const collection = mongoose.connection.db.collection(collectionName);
  const data = await collection.findOne({
    _id: new mongoose.Types.ObjectId(id),
  });
  return data;
};
