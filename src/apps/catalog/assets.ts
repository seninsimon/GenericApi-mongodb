import { autonum, choice, date, link, longText, managerRole, num, rollup, staffRole, text, user, VIEW, WORK } from "../dsl.js";
import type { AppBlueprint } from "../types.js";

export const assets: AppBlueprint = {
  key: "assets",
  version: 1,
  name: "Assets",
  description: "Laptops, machines and furniture: who has what, warranty dates and maintenance costs.",
  icon: "IconDeviceDesktop",
  tables: [
    {
      key: "assets",
      name: "assets",
      label: "Assets",
      description: "Each item you own, with a tag, holder and condition",
      optional: false,
      columns: [
        autonum("tag", "Asset tag", "AST-"),
        text("name", "Asset", { required: true, indexed: true }),
        choice("category", "Category", ["Computer", "Phone", "Furniture", "Machine", "Vehicle", "Other"]),
        user("assigned_to", "Assigned to"),
        date("purchased_on", "Purchased on"),
        date("warranty_until", "Warranty until"),
        num("value", "Value"),
        choice("condition", "Condition", [["Good", "green"], ["Fair", "yellow"], ["Needs repair", "orange"], ["Retired", "gray"]], { default: "Good" }),
        text("serial", "Serial number", { showInTable: false }),
        rollup("maintenance_cost", "Maintenance cost", { from: "maintenance", via: "asset", fn: "sum", field: "cost" }),
      ],
    },
    {
      key: "maintenance",
      name: "maintenance",
      label: "Maintenance",
      description: "Repairs and services on each asset, with their cost",
      columns: [
        link("asset", "Asset", "assets", { required: true }),
        date("date", "Date", { required: true, default: "today" }),
        choice("type", "Type", ["Repair", "Service", "Inspection"], { default: "Service" }),
        num("cost", "Cost"),
        longText("notes", "Notes", { showInTable: false }),
      ],
    },
  ],
  reminders: [
    {
      table: "assets",
      label: "Warranties ending in the next 30 days",
      filters: [{ field: "warranty_until", op: "between", value: "$today", value2: "$today+30" }],
      who: "$managers",
      date: "warranty_until",
    },
  ],
  dashboard: {
    tiles: [{ label: "Assets needing repair", table: "assets", filters: [{ field: "condition", op: "in", value: ["Needs repair"] }] }],
    breakdown: { label: "Assets by category", table: "assets", column: "category" },
  },
  roles: [managerRole(), staffRole({ assets: VIEW, maintenance: WORK })],
  sample: (ctx) => ({
    assets: [
      { $id: "lap", name: "Laptop (Dell Latitude)", category: "Computer", assigned_to: ctx.me, purchased_on: ctx.date(-300), warranty_until: ctx.date(430), value: 85000 },
      { $id: "prn", name: "Office printer", category: "Machine", purchased_on: ctx.date(-700), value: 28000, condition: "Needs repair" },
    ],
    maintenance: [
      { asset: "@assets:prn", date: ctx.date(-20), type: "Repair", cost: 2400, notes: "Paper feed replaced" },
      { asset: "@assets:lap", date: ctx.date(-60), type: "Service", cost: 0 },
    ],
  }),
};
