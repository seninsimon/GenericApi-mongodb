import {
  ensureDataTable,
  isMissingTable,
  query,
  quoteIdent,
} from "../config/db.js";
import { deleteObject, UPLOAD_URL_PREFIX } from "../config/storage.js";
import { FILE_COLUMN_TYPES } from "../models/TableSchema.js";
import { getSchemaByName } from "./schemaRepository.js";

// DB row -> API record ({ _id, ...fields })
const toRecord = (row) => row && { _id: row._id, ...row.data };

// Never store _id inside the JSONB payload; it lives in its own column.
const stripId = (payload = {}) => {
  const { _id, ...data } = payload;
  return data;
};

const toFileList = (value) => {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((v) => (typeof v === "string" ? v : v?.url))
    .filter((v) => typeof v === "string" && v);
};

// "/uploads/<key>" -> delete <key> from the bucket
const removeFile = async (fileUrl) => {
  const clean = fileUrl.startsWith("/") ? fileUrl : `/${fileUrl}`;
  if (!clean.startsWith(UPLOAD_URL_PREFIX)) return;

  const key = clean.slice(UPLOAD_URL_PREFIX.length);
  if (!key) return;

  try {
    await deleteObject(key);
  } catch (err) {
    console.error("File deletion error:", err);
  }
};

const fileColumns = async (tableName) => {
  const schema = await getSchemaByName(tableName);
  return (schema?.columns ?? []).filter((c) => FILE_COLUMN_TYPES.includes(c.type));
};

const escapeLike = (value) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

export const getCollectionData = async (collectionName, options) => {
  const { search, sort, order } = options;
  const page = Math.max(1, Math.floor(options.page) || 1);
  const limit = Math.max(1, Math.floor(options.limit) || 10);
  const offset = (page - 1) * limit;
  const direction = order === "asc" ? "ASC" : "DESC";

  const table = quoteIdent(collectionName);
  const params = [];
  let where = "";

  // basic search: case-insensitive match against every field value
  if (search) {
    params.push(`%${escapeLike(search)}%`);
    where = `WHERE EXISTS (
      SELECT 1 FROM jsonb_each_text(data) kv WHERE kv.value ILIKE $${params.length}
    )`;
  }

  // default order: newest first by creation time
  const listParams = [...params];
  let orderBy = `created_at ${direction}, _id ${direction}`;
  if (sort && sort !== "_id" && sort !== "createdAt") {
    listParams.push(String(sort));
    orderBy = `data -> $${listParams.length}::text ${direction}, ${orderBy}`;
  }

  try {
    const countResult = await query(
      `SELECT count(*)::int AS total FROM ${table} ${where}`,
      params
    );

    const { rows } = await query(
      `SELECT _id, data FROM ${table} ${where}
       ORDER BY ${orderBy}
       LIMIT $${listParams.length + 1} OFFSET $${listParams.length + 2}`,
      [...listParams, limit, offset]
    );

    return {
      data: rows.map(toRecord),
      total: countResult.rows[0].total,
      page,
      limit,
    };
  } catch (error) {
    if (isMissingTable(error)) return { data: [], total: 0, page, limit };
    throw error;
  }
};

export const getRecordsByIds = async (collectionName, ids) => {
  if (!ids.length) return [];
  try {
    const { rows } = await query(
      `SELECT _id, data FROM ${quoteIdent(collectionName)} WHERE _id = ANY($1::text[])`,
      [ids.map(String)]
    );
    return rows.map(toRecord);
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
};

// [{ value: _id, label }] for relation dropdowns, sorted by label
export const getRecordOptions = async (collectionName, displayField) => {
  try {
    const { rows } = await query(
      `SELECT _id, CASE WHEN $1 = '_id' THEN _id ELSE data ->> $1 END AS label
       FROM ${quoteIdent(collectionName)}
       ORDER BY label NULLS LAST, created_at`,
      [displayField]
    );
    return rows.map((row) => ({ value: row._id, label: row.label || row._id }));
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
};

export const insertCollectionData = async (collectionName, payload) => {
  await ensureDataTable(collectionName);
  const { rows } = await query(
    `INSERT INTO ${quoteIdent(collectionName)} (data) VALUES ($1::jsonb) RETURNING _id`,
    [JSON.stringify(stripId(payload))]
  );
  return { acknowledged: true, insertedId: rows[0]._id };
};

export const updateCollectionData = async (collectionName, id, payload) => {
  const table = quoteIdent(collectionName);
  const updateData = stripId(payload);

  let oldData;
  try {
    // merge the new fields into the record and return the previous data
    const { rows } = await query(
      `UPDATE ${table} AS t
       SET data = t.data || $2::jsonb, updated_at = now()
       FROM (SELECT _id, data FROM ${table} WHERE _id = $1 FOR UPDATE) AS old
       WHERE t._id = old._id
       RETURNING old.data AS old_data`,
      [String(id), JSON.stringify(updateData)]
    );
    oldData = rows[0]?.old_data;
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }

  if (!oldData) {
    throw new Error("Record not found");
  }

  // delete files that were removed from file/image fields
  for (const col of await fileColumns(collectionName)) {
    if (!(col.name in updateData)) continue;

    const newFiles = toFileList(updateData[col.name]);
    for (const oldFile of toFileList(oldData[col.name])) {
      if (!newFiles.includes(oldFile)) await removeFile(oldFile);
    }
  }

  return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
};

export const deleteCollectionData = async (collectionName, id) => {
  let deleted;
  try {
    const { rows } = await query(
      `DELETE FROM ${quoteIdent(collectionName)} WHERE _id = $1 RETURNING data`,
      [String(id)]
    );
    deleted = rows[0]?.data;
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }

  if (!deleted) {
    return { acknowledged: true, deletedCount: 0 };
  }

  // remove the record's uploaded files
  for (const col of await fileColumns(collectionName)) {
    for (const file of toFileList(deleted[col.name])) {
      await removeFile(file);
    }
  }

  return { acknowledged: true, deletedCount: 1 };
};

export const getSingleCollectionData = async (collectionName, id) => {
  try {
    const { rows } = await query(
      `SELECT _id, data FROM ${quoteIdent(collectionName)} WHERE _id = $1`,
      [String(id)]
    );
    return toRecord(rows[0]) ?? null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
};
