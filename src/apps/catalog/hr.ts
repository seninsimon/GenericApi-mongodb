import { autonum, bool, choice, date, formula, link, longText, managerRole, OWN, staffRole, text, VIEW } from "../dsl.js";
import type { AppBlueprint } from "../types.js";

export const hr: AppBlueprint = {
  key: "hr",
  version: 2, // 2: approval steps
  name: "HR & leave",
  description: "Leave requests with approval, attendance and the holiday calendar. Staff see only their own.",
  icon: "IconUsers",
  needs: ["people"],
  tables: [
    {
      key: "leave_requests",
      name: "leave_requests",
      label: "Leave requests",
      description: "Who is away, when, and whether it's approved",
      optional: false,
      columns: [
        autonum("reference", "Reference", "LV-"),
        link("employee", "Employee", "people.employees", { required: true }),
        choice("type", "Type", ["Casual", "Sick", "Earned", "Unpaid", "Work from home"], { default: "Casual" }),
        date("from", "From", { required: true, default: "today" }),
        date("to", "To", { required: true, default: "today" }),
        formula("days", "Days", "DAYS({to}, {from}) + 1"),
        // approving is for managers
        choice("status", "Status", [["Pending", "orange"], ["Approved", "green"], ["Rejected", "red"]], { default: "Pending", onlyManagers: ["Approved", "Rejected"] }),
        longText("reason", "Reason", { showInTable: false }),
      ],
    },
    {
      key: "attendance",
      name: "attendance",
      label: "Attendance",
      description: "One row per person per day",
      columns: [
        link("employee", "Employee", "people.employees", { required: true }),
        date("date", "Date", { required: true, default: "today" }),
        choice("status", "Status", [["Present", "green"], ["Absent", "red"], ["Half day", "yellow"], ["Leave", "orange"], ["Work from home", "blue"]], { default: "Present" }),
        text("check_in", "Check-in"),
        text("check_out", "Check-out"),
        text("note", "Note", { showInTable: false }),
      ],
    },
    {
      key: "holidays",
      name: "holidays",
      label: "Holidays",
      description: "The company's holiday calendar",
      columns: [text("name", "Holiday", { required: true }), date("date", "Date", { required: true }), bool("optional", "Optional")],
    },
  ],
  automations: [
    {
      table: "leave_requests",
      name: "Tell the person when their leave is approved",
      trigger: { when: "changed", column: "status", to: "Approved" },
      actions: [{ do: "notify", who: "$creator", message: "Your leave request was approved" }],
    },
    {
      table: "leave_requests",
      name: "Tell the person when their leave is rejected",
      trigger: { when: "changed", column: "status", to: "Rejected" },
      actions: [{ do: "notify", who: "$creator", message: "Your leave request was rejected" }],
    },
  ],
  dashboard: {
    tiles: [{ label: "Leave waiting for approval", table: "leave_requests", filters: [{ field: "status", op: "in", value: ["Pending"] }] }],
    breakdown: { label: "Leave by type", table: "leave_requests", column: "type" },
  },
  roles: [
    managerRole(),
    // through "Employee" (whose Login account is them): their own leave and attendance
    staffRole({ leave_requests: OWN({ view: true, create: true }), attendance: OWN(VIEW), holidays: VIEW }),
  ],
  sample: (ctx) => ({
    leave_requests: [
      { employee: "@employees:asha", type: "Casual", from: ctx.date(5), to: ctx.date(6), status: "Pending", reason: "Family function" },
      { employee: "@employees:ravi", type: "Sick", from: ctx.date(-3), to: ctx.date(-3), status: "Approved" },
      { employee: "@employees:me", type: "Earned", from: ctx.date(20), to: ctx.date(24), status: "Pending" },
    ],
    attendance: [
      { employee: "@employees:asha", date: ctx.date(-1), status: "Present", check_in: "09:12", check_out: "18:05" },
      { employee: "@employees:ravi", date: ctx.date(-1), status: "Work from home" },
      { employee: "@employees:me", date: ctx.date(-1), status: "Present", check_in: "09:30" },
    ],
    holidays: [
      { name: "New Year's Day", date: `${new Date().getFullYear() + 1}-01-01` },
      { name: "Republic Day", date: `${new Date().getFullYear() + 1}-01-26` },
    ],
  }),
};
