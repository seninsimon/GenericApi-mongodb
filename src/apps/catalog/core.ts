import { bool, choice, date, dept, image, link, longText, managerRole, num, staffRole, text, user, VIEW, WORK } from "../dsl.js";
import type { AppBlueprint } from "../types.js";

// Shared lists other apps build on. Their tables are grouped as "Company".

export const people: AppBlueprint = {
  key: "people",
  version: 1,
  name: "People directory",
  description: "Everyone who works here, with their department and login. HR, leave and payroll build on it.",
  icon: "IconAddressBook",
  group: "Company",
  tables: [
    {
      key: "employees",
      name: "employees",
      label: "Employees",
      description: "Name, department, job title and contact details",
      optional: false,
      columns: [
        text("full_name", "Name", { required: true, indexed: true }),
        // links HR records to the person's login ("my leave", "my payslips")
        user("account", "Login account"),
        // filled in from the login's department when a login is picked
        dept("team", "Department", { fromUser: "account" }),
        text("job_title", "Job title", { indexed: true }),
        text("email", "Email"),
        text("phone", "Phone"),
        date("joined_on", "Joined on"),
        choice("status", "Status", [["Active", "green"], ["On leave", "orange"], ["Left", "gray"]], { default: "Active" }),
        image("photo", "Photo"),
      ],
    },
  ],
  roles: [
    managerRole(),
    staffRole({ employees: VIEW }),
  ],
  sample: (ctx) => ({
    employees: [
      { $id: "me", full_name: "You (sample)", account: ctx.me, job_title: "Team lead", joined_on: ctx.date(-400), status: "Active" },
      { $id: "asha", full_name: "Asha Menon", job_title: "Developer", email: "asha@example.com", joined_on: ctx.date(-200), status: "Active" },
      { $id: "ravi", full_name: "Ravi Kumar", job_title: "Designer", email: "ravi@example.com", joined_on: ctx.date(-90), status: "Active" },
      { $id: "neha", full_name: "Neha Singh", job_title: "Accountant", email: "neha@example.com", joined_on: ctx.date(-30), status: "On leave" },
    ],
  }),
};

export const customers: AppBlueprint = {
  key: "customers",
  version: 1,
  name: "Customers",
  description: "The companies you work with and the people there. CRM, helpdesk and billing build on it.",
  icon: "IconBuildingStore",
  group: "Company",
  tables: [
    {
      key: "companies",
      name: "companies",
      label: "Companies",
      description: "Customers and prospects",
      optional: false,
      columns: [
        text("name", "Company", { required: true, indexed: true }),
        choice("industry", "Industry", ["Retail", "Manufacturing", "Healthcare", "Education", "Software", "Services", "Other"]),
        text("city", "City", { indexed: true }),
        text("phone", "Phone"),
        text("email", "Email"),
        text("website", "Website"),
        user("owner", "Account owner", { default: "$me" }),
        longText("notes", "Notes", { showInTable: false }),
      ],
    },
    {
      key: "contacts",
      name: "contacts",
      label: "Contacts",
      description: "People at your customers",
      columns: [
        text("full_name", "Name", { required: true, indexed: true }),
        link("company", "Company", "companies"),
        text("job_title", "Job title"),
        text("email", "Email"),
        text("phone", "Phone"),
      ],
    },
  ],
  roles: [
    managerRole(),
    staffRole({ companies: WORK, contacts: WORK }),
  ],
  sample: () => ({
    companies: [
      { $id: "acme", name: "Acme Traders", industry: "Retail", city: "Kochi", phone: "+91 98470 00001" },
      { $id: "globex", name: "Globex Systems", industry: "Software", city: "Bengaluru", website: "https://globex.example" },
      { $id: "initech", name: "Initech Clinics", industry: "Healthcare", city: "Chennai" },
    ],
    contacts: [
      { full_name: "Maya Joseph", company: "@companies:acme", job_title: "Purchase manager", email: "maya@acme.example" },
      { full_name: "Arjun Rao", company: "@companies:globex", job_title: "CTO", email: "arjun@globex.example" },
      { full_name: "Dr. Lakshmi", company: "@companies:initech", job_title: "Director" },
    ],
  }),
};

export const products: AppBlueprint = {
  key: "products",
  version: 1,
  name: "Products & services",
  description: "What you sell or use, with prices. Billing and inventory build on it.",
  icon: "IconPackage",
  group: "Company",
  tables: [
    {
      key: "products",
      name: "products",
      label: "Products & services",
      description: "Name, type, category and price",
      optional: false,
      columns: [
        text("name", "Name", { required: true, indexed: true }),
        text("sku", "Code / SKU", { indexed: true }),
        choice("type", "Type", [["Product", "blue"], ["Service", "grape"]], { default: "Product" }),
        choice("unit", "Unit", ["pcs", "hour", "kg", "box", "month"], { default: "pcs" }),
        num("price", "Price", { indexed: true }),
        num("cost", "Cost"),
        bool("active", "Active", { default: true }),
        image("photo", "Photo"),
      ],
    },
  ],
  roles: [
    managerRole(),
    staffRole({ products: VIEW }),
  ],
  sample: () => ({
    products: [
      { $id: "consulting", name: "Consulting hour", type: "Service", unit: "hour", price: 2500, active: true },
      { $id: "support", name: "Annual support plan", type: "Service", unit: "month", price: 12000, active: true },
      { $id: "scanner", name: "Barcode scanner", sku: "HW-1001", type: "Product", unit: "pcs", price: 5400, cost: 3900, active: true },
      { $id: "labels", name: "Label rolls (box)", sku: "CN-2040", type: "Product", unit: "box", price: 900, cost: 600, active: true },
    ],
  }),
};
