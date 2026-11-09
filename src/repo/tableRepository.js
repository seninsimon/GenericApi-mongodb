import { dataTable, ensureDataTable, isMissingTable, query } from "../config/db.js";
import { deleteObject, UPLOAD_URL_PREFIX } from "../config/storage.js";
import { FILE_COLUMN_TYPES } from "../models/TableSchema.js";
import { getSchemaByName } from "./schemaRepository.js";

// DB row -> API record ({ _id, ...fields, _departmentId })
const toRecord = (row) =>
  row && { _id: row._id, ...row.data, _departmentId: row.department_id ?? null };

// Keys that live in their own columns (or are display-only), never inside data.
const META_KEYS = ["_id", "_departmentId", "_department", "__v"];
const stripMeta = (payload = {}) =>
  Object.fromEntries(Object.entries(payload).filter(([key]) => !META_KEYS.includes(key)));

// SQL condition limiting records to departmentIds (null = no limit, for admins).
const departmentScope = (params, departmentIds, alias = "t") => {
  if (departmentIds == null) return "TRUE";
  params.push(departmentIds);
  return `${alias}.department_id = ANY($${params.length}::text[])`;
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

export const removeUploadedFiles = async (fileUrls) => {
  for (const url of fileUrls) await removeFile(url);
};

const fileColumns = async (tableName) => {
  const schema = await getSchemaByName(tableName);
  return (schema?.columns ?? []).filter((c) => FILE_COLUMN_TYPES.includes(c.type));
};

const escapeLike = (value) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

// options.departmentIds: only records in these departments (null = all, for admins)
export const getCollectionData = async (collectionName, options) => {
  const { search, sort, order, departmentIds = null } = options;
  const page = Math.max(1, Math.floor(options.page) || 1);
  const limit = Math.max(1, Math.floor(options.limit) || 10);
  const offset = (page - 1) * limit;
  const direction = order === "asc" ? "ASC" : "DESC";

  const table = dataTable(collectionName);
  const params = [];
  const conditions = [departmentScope(params, departmentIds)];

  // basic search: case-insensitive match against every field value
  if (search) {
    params.push(`%${escapeLike(search)}%`);
    conditions.push(`EXISTS (
      SELECT 1 FROM jsonb_each_text(t.data) kv WHERE kv.value ILIKE $${params.length}
    )`);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;

  // default order: newest first by creation time
  const listParams = [...params];
  let orderBy = `t.created_at ${direction}, t._id ${direction}`;
  if (sort && sort !== "_id" && sort !== "createdAt") {
    listParams.push(String(sort));
    orderBy = `t.data -> $${listParams.length}::text ${direction}, ${orderBy}`;
  }

  try {
    const countResult = await query(
      `SELECT count(*)::int AS total FROM ${table} t ${where}`,
      params
    );

    const { rows } = await query(
      `SELECT t._id, t.data, t.department_id, d.name AS department_name
       FROM ${table} t
       LEFT JOIN departments d ON d._id = t.department_id
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${listParams.length + 1} OFFSET $${listParams.length + 2}`,
      [...listParams, limit, offset]
    );

    return {
      data: rows.map((row) => ({
        ...toRecord(row),
        _departmentName: row.department_name ?? null,
      })),
      total: countResult.rows[0].total,
      page,
      limit,
    };
  } catch (error) {
    if (isMissingTable(error)) return { data: [], total: 0, page, limit };
    throw error;
  }
};

export const getRecordsByIds = async (collectionName, ids, departmentIds = null) => {
  if (!ids.length) return [];
  try {
    const params = [ids.map(String)];
    const { rows } = await query(
      `SELECT t._id, t.data, t.department_id FROM ${dataTable(collectionName)} t
       WHERE t._id = ANY($1::text[]) AND ${departmentScope(params, departmentIds)}`,
      params
    );
    return rows.map(toRecord);
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
};

// [{ value: _id, label }] for relation dropdowns, sorted by label
export const getRecordOptions = async (collectionName, displayField, departmentIds = null) => {
  try {
    const params = [displayField];
    const { rows } = await query(
      `SELECT t._id, CASE WHEN $1 = '_id' THEN t._id ELSE t.data ->> $1 END AS label
       FROM ${dataTable(collectionName)} t
       WHERE ${departmentScope(params, departmentIds)}
       ORDER BY label NULLS LAST, t.created_at`,
      params
    );
    return rows.map((row) => ({ value: row._id, label: row.label || row._id }));
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
};

export const insertCollectionData = async (collectionName, payload, departmentId = null) => {
  await ensureDataTable(collectionName);
  const { rows } = await query(
    `INSERT INTO ${dataTable(collectionName)} (data, department_id)
     VALUES ($1::jsonb, $2) RETURNING _id`,
    [JSON.stringify(stripMeta(payload)), departmentId]
  );
  return { acknowledged: true, insertedId: rows[0]._id };
};

// options.departmentIds: records the user may change (null = any)
// options.newDepartmentId: undefined = keep the record's department, else move it there
// Returns null when the record doesn't exist or is outside departmentIds.
export const updateCollectionData = async (collectionName, id, payload, options = {}) => {
  const { departmentIds = null, newDepartmentId } = options;
  const table = dataTable(collectionName);
  const updateData = stripMeta(payload);

  let oldData;
  try {
    // merge the new fields into the record and return the previous data
    const params = [
      String(id),
      JSON.stringify(updateData),
      newDepartmentId !== undefined,
      newDepartmentId ?? null,
    ];
    const { rows } = await query(
      `UPDATE ${table} AS t
       SET data = t.data || $2::jsonb,
           department_id = CASE WHEN $3 THEN $4 ELSE t.department_id END,
           updated_at = now()
       FROM (
         SELECT t._id, t.data FROM ${table} t
         WHERE t._id = $1 AND ${departmentScope(params, departmentIds)}
         FOR UPDATE
       ) AS old
       WHERE t._id = old._id
       RETURNING old.data AS old_data`,
      params
    );
    oldData = rows[0]?.old_data;
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }

  if (!oldData) return null;

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

export const deleteCollectionData = async (collectionName, id, departmentIds = null) => {
  let deleted;
  try {
    const params = [String(id)];
    const { rows } = await query(
      `DELETE FROM ${dataTable(collectionName)} t
       WHERE t._id = $1 AND ${departmentScope(params, departmentIds)}
       RETURNING t.data`,
      params
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

// Records with no department (e.g. created before departments existed).
export const countUnassignedRecords = async (collectionName) => {
  try {
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM ${dataTable(collectionName)} WHERE department_id IS NULL`
    );
    return rows[0].n;
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
};

export const assignUnassignedRecords = async (collectionName, departmentId) => {
  const { rowCount } = await query(
    `UPDATE ${dataTable(collectionName)}
     SET department_id = $1, updated_at = now()
     WHERE department_id IS NULL`,
    [departmentId]
  );
  return rowCount;
};

export const getSingleCollectionData = async (collectionName, id, departmentIds = null) => {
  try {
    const params = [String(id)];
    const { rows } = await query(
      `SELECT t._id, t.data, t.department_id FROM ${dataTable(collectionName)} t
       WHERE t._id = $1 AND ${departmentScope(params, departmentIds)}`,
      params
    );
    return toRecord(rows[0]) ?? null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
};
