import { autonum, choice, date, files, link, longText, managerRole, staffRole, text, user, WORK } from "../dsl.js";
import type { AppBlueprint } from "../types.js";

export const helpdesk: AppBlueprint = {
  key: "helpdesk",
  version: 3, // 2: automations; 3: managers hear about urgent tickets
  name: "Helpdesk",
  description: "Customer or internal tickets with priority, status and an assignee.",
  icon: "IconLifebuoy",
  needs: ["customers"],
  tables: [
    {
      key: "tickets",
      name: "tickets",
      label: "Tickets",
      description: "Requests and problems to solve",
      optional: false,
      columns: [
        text("subject", "Subject", { required: true, indexed: true }),
        autonum("number", "Ticket #", "TCK-"),
        link("customer", "Customer", "customers.companies"),
        choice("priority", "Priority", [["Urgent", "red"], ["High", "orange"], ["Normal", "blue"], ["Low", "gray"]], { default: "Normal" }),
        choice("status", "Status", [["New", "blue"], ["Open", "orange"], ["Waiting", "yellow"], ["Resolved", "green"], ["Closed", "gray"]], { default: "New" }),
        choice("category", "Category", ["Question", "Problem", "Request", "Other"]),
        user("assignee", "Assignee"),
        user("requester", "Requested by", { default: "$me" }),
        date("opened", "Opened", { default: "today" }),
        date("resolved_on", "Resolved on", { showInTable: false }),
        longText("details", "Details", { showInTable: false }),
        files("attachments", "Attachments", { showInTable: false }),
      ],
    },
  ],
  automations: [
    {
      table: "tickets",
      name: "Tell the managers about urgent tickets",
      trigger: { when: "changed", column: "priority", to: "Urgent" },
      actions: [{ do: "notify", who: "$managers", message: "Urgent ticket" }],
    },
    {
      table: "tickets",
      name: "When resolved: note the date and tell the requester",
      trigger: { when: "changed", column: "status", to: "Resolved" },
      actions: [
        { do: "set", column: "resolved_on", value: "today" },
        { do: "notify", who: "requester", message: "Your ticket was resolved" },
      ],
    },
  ],
  dashboard: {
    tiles: [
      { label: "Open tickets", table: "tickets", filters: [{ field: "status", op: "in", value: ["New", "Open", "Waiting"] }] },
      {
        label: "Urgent open tickets",
        table: "tickets",
        filters: [
          { field: "status", op: "in", value: ["New", "Open", "Waiting"] },
          { field: "priority", op: "in", value: ["Urgent"] },
        ],
      },
    ],
    breakdown: { label: "Tickets by status", table: "tickets", column: "status" },
  },
  roles: [managerRole(), staffRole({ tickets: WORK })],
  sample: (ctx) => ({
    tickets: [
      { subject: "Can't log in to the portal", customer: "@companies:globex", priority: "High", status: "Open", category: "Problem", assignee: ctx.me, opened: ctx.date(-1) },
      { subject: "Invoice copy for March", customer: "@companies:acme", priority: "Normal", status: "New", category: "Request", opened: ctx.date(0) },
      { subject: "Printer not working", priority: "Low", status: "Resolved", category: "Problem", opened: ctx.date(-6), resolved_on: ctx.date(-5) },
    ],
  }),
};
