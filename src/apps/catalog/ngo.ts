import { autonum, choice, date, link, managerRole, num, rollup, staffRole, text, user, VIEW, WORK } from "../dsl.js";
import type { AppBlueprint } from "../types.js";

export const ngo: AppBlueprint = {
  key: "ngo",
  version: 1,
  name: "Donors & programmes",
  description: "Donors and donations, the programmes they fund, and volunteers with their hours.",
  icon: "IconHeartHandshake",
  tables: [
    {
      key: "programs",
      name: "programmes",
      label: "Programmes",
      description: "What you run, with budget and money raised",
      optional: false,
      columns: [
        text("name", "Programme", { required: true, indexed: true }),
        choice("status", "Status", [["Planned", "gray"], ["Running", "blue"], ["Closed", "green"]], { default: "Planned" }),
        user("lead", "Lead"),
        num("budget", "Budget"),
        rollup("raised", "Raised", { from: "donations", via: "program", fn: "sum", field: "amount" }),
      ],
    },
    {
      key: "donors",
      name: "donors",
      label: "Donors",
      description: "People and organisations who give",
      optional: false,
      columns: [
        text("name", "Donor", { required: true, indexed: true }),
        choice("type", "Type", ["Individual", "Organisation"], { default: "Individual" }),
        text("email", "Email"),
        text("phone", "Phone"),
        text("city", "City"),
        rollup("total", "Total given", { from: "donations", via: "donor", fn: "sum", field: "amount" }),
      ],
    },
    {
      key: "donations",
      name: "donations",
      label: "Donations",
      description: "Each gift, with a receipt number",
      optional: false,
      columns: [
        autonum("receipt", "Receipt #", "DON-"),
        link("donor", "Donor", "donors", { required: true }),
        link("program", "Programme", "programs"),
        num("amount", "Amount", { required: true, indexed: true }),
        date("date", "Date", { default: "today" }),
        choice("method", "Method", ["Bank transfer", "UPI", "Cheque", "Cash", "Online"], { default: "Bank transfer" }),
      ],
    },
    {
      key: "volunteers",
      name: "volunteers",
      label: "Volunteers",
      description: "Who helps, and how many hours they've given",
      columns: [
        text("name", "Name", { required: true }),
        text("phone", "Phone"),
        text("email", "Email"),
        text("skills", "Skills"),
        rollup("hours", "Hours given", { from: "volunteer_hours", via: "volunteer", fn: "sum", field: "hours" }),
      ],
    },
    {
      key: "volunteer_hours",
      name: "volunteer_hours",
      label: "Volunteer hours",
      description: "Time given, by whom, for which programme",
      columns: [
        link("volunteer", "Volunteer", "volunteers", { required: true }),
        link("program", "Programme", "programs"),
        date("date", "Date", { default: "today" }),
        num("hours", "Hours", { required: true }),
      ],
    },
  ],
  dashboard: {
    tiles: [{ label: "Running programmes", table: "programs", filters: [{ field: "status", op: "in", value: ["Running"] }] }],
  },
  roles: [managerRole(), staffRole({ programs: VIEW, donors: WORK, donations: WORK, volunteers: WORK, volunteer_hours: WORK })],
  sample: (ctx) => ({
    programs: [
      { $id: "edu", name: "Evening tuition", status: "Running", lead: ctx.me, budget: 300000 },
      { $id: "food", name: "Community kitchen", status: "Planned", budget: 150000 },
    ],
    donors: [
      { $id: "d1", name: "Leela Varghese", type: "Individual", city: "Kochi" },
      { $id: "d2", name: "Bright Foundation", type: "Organisation", city: "Bengaluru" },
    ],
    donations: [
      { donor: "@donors:d1", program: "@programs:edu", amount: 25000, date: ctx.date(-15), method: "UPI" },
      { donor: "@donors:d2", program: "@programs:edu", amount: 100000, date: ctx.date(-40) },
      { donor: "@donors:d2", program: "@programs:food", amount: 50000, date: ctx.date(-5) },
    ],
    volunteers: [{ $id: "v1", name: "Arun George", skills: "Teaching, maths" }],
    volunteer_hours: [
      { volunteer: "@volunteers:v1", program: "@programs:edu", date: ctx.date(-3), hours: 2 },
      { volunteer: "@volunteers:v1", program: "@programs:edu", date: ctx.date(-1), hours: 2.5 },
    ],
  }),
};
