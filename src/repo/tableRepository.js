  import mongoose from "mongoose";

  export const getCollectionData = async (collectionName) => {
    const collection = mongoose.connection.db.collection(collectionName);
    const data = await collection.find({}).limit(100).toArray();
    return data;
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
      { $set: payload }
    );
  };

  export const deleteCollectionData = async (collectionName, id) => {
    const collection = mongoose.connection.db.collection(collectionName);
    return await collection.deleteOne({
      _id: new mongoose.Types.ObjectId(id),
    });
  };

  export const getSingleCollecitonData = async (collectionName, id) => {
    const collection = mongoose.connection.db.collection(collectionName);
    const data = await collection.findOne({
      _id: new mongoose.Types.ObjectId(id),
    });
    return data;
  };
