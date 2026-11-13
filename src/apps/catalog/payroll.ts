import { autonum, choice, date, formula, link, managerRole, num, OWN, staffRole, VIEW } from "../dsl.js";
import type { AppBlueprint } from "../types.js";

export const payroll: AppBlueprint = {
  key: "payroll",
  version: 3, // 2: approval steps; 3: the employee hears when a payslip is ready and paid
  name: "Payroll",
  description: "Monthly payslips with gross and net pay worked out. Staff see only their own payslips.",
  icon: "IconCash",
  needs: ["people"],
  tables: [
    {
      key: "payslips",
      name: "payslips",
      label: "Payslips",
      description: "One per person per month: earnings, deductions and net pay",
      optional: false,
      columns: [
        autonum("reference", "Reference", "PAY-{YYYY}-"),
        link("employee", "Employee", "people.employees", { required: true }),
        date("month", "Month", { required: true }),
        num("basic", "Basic", { required: true }),
        num("allowances", "Allowances"),
        num("bonus", "Bonus"),
        num("deductions", "Deductions"),
        formula("gross", "Gross pay", "{basic} + {allowances} + {bonus}"),
        formula("net", "Net pay", "{gross} - {deductions}", { indexed: true }),
        choice("status", "Status", [["Draft", "gray"], ["Approved", "blue"], ["Paid", "green"]], { default: "Draft", onlyManagers: ["Approved", "Paid"] }),
        date("paid_on", "Paid on"),
      ],
    },
  ],
  automations: [
    {
      table: "payslips",
      name: "When paid: note the date",
      trigger: { when: "changed", column: "status", to: "Paid" },
      actions: [{ do: "set", column: "paid_on", value: "today" }],
    },
    {
      table: "payslips",
      name: "Tell the employee their payslip is ready",
      trigger: { when: "changed", column: "status", to: "Approved" },
      actions: [{ do: "notify", who: "employee.account", message: "Your payslip is ready" }],
    },
    {
      table: "payslips",
      name: "Tell the employee they were paid",
      trigger: { when: "changed", column: "status", to: "Paid" },
      actions: [{ do: "notify", who: "employee.account", message: "Your salary was paid" }],
    },
  ],
  // through "Employee" (whose Login account is them): their own payslips
  roles: [managerRole(), staffRole({ payslips: OWN(VIEW) })],
  sample: (ctx) => ({
    payslips: [
      { employee: "@employees:asha", month: ctx.date(-30).slice(0, 8) + "01", basic: 45000, allowances: 8000, deductions: 5400, status: "Paid", paid_on: ctx.date(-28) },
      { employee: "@employees:ravi", month: ctx.date(-30).slice(0, 8) + "01", basic: 38000, allowances: 6000, bonus: 2000, deductions: 4200, status: "Paid", paid_on: ctx.date(-28) },
      { employee: "@employees:me", month: ctx.date(-30).slice(0, 8) + "01", basic: 60000, allowances: 10000, deductions: 7500, status: "Approved" },
    ],
  }),
};
