import { autonum, choice, date, file, longText, managerRole, num, OWN, staffRole, text, user } from "../dsl.js";
import type { AppBlueprint } from "../types.js";

export const expenses: AppBlueprint = {
  key: "expenses",
  version: 4, // 2: approval steps; 3: managers hear about new claims; 4: the claimant hears about rejections
  name: "Expense claims",
  description: "Staff claim what they spent, with a receipt; managers approve and reimburse. Staff see only their own claims.",
  icon: "IconReceiptRefund",
  tables: [
    {
      key: "claims",
      name: "expense_claims",
      label: "Expense claims",
      description: "Who spent what, on what, and whether it's paid back",
      optional: false,
      columns: [
        autonum("reference", "Reference", "EXP-"),
        text("description", "What for", { required: true }),
        user("claimant", "Claimed by", { default: "$me", required: true }),
        date("date", "Date", { required: true, default: "today" }),
        choice("category", "Category", ["Travel", "Meals", "Office supplies", "Software", "Training", "Other"]),
        num("amount", "Amount", { required: true, indexed: true }),
        file("receipt", "Receipt"),
        choice("status", "Status", [["Submitted", "orange"], ["Approved", "blue"], ["Rejected", "red"], ["Reimbursed", "green"]], {
          default: "Submitted",
          onlyManagers: ["Approved", "Rejected", "Reimbursed"],
        }),
        longText("notes", "Notes", { showInTable: false }),
      ],
    },
  ],
  automations: [
    {
      table: "claims",
      name: "Tell the managers about new claims",
      trigger: { when: "created" },
      actions: [{ do: "notify", who: "$managers", message: "New expense claim to approve" }],
    },
    {
      table: "claims",
      name: "Tell the claimant when it's approved",
      trigger: { when: "changed", column: "status", to: "Approved" },
      actions: [{ do: "notify", who: "claimant", message: "Your expense claim was approved" }],
    },
    {
      table: "claims",
      name: "Tell the claimant when it's rejected",
      trigger: { when: "changed", column: "status", to: "Rejected" },
      actions: [{ do: "notify", who: "claimant", message: "Your expense claim was rejected" }],
    },
    {
      table: "claims",
      name: "Tell the claimant when it's paid back",
      trigger: { when: "changed", column: "status", to: "Reimbursed" },
      actions: [{ do: "notify", who: "claimant", message: "Your expense claim was paid back" }],
    },
  ],
  dashboard: {
    tiles: [{ label: "Claims waiting for approval", table: "claims", filters: [{ field: "status", op: "in", value: ["Submitted"] }] }],
    breakdown: { label: "Claims by category", table: "claims", column: "category" },
  },
  roles: [managerRole(), staffRole({ claims: OWN({ view: true, create: true, edit: true }) })],
  sample: (ctx) => ({
    claims: [
      { description: "Taxi to client office", claimant: ctx.me, date: ctx.date(-4), category: "Travel", amount: 640, status: "Submitted" },
      { description: "Team lunch after launch", claimant: ctx.me, date: ctx.date(-12), category: "Meals", amount: 3200, status: "Reimbursed" },
    ],
  }),
};
