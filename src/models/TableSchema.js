import mongoose from "mongoose";

const columnSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },

  label: {
    type: String,
  },

  type: {
    type: String,
    enum: ["text", "number", "date", "boolean", "relation", "options"],
    default: "text",
  },

  required: {
    type: Boolean,
    default: false,
  },

  // for dropdown fields
  options: {
    type: [String],
    default: [],
  },

  // show column in table view
  showInTable: {
    type: Boolean,
    default: true,
  },

  // relation table name
  ref: {
    type: String,
    default: null,
  },

  // support multi select relation
  multiple: {
    type: Boolean,
    default: false,
  },

  displayField: String,
});

const tableSchema = new mongoose.Schema(
  {
    tableName: {
      type: String,
      required: true,
      unique: true,
    },

    columns: [columnSchema],
  },
  {
    timestamps: true,
  },
);

export default mongoose.model("TableSchema", tableSchema);
