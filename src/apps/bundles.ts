import type { BundleBlueprint } from "./types.js";

// Organization types: the apps that make sense together. Installing one is
// the same as installing its apps (the preview shows everything). Keys must
// differ from app keys (an install request may name either).
export const BUNDLES: BundleBlueprint[] = [
  {
    key: "org-clinic",
    name: "Clinic",
    description: "Patients, appointments, consultations and bills, a pharmacy stock and HR",
    icon: "IconStethoscope",
    apps: ["clinic", "inventory", "hr"],
  },
  {
    key: "org-school",
    name: "School / coaching centre",
    description: "Classes, students, attendance, exams and fees, plus staff HR and payroll",
    icon: "IconSchool",
    apps: ["school", "hr", "payroll"],
  },
  {
    key: "org-ngo",
    name: "NGO / non-profit",
    description: "Donors, donations, programmes and volunteers, with projects and expense claims",
    icon: "IconHeartHandshake",
    apps: ["ngo", "projects", "expenses", "hr"],
  },
  {
    key: "it",
    name: "IT / software company",
    description: "Projects and tasks, a helpdesk, a sales pipeline, HR and the company's laptops",
    icon: "IconDeviceLaptop",
    apps: ["projects", "helpdesk", "crm", "hr", "assets"],
  },
  {
    key: "agency",
    name: "Agency / services",
    description: "Win clients with a sales pipeline, deliver with projects and timesheets, then invoice",
    icon: "IconBriefcase",
    apps: ["crm", "projects", "billing", "expenses"],
  },
  {
    key: "office",
    name: "Small office",
    description: "A staff directory, leave, payroll, expense claims and a task list",
    icon: "IconBuildingSkyscraper",
    apps: ["hr", "payroll", "expenses", "projects"],
  },
  {
    key: "retail",
    name: "Retail / trading",
    description: "Customers, quotes and invoices, stock and purchasing, and HR",
    icon: "IconShoppingCart",
    apps: ["crm", "billing", "inventory", "hr"],
  },
  {
    key: "support",
    name: "Customer support team",
    description: "Customers, contacts and tickets",
    icon: "IconHeadset",
    apps: ["helpdesk"],
  },
];
