import { autonum, choice, date, formula, link, longText, managerRole, num, rollup, staffRole, text, VIEW, WORK } from "../dsl.js";
import type { AppBlueprint, TableBlueprint } from "../types.js";

// A document with lines, totals and tax: invoices and quotes share the shape.
const lines = (key: string, name: string, label: string, parent: string): TableBlueprint => ({
  key,
  name,
  label,
  description: `The items on each ${parent.replace(/s$/, "")}, edited inside it`,
  optional: false,
  showInMenu: false, // edited inside the invoice / quote
  columns: [
    // edited inside the parent's form
    link(parent.replace(/s$/, ""), parent === "invoices" ? "Invoice" : "Quote", parent, { required: true, inline: true }),
    link("product", "Product / service", "products.products"),
    text("description", "Description"),
    num("qty", "Qty", { default: 1, required: true }),
    num("rate", "Rate", { required: true }),
    formula("amount", "Amount", "ROUND({qty} * {rate}, 2)"),
  ],
});

export const billing: AppBlueprint = {
  key: "billing",
  version: 1,
  name: "Billing",
  description: "Quotes and invoices with lines, tax and totals worked out, and payments with what's still due.",
  icon: "IconReceipt",
  needs: ["customers", "products"],
  tables: [
    {
      key: "invoices",
      name: "invoices",
      label: "Invoices",
      description: "What customers owe: lines, tax, total, paid and balance",
      optional: false,
      columns: [
        autonum("number", "Invoice #", "INV-{YYYY}-"),
        link("customer", "Customer", "customers.companies", { required: true }),
        date("date", "Date", { default: "today" }),
        date("due", "Due"),
        choice("status", "Status", [["Draft", "gray"], ["Sent", "blue"], ["Paid", "green"], ["Overdue", "red"], ["Cancelled", "yellow"]], { default: "Draft" }),
        rollup("subtotal", "Subtotal", { from: "invoice_lines", via: "invoice", fn: "sum", field: "amount" }),
        num("tax_pct", "Tax %", { default: 18 }),
        formula("tax", "Tax", "ROUND({subtotal} * {tax_pct} / 100, 2)"),
        formula("total", "Total", "{subtotal} + {tax}", { indexed: true }),
        rollup("paid", "Paid", { from: "payments", via: "invoice", fn: "sum", field: "amount" }),
        formula("balance", "Balance due", "{total} - {paid}", { indexed: true }),
        longText("notes", "Notes", { showInTable: false }),
      ],
    },
    lines("invoice_lines", "invoice_lines", "Invoice lines", "invoices"),
    {
      key: "payments",
      name: "payments",
      label: "Payments",
      description: "Money received against invoices",
      columns: [
        link("invoice", "Invoice", "invoices", { required: true }),
        date("date", "Date", { required: true, default: "today" }),
        num("amount", "Amount", { required: true }),
        choice("method", "Method", ["Bank transfer", "UPI", "Card", "Cash", "Cheque"], { default: "Bank transfer" }),
        text("reference", "Reference"),
      ],
    },
    {
      key: "quotes",
      name: "quotes",
      label: "Quotes",
      description: "Price offers before an invoice",
      columns: [
        autonum("number", "Quote #", "QT-"),
        link("customer", "Customer", "customers.companies", { required: true }),
        date("date", "Date", { default: "today" }),
        date("valid_until", "Valid until"),
        choice("status", "Status", [["Draft", "gray"], ["Sent", "blue"], ["Accepted", "green"], ["Declined", "red"]], { default: "Draft" }),
        rollup("total", "Total", { from: "quote_lines", via: "quote", fn: "sum", field: "amount" }),
      ],
    },
    { ...lines("quote_lines", "quote_lines", "Quote lines", "quotes"), optional: true },
  ],
  roles: [
    managerRole(),
    // sales prepare quotes; invoices and payments are for finance
    staffRole({ quotes: WORK, quote_lines: { view: true, create: true, edit: true, delete: true }, invoices: VIEW, invoice_lines: VIEW, payments: VIEW }),
  ],
  sample: (ctx) => ({
    invoices: [
      { $id: "i1", customer: "@companies:acme", date: ctx.date(-20), due: ctx.date(10), status: "Sent", tax_pct: 18 },
      { $id: "i2", customer: "@companies:globex", date: ctx.date(-40), due: ctx.date(-10), status: "Paid", tax_pct: 18 },
    ],
    invoice_lines: [
      { invoice: "@invoices:i1", description: "Barcode scanners", qty: 4, rate: 5400 },
      { invoice: "@invoices:i1", description: "Installation", qty: 3, rate: 2500 },
      { invoice: "@invoices:i2", description: "Annual support plan", qty: 1, rate: 12000 },
    ],
    payments: [
      { invoice: "@invoices:i1", date: ctx.date(-5), amount: 10000, method: "UPI", reference: "UPI-88213" },
      { invoice: "@invoices:i2", date: ctx.date(-12), amount: 14160, method: "Bank transfer" },
    ],
    quotes: [{ $id: "q1", customer: "@companies:initech", date: ctx.date(-3), valid_until: ctx.date(27), status: "Sent" }],
    quote_lines: [{ quote: "@quotes:q1", description: "Clinic software pilot (3 months)", qty: 3, rate: 30000 }],
  }),
};
