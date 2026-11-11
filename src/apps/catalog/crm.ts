import { choice, date, formula, link, longText, managerRole, num, OWN, staffRole, text, user, WORK } from "../dsl.js";
import type { AppBlueprint } from "../types.js";

export const crm: AppBlueprint = {
  key: "crm",
  version: 1,
  name: "Sales pipeline (CRM)",
  description: "Deals from lead to won, with the calls, emails and meetings along the way.",
  icon: "IconTargetArrow",
  needs: ["customers"],
  tables: [
    {
      key: "deals",
      name: "deals",
      label: "Deals",
      description: "Opportunities with a stage, value and expected close date",
      optional: false,
      columns: [
        text("title", "Deal", { required: true, indexed: true }),
        link("company", "Company", "customers.companies"),
        link("contact", "Contact", "customers.contacts"),
        choice("stage", "Stage", [["Lead", "gray"], ["Qualified", "blue"], ["Proposal", "violet"], ["Won", "green"], ["Lost", "red"]], { default: "Lead" }),
        num("value", "Value", { indexed: true }),
        num("probability", "Probability %"),
        formula("weighted", "Weighted value", "ROUND({value} * {probability} / 100)"),
        date("expected_close", "Expected close"),
        user("owner", "Owner", { default: "$me" }),
      ],
    },
    {
      key: "activities",
      name: "activities",
      label: "Activities",
      description: "Calls, emails, meetings and notes with customers",
      columns: [
        text("subject", "Subject", { required: true }),
        choice("type", "Type", [["Call", "blue"], ["Email", "grape"], ["Meeting", "teal"], ["Note", "gray"]], { default: "Call" }),
        link("company", "Company", "customers.companies"),
        link("deal", "Deal", "deals"),
        date("date", "Date", { default: "today" }),
        user("by", "By", { default: "$me" }),
        longText("notes", "Notes", { showInTable: false }),
      ],
    },
  ],
  dashboard: {
    tiles: [{ label: "Open deals", table: "deals", filters: [{ field: "stage", op: "notIn", value: ["Won", "Lost"] }] }],
    breakdown: { label: "Deals by stage", table: "deals", column: "stage" },
  },
  roles: [managerRole(), staffRole({ deals: OWN(WORK), activities: WORK })],
  sample: (ctx) => ({
    deals: [
      { $id: "pos", title: "POS terminals for 4 stores", company: "@companies:acme", stage: "Proposal", value: 480000, probability: 60, expected_close: ctx.date(21), owner: ctx.me },
      { title: "Support renewal", company: "@companies:globex", stage: "Qualified", value: 144000, probability: 80, expected_close: ctx.date(10), owner: ctx.me },
      { title: "Clinic software pilot", company: "@companies:initech", stage: "Lead", value: 90000, probability: 20, owner: ctx.me },
    ],
    activities: [
      { subject: "Demo call", type: "Call", company: "@companies:acme", deal: "@deals:pos", date: ctx.date(-2), by: ctx.me },
      { subject: "Sent proposal", type: "Email", company: "@companies:acme", deal: "@deals:pos", date: ctx.date(-1), by: ctx.me },
    ],
  }),
};
