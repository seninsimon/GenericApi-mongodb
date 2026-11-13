import type { BundleBlueprint } from "./types.js";

// Organization types: the apps that make sense together, and starter
// departments. Installing one is the same as installing its apps (the
// preview shows everything); the departments are created too (existing ones
// with the same name are reused). Keys must differ from app keys (an install
// request may name either).
export const BUNDLES: BundleBlueprint[] = [
  {
    key: "org-clinic",
    name: "Clinic",
    description: "Patients, appointments, consultations and bills, a pharmacy stock and HR",
    icon: "IconStethoscope",
    apps: ["clinic", "inventory", "hr"],
    departments: ["Front desk", "Doctors", "Nursing", "Pharmacy", "Accounts"],
  },
  {
    key: "org-school",
    name: "School / coaching centre",
    description: "Classes, students, attendance, exams and fees, plus staff HR and payroll",
    icon: "IconSchool",
    apps: ["school", "hr", "payroll"],
    departments: ["Administration", "Teaching", "Accounts"],
  },
  {
    key: "org-ngo",
    name: "NGO / non-profit",
    description: "Donors, donations, programmes and volunteers, with projects and expense claims",
    icon: "IconHeartHandshake",
    apps: ["ngo", "projects", "expenses", "hr"],
    departments: ["Programmes", "Fundraising", "Finance", "Administration"],
  },
  {
    key: "it",
    name: "IT / software company",
    description: "Projects and tasks, a helpdesk, a sales pipeline, HR and the company's laptops",
    icon: "IconDeviceLaptop",
    apps: ["projects", "helpdesk", "crm", "hr", "assets"],
    departments: ["Management", "Engineering", "Sales", "Support", "HR & admin"],
  },
  {
    key: "agency",
    name: "Agency / services",
    description: "Win clients with a sales pipeline, deliver with projects and timesheets, then invoice",
    icon: "IconBriefcase",
    apps: ["crm", "projects", "billing", "expenses"],
    departments: ["Management", "Sales", "Delivery", "Finance"],
  },
  {
    key: "office",
    name: "Small office",
    description: "A staff directory, leave, payroll, expense claims and a task list",
    icon: "IconBuildingSkyscraper",
    apps: ["hr", "payroll", "expenses", "projects"],
    departments: ["Management", "Operations", "Finance", "HR & admin"],
  },
  {
    key: "retail",
    name: "Retail / trading",
    description: "Customers, quotes and invoices, stock and purchasing, and HR",
    icon: "IconShoppingCart",
    apps: ["crm", "billing", "inventory", "hr"],
    departments: ["Management", "Sales", "Store & warehouse", "Accounts"],
  },
  {
    key: "support",
    name: "Customer support team",
    description: "Customers, contacts and tickets",
    icon: "IconHeadset",
    apps: ["helpdesk"],
    departments: ["Support"],
  },
];
