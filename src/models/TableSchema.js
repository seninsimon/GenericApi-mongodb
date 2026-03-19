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
    enum: [
      "text",
      "number",
      "date",
      "boolean",
      "relation",
      "image",
      "images",
      "file",
      "files",
      "richText",
      "textarea",
    ],
    default: "text",
  },

  showInTable: {
    type: Boolean,
    default: true,
  },

  ref: {
    type: String,
    default: null,
  },

  multiple: {
    type: Boolean,
    default: false,
  },

  displayField: String,


  fileConfig: {
    accept: {
      type: [String],
      default: [],
    },
    maxSize: {
      type: Number,
      default: 5,
    },
    maxFiles: {
      type: Number,
      default: 1,
    },
  },

  uploadPath: {
    type: String,
    default: "uploads",
  },
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
