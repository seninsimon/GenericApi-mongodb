import { autonum, choice, date, formula, link, longText, managerRole, num, rollup, staffRole, text, VIEW, WORK } from "../dsl.js";
import type { AppBlueprint } from "../types.js";

export const inventory: AppBlueprint = {
  key: "inventory",
  version: 1,
  name: "Inventory & purchasing",
  description: "Suppliers, purchase orders and stock moves, with stock on hand and low-stock flags on your products.",
  icon: "IconBuildingWarehouse",
  needs: ["products"],
  tables: [
    {
      key: "suppliers",
      name: "suppliers",
      label: "Suppliers",
      description: "Who you buy from",
      columns: [
        text("name", "Supplier", { required: true, indexed: true }),
        text("contact_person", "Contact person"),
        text("phone", "Phone"),
        text("email", "Email"),
        text("city", "City"),
        choice("category", "Category", ["Goods", "Raw material", "Services", "Other"]),
      ],
    },
    {
      key: "purchase_orders",
      name: "purchase_orders",
      label: "Purchase orders",
      description: "What you ordered from suppliers, with lines and a total",
      columns: [
        autonum("number", "PO #", "PO-"),
        link("supplier", "Supplier", "suppliers", { required: true }),
        date("date", "Ordered on", { default: "today" }),
        date("expected", "Expected on"),
        choice("status", "Status", [["Draft", "gray"], ["Ordered", "blue"], ["Received", "green"], ["Cancelled", "red"]], { default: "Draft" }),
        rollup("total", "Total", { from: "po_lines", via: "po", fn: "sum", field: "amount" }),
        longText("notes", "Notes", { showInTable: false }),
      ],
    },
    {
      key: "po_lines",
      name: "po_lines",
      label: "Purchase order lines",
      description: "The items on each purchase order, edited inside it",
      optional: false,
      showInMenu: false,
      columns: [
        link("po", "Purchase order", "purchase_orders", { required: true, inline: true }),
        link("product", "Product", "products.products", { required: true }),
        num("qty", "Qty", { required: true, default: 1 }),
        num("rate", "Rate", { required: true }),
        formula("amount", "Amount", "ROUND({qty} * {rate}, 2)"),
      ],
    },
    {
      key: "stock_moves",
      name: "stock_moves",
      label: "Stock moves",
      description: "Every item in or out of stock (always a positive quantity)",
      optional: false,
      columns: [
        link("product", "Product", "products.products", { required: true }),
        choice("type", "In / Out", [["In", "green"], ["Out", "orange"]], { required: true, default: "In" }),
        num("qty", "Qty", { required: true }),
        date("date", "Date", { required: true, default: "today" }),
        text("reference", "Reference", { showInTable: false }),
        text("note", "Note", { showInTable: false }),
      ],
    },
  ],
  // stock on hand lives on the product
  extend: {
    "products.products": [
      rollup("stock_in", "Stock in", { from: "stock_moves", via: "product", fn: "sum", field: "qty", where: { column: "type", in: ["In"] } }, { showInTable: false }),
      rollup("stock_out", "Stock out", { from: "stock_moves", via: "product", fn: "sum", field: "qty", where: { column: "type", in: ["Out"] } }, { showInTable: false }),
      formula("stock", "In stock", "{stock_in} - {stock_out}", { indexed: true }),
      num("reorder_level", "Reorder level"),
      formula("low_stock", "Low stock", 'IF({stock} <= {reorder_level} and {reorder_level} > 0, "Low", "")'),
    ],
  },
  roles: [managerRole(), staffRole({ suppliers: VIEW, purchase_orders: WORK, po_lines: { view: true, create: true, edit: true, delete: true }, stock_moves: WORK })],
  sample: (ctx) => ({
    suppliers: [
      { $id: "s1", name: "Metro Distributors", contact_person: "Ravi", phone: "+91 98450 11111", city: "Kochi", category: "Goods" },
      { $id: "s2", name: "Prime Packaging", city: "Coimbatore", category: "Raw material" },
    ],
    purchase_orders: [{ $id: "po1", supplier: "@suppliers:s1", date: ctx.date(-7), expected: ctx.date(3), status: "Ordered" }],
    po_lines: [
      { po: "@purchase_orders:po1", product: "@products:scanner", qty: 10, rate: 3900 },
      { po: "@purchase_orders:po1", product: "@products:labels", qty: 20, rate: 600 },
    ],
    stock_moves: [
      { product: "@products:scanner", type: "In", qty: 20, date: ctx.date(-30), reference: "Opening stock" },
      { product: "@products:scanner", type: "Out", qty: 6, date: ctx.date(-10), reference: "Sold" },
      { product: "@products:labels", type: "In", qty: 4, date: ctx.date(-30), reference: "Opening stock" },
      { product: "@products:labels", type: "Out", qty: 3, date: ctx.date(-2) },
    ],
  }),
};
