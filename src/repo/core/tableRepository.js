import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import TableSchema from "../../models/TableSchema.js";

export const getCollectionData = async (collectionName, options) => {
  const { page, limit, search, sort, order } = options;

  const collection = mongoose.connection.db.collection(collectionName);

  const skip = (page - 1) * limit;

  let query = {};

  // basic search (search in all fields)
if (search) {
  const sample = await collection.findOne();

  if (sample) {
    const fields = Object.keys(sample).filter(
      (key) => key !== "_id" && key !== "__v"
    );

    query = {
      $or: fields.map((field) => ({
        [field]: { $regex: search, $options: "i" },
      })),
    };
  }
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
  const objectId = new mongoose.Types.ObjectId(id);

  // remove _id from payload
  const { _id, ...updateData } = payload;

  // find existing record
  const existing = await collection.findOne({ _id: objectId });

  if (!existing) {
    throw new Error("Record not found");
  }

  // get schema to detect file fields
  const schema = await TableSchema.findOne({ tableName: collectionName });

  if (schema) {
    for (const col of schema.columns) {
      if (
        col.type === "image" ||
        col.type === "images" ||
        col.type === "file" ||
        col.type === "files"
      ) {
        const oldValue = existing[col.name];
        const newValue = updateData[col.name];

        // if no old files exist, nothing to delete
        if (!oldValue) continue;

        // normalize old files
        const oldFiles = Array.isArray(oldValue) ? oldValue : [oldValue];

        // normalize new files
        const newFiles = !newValue
          ? []
          : Array.isArray(newValue)
          ? newValue
          : [newValue];

        for (const oldFile of oldFiles) {
          if (!newFiles.includes(oldFile)) {
            try {
              const cleanPath = oldFile.startsWith("/")
                ? oldFile.slice(1)
                : oldFile;

              const fullPath = path.join(process.cwd(), cleanPath);

              if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
              }
            } catch (err) {
              console.error("File deletion error:", err);
            }
          }
        }
      }
    }
  }

  // update record
  return await collection.updateOne(
    { _id: objectId },
    { $set: updateData }
  );
};

export const deleteCollectionData = async (collectionName, id) => {
  const collection = mongoose.connection.db.collection(collectionName);

  const objectId = new mongoose.Types.ObjectId(id);

  // find record first
  const record = await collection.findOne({ _id: objectId });

  if (!record) {
    return { deletedCount: 0 };
  }

  // get schema to identify file/image fields
  const schema = await TableSchema.findOne({ tableName: collectionName });

  if (schema) {
    for (const col of schema.columns) {
      if (
        col.type === "image" ||
        col.type === "images" ||
        col.type === "file" ||
        col.type === "files"
      ) {
        const value = record[col.name];

        if (!value) continue;

        const files = Array.isArray(value) ? value : [value];

        for (const filePath of files) {
          const cleanPath = filePath.startsWith("/")
            ? filePath.slice(1)
            : filePath;

          const fullPath = path.join(process.cwd(), cleanPath);

          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
          }
        }
      }
    }
  }

  // delete record from MongoDB
  return await collection.deleteOne({ _id: objectId });
};

export const getSingleCollectionData = async (collectionName, id) => {
  const collection = mongoose.connection.db.collection(collectionName);
  const data = await collection.findOne({
    _id: new mongoose.Types.ObjectId(id),
  });
  return data;
};


export const updateTableSettingsRepo = async (table, showInMenu) => {
  return await TableSchema.findOneAndUpdate(
    { tableName: table },
    { showInMenu },
    { returnDocument: "after" }
  );
};
