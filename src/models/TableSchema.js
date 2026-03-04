import mongoose from "mongoose";

const columnSchema = new mongoose.Schema({
  name: { type: String, required: true },
  label: { type: String },
  type: {
    type: String,
    enum: ["text", "number", "date", "select", "boolean"],
    default: "text",
  },
  required: { type: Boolean, default: false },
  options: [String],
});

const tableSchema = new mongoose.Schema(
  {
    tableName: { type: String, required: true, unique: true },
    columns: [columnSchema],
  },
  { timestamps: true }
);

export default mongoose.model("TableSchema", tableSchema);