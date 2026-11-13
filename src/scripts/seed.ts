// Load a realistic demo company: 8 departments, 17 tables across CRM, sales,
// procurement, HR, projects, IT, finance and support, 9 roles, 16 users and
// tens of thousands of linked records (with images and PDF attachments).
//
//   pnpm seed                    (medium: ~20k records, a few seconds)
//   pnpm seed --size=small       (~3k records)
//   pnpm seed --size=large       (~160k records, for performance demos)
//   docker compose exec api node dist/scripts/seed.js --size=medium --force   (docker runs with NODE_ENV=production)
//
// Demo users all share the password printed at the end. Never seed a
// production database. To start over: pnpm db:reset --yes && pnpm seed
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { hashPassword } from "../auth/password.js";
import { normalizePermissions } from "../auth/access.js";
import { env } from "../config/env.js";
import { dataTable, ensureDataTable, syncColumnIndexes } from "../db/dataTables.js";
import { migrate } from "../db/migrate.js";
import { pool, query, withTransaction } from "../db/pool.js";
import { ensureInitialAdmin } from "../auth/bootstrap.js";
import { createDepartment, createRole, createUser, findUserForLogin } from "../repo/userRepo.js";
import { backfillAutonumber, syncCounterFromData } from "../schema/autonumber.js";
import { applyFormulas } from "../schema/formula.js";
import { createTable, getSchema, invalidateSchemas, updateTableSettings } from "../schema/schemaRepo.js";
import { storage, UPLOAD_URL_PREFIX } from "../storage.js";

const DEMO_PASSWORD = "demo-pass-123";
const sizeArg = process.argv.find((a) => a.startsWith("--size="))?.split("=")[1] ?? "medium";
const SCALE = { small: 0.15, medium: 1, large: 8 }[sizeArg];
if (!SCALE) {
  console.error("--size must be small, medium or large");
  process.exit(1);
}
const n = (medium: number) => Math.max(5, Math.round(medium * SCALE!));

/* ======================= deterministic randomness ======================= */
let seed = 20261110;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
const chance = (p: number) => rand() < p;
const money = (min: number, max: number) => Math.round((min + rand() * (max - min)) * 100) / 100;
const weighted = <T>(items: [T, number][]): T => {
  let r = rand() * items.reduce((s, [, w]) => s + w, 0);
  for (const [item, w] of items) if ((r -= w) <= 0) return item;
  return items[items.length - 1][0];
};
const sample = <T>(list: readonly T[], count: number): T[] => {
  const copy = [...list];
  const out: T[] = [];
  while (out.length < count && copy.length) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
};

const TODAY = new Date(Date.UTC(2026, 10, 10));
const day = (offset: number) => new Date(TODAY.getTime() + offset * 86_400_000);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dateBetween = (fromDays: number, toDays: number) => iso(day(int(fromDays, toDays)));
const plusDays = (date: string, days: number) => iso(new Date(new Date(date).getTime() + days * 86_400_000));

/* ============================== word lists ============================== */
const FIRST = ["Aarav", "Priya", "Arjun", "Meera", "Rahul", "Zoya", "Kiran", "Ayesha", "David", "Anita", "Liam", "Fatima", "Nikhil", "Sara", "Vivek", "Maria", "Joseph", "Neha", "Rohan", "Isha", "Karan", "Divya", "Omar", "Leela", "Tom", "Grace", "Aditya", "Sneha", "Farhan", "Nisha", "Varun", "Anjali", "Ethan", "Pooja", "Imran", "Kavya", "Ravi", "Tara", "Sam", "Diya"];
const LAST = ["Sharma", "Menon", "Nair", "Iyer", "Verma", "Ali", "Rao", "Khan", "Thomas", "George", "D'Souza", "Sheikh", "Joshi", "Pillai", "Fernandes", "Mathew", "Gupta", "Reddy", "Kapoor", "Das", "Bose", "Chopra", "Mehta", "Patel", "Singh", "Varghese", "Kurian", "Banerjee", "Shetty", "Bhat"];
const CITIES = ["Kochi", "Bengaluru", "Mumbai", "Pune", "Chennai", "Delhi", "Hyderabad", "Kolkata", "Ahmedabad", "Jaipur", "Dubai", "Singapore", "London"];
const INDUSTRIES = ["Manufacturing", "Retail", "Healthcare", "Education", "Logistics", "Hospitality", "Construction", "Software", "Agriculture", "Finance"];
const CO_A = ["Blue", "Green", "Silver", "Prime", "Apex", "Nova", "Summit", "Coastal", "Golden", "Urban", "Bright", "Royal", "Metro", "Pioneer", "Vertex"];
const CO_B = ["Harbor", "Peak", "River", "Star", "Field", "Bridge", "Stone", "Leaf", "Wave", "Arc", "Line", "Point", "Gate", "Works", "Labs"];
const CO_C = ["Traders", "Industries", "Foods", "Logistics", "Retail", "Pharma", "Textiles", "Systems", "Builders", "Exports"];
const PRODUCT_TYPES: [string, string, number][] = [
  ["Steel bolts (box of 100)", "Hardware", 450], ["Copper wire 50m", "Electrical", 2200], ["LED panel 2x2", "Electrical", 1800],
  ["Safety gloves (pair)", "Safety", 180], ["Hydraulic pump", "Machinery", 38000], ["Circuit board v2", "Electronics", 2600],
  ["Ceramic floor tile", "Building", 95], ["Solar cell 300W", "Energy", 9500], ["Air filter", "Machinery", 1200],
  ["Ball bearing 6204", "Hardware", 140], ["Industrial fan", "Machinery", 7400], ["PVC pipe 3m", "Plumbing", 320],
  ["Paint 20L (white)", "Building", 4100], ["Office chair", "Furniture", 6900], ["Laptop stand", "Furniture", 1500],
  ["Thermal printer", "Electronics", 11200], ["Barcode scanner", "Electronics", 5400], ["Pallet jack", "Machinery", 21000],
];
const ORDER_STATUSES: [string, number][] = [["Draft", 1], ["Confirmed", 3], ["Shipped", 3], ["Delivered", 8], ["Cancelled", 1]];
const DEAL_STAGES: [string, number][] = [["Prospect", 4], ["Qualified", 3], ["Proposal", 3], ["Negotiation", 2], ["Won", 3], ["Lost", 2]];
const SUPPLIER_CATEGORIES = ["Raw material", "Components", "Packaging", "Services", "Electrical"];
const EXPENSE_CATEGORIES = ["Travel", "Meals", "Office supplies", "Software", "Training", "Client entertainment", "Fuel"];
const ASSET_TYPES: [string, string, number][] = [["Laptop", "Computers", 85000], ["Monitor 27\"", "Peripherals", 22000], ["Desk phone", "Phones", 6000], ["Mobile phone", "Phones", 32000], ["Printer", "Peripherals", 28000], ["Router", "Network", 18000], ["Projector", "AV", 45000]];
const ASSET_CATEGORIES = [...new Set(ASSET_TYPES.map((a) => a[1]))];
const TEAMS = ["Sales", "Marketing", "Operations", "Finance", "HR", "IT", "Support"];
const JOBS: Record<string, string[]> = {
  Sales: ["Sales Executive", "Account Manager", "Sales Manager"],
  Marketing: ["Marketing Executive", "Content Writer", "Designer"],
  Operations: ["Operations Executive", "Warehouse Lead", "Procurement Officer"],
  Finance: ["Accountant", "Finance Analyst", "Finance Manager"],
  HR: ["HR Executive", "Recruiter", "HR Manager"],
  IT: ["Support Engineer", "Developer", "IT Manager"],
  Support: ["Support Agent", "Support Lead"],
};

/* ============================ files to upload ============================ */
const crcTable = Array.from({ length: 256 }, (_, k) => {
  let c = k;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
// a soft two-tone square, so thumbnails look like placeholders rather than noise
const png = (hue: number, size = 96) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const [r1, g1, b1] = hsl(hue, 0.55, 0.55);
  const [r2, g2, b2] = hsl(hue, 0.6, 0.85);
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * (size * 3 + 1) + 1 + x * 3;
      const inner = Math.hypot(x - size / 2, y - size / 2) < size * 0.28;
      raw[o] = inner ? r2 : r1;
      raw[o + 1] = inner ? g2 : g1;
      raw[o + 2] = inner ? b2 : b1;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
};
function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (k: number) => {
    const m = (k + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(m - 3, 9 - m, 1))));
  };
  return [f(0), f(8), f(4)];
}
// a small valid one-page PDF
const pdf = (title: string, lines: string[]) => {
  const text = [title, ...lines].map((l, i) => `BT /F1 ${i ? 11 : 16} Tf 60 ${760 - i * 22} Td (${l.replace(/[()\\]/g, "")}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
};
let uploads = 0;
const upload = async (name: string, body: Buffer, type: string) => {
  const key = `${Date.now()}-${randomUUID().slice(0, 8)}-${name}`;
  await storage.put(key, body, type);
  uploads++;
  return `${UPLOAD_URL_PREFIX}${key}`;
};

/* ============================== table setup ============================== */
type Col = Record<string, unknown> & { name: string; label: string; type?: string };
const text = (name: string, label: string, extra: Partial<Col> = {}): Col => ({ name, label, type: "text", ...extra });
const num = (name: string, label: string, extra: Partial<Col> = {}): Col => ({ name, label, type: "number", ...extra });
const date = (name: string, label: string, extra: Partial<Col> = {}): Col => ({ name, label, type: "date", indexed: true, ...extra });
const bool = (name: string, label: string, extra: Partial<Col> = {}): Col => ({ name, label, type: "boolean", ...extra });
const link = (name: string, label: string, ref: string, extra: Partial<Col> = {}): Col => ({ name, label, type: "relation", ref, ...extra });
const hidden = { showInTable: false };
// INV-0001, INV-0002, ... given automatically to new records
const autonum = (name: string, label: string, prefix: string, extra: Partial<Col> = {}): Col => ({
  name, label, type: "autonumber", autonumber: { prefix }, indexed: true, ...extra,
});
// worked out from other fields when a record is saved
const formula = (name: string, label: string, expression: string, extra: Partial<Col> = {}): Col => ({
  name, label, type: "formula", formula: { expression }, ...extra,
});
// the value an auto-number column gives record n
const numbered = (prefix: string, n: number) => `${prefix}${String(n).padStart(4, "0")}`;
// a fixed list of options; [label, colour] pairs or plain labels (colours are then picked automatically)
const choice = (name: string, label: string, options: (string | [string, string])[], extra: Partial<Col> = {}): Col => ({
  name, label, type: "choice", options: options.map((o) => (typeof o === "string" ? { label: o } : { label: o[0], color: o[1] })), ...extra,
});
const PRIORITIES: [string, string][] = [["Urgent", "red"], ["High", "orange"], ["Normal", "blue"], ["Low", "gray"]];
// 1 = urgent … 4 = low
const priority = (n: number) => PRIORITIES[n - 1][0];
const TASK_STATUSES: [string, string][] = [
  ["To do", "gray"], ["In progress", "blue"], ["In review", "violet"], ["Blocked", "red"], ["Done", "green"], ["Cancelled", "yellow"],
];

const TABLES: { name: string; departments: string[]; columns: Col[] }[] = [
  { name: "companies", departments: ["All staff"], columns: [
    text("name", "Company", { required: true, indexed: true }), choice("industry", "Industry", INDUSTRIES), text("city", "City", { indexed: true }),
    text("website", "Website"), num("employees_count", "Employees", { indexed: true }), num("annual_revenue", "Annual revenue", { indexed: true }),
    date("customer_since", "Customer since"), bool("key_account", "Key account"), { name: "logo", label: "Logo", type: "image" },
    { name: "notes", label: "Notes", type: "textarea", ...hidden },
  ] },
  { name: "contacts", departments: ["All staff"], columns: [
    text("full_name", "Name", { required: true, indexed: true }), link("company", "Company", "companies", { required: true }), text("job_title", "Job title"),
    text("email", "Email"), text("phone", "Phone"), text("city", "City", { indexed: true }), date("last_contacted", "Last contacted"), bool("newsletter", "Newsletter"),
  ] },
  { name: "employees", departments: ["All staff"], columns: [
    text("full_name", "Name", { required: true, indexed: true }), { name: "team", label: "Department", type: "department" }, text("job_title", "Job title", { indexed: true }),
    text("email", "Email"), text("phone", "Phone"), text("location", "Location", { indexed: true }), date("joined_on", "Joined on"), bool("active", "Active"),
    { name: "photo", label: "Photo", type: "image" },
  ] },
  { name: "deals", departments: ["Sales"], columns: [
    text("title", "Deal", { required: true, indexed: true }), link("company", "Company", "companies", { required: true }), link("contact", "Contact", "contacts"),
    choice("stage", "Stage", [["Prospect", "gray"], ["Qualified", "blue"], ["Proposal", "violet"], ["Negotiation", "orange"], ["Won", "green"], ["Lost", "red"]], { default: "Prospect" }), num("value", "Value", { indexed: true }), num("probability", "Probability %", { indexed: true }),
    date("expected_close", "Expected close"), link("owner", "Owner", "employees"), { name: "notes", label: "Notes", type: "richtext", ...hidden },
  ] },
  { name: "products", departments: ["All staff"], columns: [
    text("name", "Product", { required: true, indexed: true }), text("sku", "SKU", { indexed: true }), choice("category", "Category", [...new Set(PRODUCT_TYPES.map((p) => p[1]))]),
    num("price", "Price", { required: true, indexed: true }), num("cost", "Cost"), num("stock", "In stock", { indexed: true }), num("reorder_level", "Reorder level"),
    bool("active", "Active"), { name: "photos", label: "Photos", type: "images" }, { name: "description", label: "Description", type: "richtext", ...hidden },
  ] },
  { name: "orders", departments: ["Sales", "Operations", "Finance"], columns: [
    autonum("number", "Order #", "SO-"), link("customer", "Customer", "companies", { required: true }),
    link("items", "Items", "products", { multiple: true }), date("order_date", "Order date", { required: true, default: "today" }), num("total", "Total", { indexed: true }),
    choice("status", "Status", [["Draft", "gray"], ["Confirmed", "blue"], ["Shipped", "violet"], ["Delivered", "green"], ["Cancelled", "red"]], { default: "Draft" }), bool("paid", "Paid"), { name: "invoice", label: "Invoice", type: "file", ...hidden },
    { name: "notes", label: "Notes", type: "textarea", ...hidden },
  ] },
  { name: "suppliers", departments: ["All staff"], columns: [
    text("name", "Supplier", { required: true, indexed: true }), choice("category", "Category", SUPPLIER_CATEGORIES), text("contact_person", "Contact person"),
    text("email", "Email"), text("phone", "Phone"), text("city", "City", { indexed: true }), num("rating", "Rating (1–5)", { indexed: true }), bool("preferred", "Preferred"),
  ] },
  { name: "purchase_orders", departments: ["Operations", "Finance"], columns: [
    autonum("po_number", "PO #", "PO-"), link("supplier", "Supplier", "suppliers", { required: true }),
    link("items", "Items", "products", { multiple: true }), date("ordered_on", "Ordered on", { default: "today" }), date("expected_on", "Expected on"),
    num("amount", "Amount", { indexed: true }),
    choice("status", "Status", [["Draft", "gray"], ["Sent", "blue"], ["Partially received", "orange"], ["Received", "green"], ["Cancelled", "red"]], { default: "Draft" }), bool("received", "Received"),
  ] },
  { name: "payroll", departments: ["HR"], columns: [
    text("reference", "Reference", { required: true, indexed: true }), link("employee", "Employee", "employees", { required: true }),
    date("month", "Month"), num("basic", "Basic"), num("allowances", "Allowances"), num("deductions", "Deductions"),
    formula("net_pay", "Net pay", "{basic} + {allowances} - {deductions}", { indexed: true }), bool("paid", "Paid"),
  ] },
  { name: "leave_requests", departments: ["HR"], columns: [
    autonum("reference", "Reference", "LV-"), link("employee", "Employee", "employees", { required: true }),
    choice("leave_type", "Type", ["Casual", "Sick", "Earned", "Work from home", "Unpaid"]), date("from_date", "From", { required: true }), date("to_date", "To", { required: true }),
    formula("days", "Days", "DAYS({to_date}, {from_date}) + 1"), choice("status", "Status", [["Pending", "orange"], ["Approved", "green"], ["Rejected", "red"]], { default: "Pending" }), { name: "reason", label: "Reason", type: "textarea", ...hidden },
  ] },
  { name: "projects", departments: ["IT", "Marketing", "Operations"], columns: [
    text("name", "Project", { required: true, indexed: true }), text("code", "Code", { indexed: true }), link("owner", "Owner", "employees"),
    date("start_date", "Start"), date("due_date", "Due"), num("budget", "Budget", { indexed: true }), num("progress", "Progress %", { indexed: true }),
    choice("status", "Status", [["Planning", "gray"], ["Active", "blue"], ["On hold", "orange"], ["Completed", "green"]], { default: "Planning" }),
    { name: "description", label: "Description", type: "richtext", ...hidden },
  ] },
  { name: "tasks", departments: ["IT", "Marketing", "Operations"], columns: [
    text("title", "Task", { required: true, indexed: true }), choice("status", "Status", TASK_STATUSES, { required: true, default: "To do" }),
    choice("priority", "Priority", PRIORITIES, { default: "Normal" }), link("assignee", "Assignee", "employees"), link("project", "Project", "projects"),
    date("start_date", "Start"), date("due_date", "Due"), num("progress", "Progress %", { indexed: true }), num("estimated_hours", "Estimated h"),
    num("hours_spent", "Hours spent"), date("completed_on", "Completed on", hidden), link("parent_task", "Parent task", "tasks", hidden),
    { name: "description", label: "Description", type: "richtext", ...hidden },
  ] },
  { name: "time_logs", departments: ["IT", "Marketing", "Operations"], columns: [
    text("work_done", "Work done", { required: true, indexed: true }), link("task", "Task", "tasks", { required: true }),
    link("person", "Person", "employees", { required: true }), date("date", "Date", { required: true, default: "today" }), num("hours", "Hours", { required: true }),
  ] },
  { name: "assets", departments: ["IT"], columns: [
    autonum("tag", "Asset tag", "AST-"), text("name", "Asset", { indexed: true }), choice("category", "Category", ASSET_CATEGORIES),
    link("assigned_to", "Assigned to", "employees"), date("purchased_on", "Purchased"), date("warranty_until", "Warranty until"),
    num("value", "Value", { indexed: true }), choice("condition", "Condition", [["Good", "green"], ["Fair", "yellow"], ["Needs repair", "orange"], ["Retired", "gray"]]), text("serial_number", "Serial number", hidden),
  ] },
  { name: "it_tickets", departments: ["IT"], columns: [
    text("subject", "Subject", { required: true, indexed: true }), autonum("number", "Ticket #", "IT-"), link("requester", "Requester", "employees"), link("assignee", "Assignee", "employees"),
    choice("category", "Category", ["Hardware", "Network", "Access", "Software", "Email"]), choice("priority", "Priority", PRIORITIES, { default: "Normal" }),
    choice("status", "Status", [["Open", "orange"], ["In progress", "blue"], ["Resolved", "green"], ["Closed", "gray"]], { default: "Open" }),
    date("opened_on", "Opened", { default: "today" }), date("resolved_on", "Resolved", hidden), link("asset", "Asset", "assets", hidden),
    { name: "details", label: "Details", type: "textarea", ...hidden },
  ] },
  { name: "expenses", departments: ["Sales", "Marketing", "Operations", "IT", "Finance"], columns: [
    text("description", "Expense", { required: true, indexed: true }), choice("category", "Category", EXPENSE_CATEGORIES),
    num("amount", "Amount", { required: true, indexed: true }), date("spent_on", "Spent on", { required: true, default: "today" }), link("submitted_by", "Submitted by", "employees"),
    bool("reimbursed", "Reimbursed"), { name: "receipt", label: "Receipt", type: "image", ...hidden },
  ] },
  { name: "support_tickets", departments: ["Support", "Sales"], columns: [
    text("subject", "Subject", { required: true, indexed: true }), autonum("number", "Ticket #", "TCK-"), link("customer", "Customer", "companies"), link("contact", "Contact", "contacts"),
    link("product", "Product", "products"), choice("priority", "Priority", PRIORITIES, { default: "Normal" }),
    choice("status", "Status", [["Open", "orange"], ["In progress", "blue"], ["Waiting on customer", "yellow"], ["Resolved", "green"]], { default: "Open" }),
    choice("channel", "Channel", ["Email", "Phone", "WhatsApp", "Web form"]), date("opened_on", "Opened", { default: "today" }), bool("resolved", "Resolved"),
    // a "User" column: picks from the login accounts (filter "Assigned to: Me" = my queue)
    { name: "assigned_to", label: "Assigned to", type: "user", default: "$me" },
    { name: "details", label: "Details", type: "textarea", ...hidden },
  ] },
];

const DEPARTMENTS: [string, string][] = [
  ["Sales", "Customers, deals and orders"], ["Marketing", "Campaigns and content"], ["Operations", "Stock, purchasing and delivery"],
  ["Finance", "Payments, payroll and expenses"], ["HR", "People, leave and payroll"], ["IT", "Systems, assets and helpdesk"],
  ["Support", "Customer support"], ["All staff", "Shared lists everyone can use (staff directory, customers, products)"],
];

const V = { view: true }, VCE = { view: true, create: true, edit: true };
const ALL = { view: true, create: true, edit: true, delete: true };
// expense claims are personal: staff see only their own (managers and Finance see all)
const OWN_CLAIMS = { view: true, create: true, own: true };
const ROLES: { name: string; description: string; permissions: Record<string, object> }[] = [
  { name: "Sales rep", description: "Customers, contacts, deals and orders", permissions: { companies: VCE, contacts: VCE, deals: VCE, products: V, orders: VCE, support_tickets: V, expenses: OWN_CLAIMS, employees: V } },
  { name: "Sales manager", description: "Full control of the sales pipeline", permissions: { companies: ALL, contacts: ALL, deals: ALL, products: VCE, orders: ALL, support_tickets: V, expenses: VCE, employees: V } },
  { name: "Marketing", description: "Contacts, campaigns and projects", permissions: { companies: V, contacts: VCE, projects: VCE, tasks: VCE, time_logs: VCE, expenses: OWN_CLAIMS, employees: V } },
  { name: "Operations", description: "Products, purchasing and delivery", permissions: { companies: V, products: VCE, orders: { view: true, edit: true }, suppliers: VCE, purchase_orders: ALL, projects: VCE, tasks: VCE, time_logs: VCE, expenses: OWN_CLAIMS, employees: V } },
  { name: "Finance", description: "Payments, payroll and expenses", permissions: { companies: V, products: V, orders: V, purchase_orders: { view: true, edit: true }, suppliers: V, payroll: VCE, expenses: ALL, employees: V } },
  { name: "HR", description: "Staff directory, payroll and leave", permissions: { employees: ALL, payroll: ALL, leave_requests: ALL } },
  { name: "IT support", description: "Assets, helpdesk and IT projects", permissions: { assets: ALL, it_tickets: ALL, projects: ALL, tasks: ALL, time_logs: ALL, expenses: OWN_CLAIMS, employees: V } },
  { name: "Support agent", description: "Customer tickets", permissions: { support_tickets: ALL, companies: V, contacts: { view: true, edit: true }, products: V, orders: V, employees: V } },
  { name: "Executive", description: "Read-only view of everything", permissions: Object.fromEntries(TABLES.map((t) => [t.name, V])) },
];

const USERS: { username: string; fullName: string; role: string; departments: string[] }[] = [
  { username: "sara", fullName: "Sara Khan", role: "Sales rep", departments: ["Sales"] },
  { username: "arjun", fullName: "Arjun Nair", role: "Sales rep", departments: ["Sales"] },
  { username: "meera", fullName: "Meera Iyer", role: "Sales manager", departments: ["Sales"] },
  { username: "liam", fullName: "Liam D'Souza", role: "Marketing", departments: ["Marketing"] },
  { username: "rahul", fullName: "Rahul Verma", role: "Operations", departments: ["Operations"] },
  { username: "fatima", fullName: "Fatima Sheikh", role: "Operations", departments: ["Operations"] },
  { username: "david", fullName: "David Thomas", role: "Finance", departments: ["Finance", "HR", "Sales", "Marketing", "Operations", "IT"] },
  { username: "anita", fullName: "Anita George", role: "Finance", departments: ["Finance", "HR"] },
  { username: "priya", fullName: "Priya Menon", role: "HR", departments: ["HR"] },
  { username: "joseph", fullName: "Joseph Mathew", role: "HR", departments: ["HR"] },
  { username: "kiran", fullName: "Kiran Rao", role: "IT support", departments: ["IT"] },
  { username: "nikhil", fullName: "Nikhil Joshi", role: "IT support", departments: ["IT"] },
  { username: "ayesha", fullName: "Ayesha Khan", role: "Support agent", departments: ["Support"] },
  { username: "vivek", fullName: "Vivek Pillai", role: "Support agent", departments: ["Support"] },
  { username: "maria", fullName: "Maria Fernandes", role: "Executive", departments: ["Sales", "Marketing", "Operations", "Finance", "HR", "IT", "Support"] },
  { username: "tom", fullName: "Tom Varghese", role: "Marketing", departments: ["Marketing", "Operations"] },
];

/* ============================== bulk insert ============================== */
type Row = { id: string; data: Record<string, unknown>; dept: string | null; createdAt: Date };
const counts: Record<string, number> = {};

// "Created by": a demo user who may add records to the table and belongs to
// the record's department (filled in once the users exist)
const creators = new Map<string, string[]>(); // `${table}|${departmentId}` -> user ids
const userIds: Record<string, string> = {}; // username -> id
const creatorFor = (table: string, dept: string | null) => {
  const candidates = creators.get(`${table}|${dept}`);
  return candidates?.length ? pick(candidates) : null;
};

async function insertRows(table: string, rows: Row[]) {
  for (let i = 0; i < rows.length; i += 2000) {
    const batch = rows.slice(i, i + 2000);
    await query(
      `INSERT INTO ${dataTable(table)} (_id, data, department_id, created_at, updated_at, created_by)
       SELECT * FROM unnest($1::text[], $2::jsonb[], $3::text[], $4::timestamptz[], $5::timestamptz[], $6::text[])`,
      [
        batch.map((r) => r.id),
        batch.map((r) => JSON.stringify(r.data)),
        batch.map((r) => r.dept),
        batch.map((r) => r.createdAt),
        batch.map((r) => new Date(Math.min(TODAY.getTime(), r.createdAt.getTime() + int(0, 30) * 86_400_000))),
        batch.map((r) => creatorFor(table, r.dept)),
      ]
    );
  }
  counts[table] = (counts[table] ?? 0) + rows.length;
}

const createdAround = (dateStr: string) => new Date(new Date(dateStr).getTime() + int(8, 18) * 3_600_000);

/* ================================= main ================================= */
async function main() {
  if (env.isProduction && !process.argv.includes("--force")) {
    console.error("Refusing to load demo data into a production environment without --force.");
    process.exitCode = 1;
    return;
  }
  await migrate();
  await storage.init();
  await ensureInitialAdmin();

  // never mix demo data into a system that already has these tables or users
  for (const t of TABLES) {
    if (await getSchema(t.name)) {
      console.error(`Table "${t.name}" already exists. Wipe it first to start from an empty system: "pnpm db:reset" (or "./deploy.sh wipe" on a deployed server).`);
      process.exitCode = 1;
      return;
    }
  }
  for (const u of USERS) {
    if (await findUserForLogin(u.username)) {
      console.error(`User "${u.username}" already exists. Wipe first: "pnpm db:reset" (or "./deploy.sh wipe").`);
      process.exitCode = 1;
      return;
    }
  }

  const started = Date.now();
  console.log(`Seeding demo company (size: ${sizeArg})…`);

  /* ---------- departments, tables, roles, users ---------- */
  const dept: Record<string, string> = {};
  for (const [name, description] of DEPARTMENTS) dept[name] = (await createDepartment({ name, description }))._id;

  for (const t of TABLES) {
    // indexes are built after the data is loaded (much faster)
    await createTable({ tableName: t.name, columns: t.columns.map((c) => ({ ...c, indexed: false })) });
    await updateTableSettings(t.name, { departmentIds: t.departments.map((d) => dept[d]) });
  }

  const roleIds: Record<string, string> = {};
  for (const r of ROLES) {
    roleIds[r.name] = (await createRole({ name: r.name, description: r.description, permissions: normalizePermissions(r.permissions) }))._id;
  }
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  for (const u of USERS) {
    const created = await createUser({
      username: u.username,
      fullName: u.fullName,
      email: `${u.username}@zenin-demo.example`,
      passwordHash,
      roleId: roleIds[u.role],
      departmentIds: [...u.departments, "All staff"].map((d) => dept[d]),
    });
    userIds[u.username] = created._id;
    const permissions = ROLES.find((r) => r.name === u.role)!.permissions as Record<string, { create?: boolean }>;
    for (const [table, p] of Object.entries(permissions)) {
      if (!p.create) continue;
      for (const d of [...u.departments, "All staff"]) {
        const key = `${table}|${dept[d]}`;
        creators.set(key, [...(creators.get(key) ?? []), created._id]);
      }
    }
  }
  console.log(`  ${DEPARTMENTS.length} departments, ${TABLES.length} tables, ${ROLES.length} roles, ${USERS.length} users`);

  /* ---------- staff directory ---------- */
  const employees: { id: string; name: string; team: string }[] = [];
  const empRows: Row[] = [];
  const usedNames = new Set<string>();
  const addEmployee = async (name: string, team: string, idx: number) => {
    const id = randomUUID();
    const joined = dateBetween(-2600, -20);
    employees.push({ id, name, team });
    empRows.push({
      id, dept: dept["All staff"], createdAt: createdAround(joined),
      data: {
        full_name: name, team: dept[team], job_title: pick(JOBS[team]), email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@zenin-demo.example`,
        phone: `+91 9${int(100000000, 999999999)}`, location: pick(CITIES.slice(0, 8)), joined_on: joined, active: chance(0.94),
        photo: idx < 60 ? await upload(`photo-${idx}.png`, png(int(0, 359)), "image/png") : null,
      },
    });
  };
  for (const [i, u] of USERS.entries()) {
    usedNames.add(u.fullName);
    await addEmployee(u.fullName, u.departments[0] === "Sales" && u.role === "Executive" ? "Sales" : u.departments[0], i);
  }
  while (employees.length < n(180)) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    if (usedNames.has(name) && usedNames.size < FIRST.length * LAST.length) continue;
    usedNames.add(name);
    await addEmployee(name, weighted(TEAMS.map((t) => [t, t === "Sales" || t === "Operations" ? 3 : 2])), employees.length);
  }
  await insertRows("employees", empRows);
  const staffOf = (team: string) => employees.filter((e) => e.team === team);

  /* ---------- CRM ---------- */
  const companies: { id: string; name: string; dept: string }[] = [];
  const companyRows: Row[] = [];
  const usedCompanies = new Set<string>();
  for (let i = 0; companies.length < n(300); i++) {
    let name = `${pick(CO_A)} ${pick(CO_B)} ${pick(CO_C)}`;
    if (usedCompanies.has(name)) name = `${name} ${int(2, 9)}`;
    if (usedCompanies.has(name)) continue;
    usedCompanies.add(name);
    const since = dateBetween(-1800, -10);
    const id = randomUUID();
    companies.push({ id, name, dept: "All staff" });
    companyRows.push({
      id, dept: dept["All staff"], createdAt: createdAround(since),
      data: {
        name, industry: pick(INDUSTRIES), city: pick(CITIES), website: `https://www.${name.toLowerCase().replace(/[^a-z]+/g, "")}.example`,
        employees_count: weighted([[int(5, 50), 4], [int(51, 500), 3], [int(501, 5000), 1]]), annual_revenue: money(2e6, 9e8),
        customer_since: since, key_account: chance(0.15), logo: companies.length <= 40 ? await upload(`logo-${companies.length}.png`, png(int(0, 359)), "image/png") : null,
        notes: chance(0.3) ? "Prefers email.\nPayment terms: Net 30." : "",
      },
    });
  }
  await insertRows("companies", companyRows);

  const contacts: { id: string; company: string }[] = [];
  const contactRows: Row[] = [];
  for (let i = 0; i < n(1000); i++) {
    const company = pick(companies);
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const id = randomUUID();
    contacts.push({ id, company: company.id });
    const created = dateBetween(-700, -1);
    contactRows.push({
      id, dept: dept["All staff"], createdAt: createdAround(created),
      data: {
        full_name: name, company: company.id, job_title: pick(["Purchase Manager", "CEO", "Operations Head", "Accounts", "Store Manager", "IT Lead", "Procurement Officer"]),
        email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@${company.name.toLowerCase().replace(/[^a-z]+/g, "")}.example`,
        phone: `+91 8${int(100000000, 999999999)}`, city: pick(CITIES), last_contacted: chance(0.85) ? dateBetween(-180, 0) : null, newsletter: chance(0.4),
      },
    });
  }
  await insertRows("contacts", contactRows);

  const salesStaff = staffOf("Sales");
  const dealRows: Row[] = [];
  for (let i = 0; i < n(600); i++) {
    const company = pick(companies);
    const stage = weighted(DEAL_STAGES);
    const created = dateBetween(-400, -1);
    const companyContacts = contacts.filter((c) => c.company === company.id);
    dealRows.push({
      id: randomUUID(), dept: dept.Sales, createdAt: createdAround(created),
      data: {
        title: `${company.name.split(" ").slice(0, 2).join(" ")} – ${pick(["annual supply", "pilot order", "renewal", "expansion", "new site", "service contract"])}`,
        company: company.id, contact: companyContacts.length ? pick(companyContacts).id : null, stage,
        value: money(50_000, 4_500_000), probability: { Prospect: 10, Qualified: 25, Proposal: 50, Negotiation: 75, Won: 100, Lost: 0 }[stage],
        expected_close: plusDays(created, int(20, 160)), owner: pick(salesStaff).id,
        notes: `<p>Next step: <strong>${pick(["send proposal", "schedule demo", "negotiate pricing", "site visit", "follow-up call"])}</strong>.</p>`,
      },
    });
  }
  await insertRows("deals", dealRows);

  /* ---------- products & orders ---------- */
  const products: { id: string; name: string; price: number }[] = [];
  const productRows: Row[] = [];
  for (let i = 0; i < n(150); i++) {
    const [base, category, price] = PRODUCT_TYPES[i % PRODUCT_TYPES.length];
    const variant = Math.floor(i / PRODUCT_TYPES.length);
    const name = variant ? `${base} – model ${String.fromCharCode(65 + variant)}` : base;
    const p = Math.round(price * (0.8 + rand() * 0.6));
    const id = randomUUID();
    products.push({ id, name, price: p });
    const photos: string[] = [];
    if (i < 30) for (let k = 0; k < int(1, 2); k++) photos.push(await upload(`product-${i}-${k}.png`, png(int(0, 359)), "image/png"));
    productRows.push({
      id, dept: dept["All staff"], createdAt: createdAround(dateBetween(-900, -30)),
      data: {
        name, sku: `SKU-${10000 + i}`, category, price: p, cost: Math.round(p * (0.55 + rand() * 0.25)), stock: int(0, 900),
        reorder_level: int(10, 80), active: chance(0.9), photos,
        description: `<p><strong>${name}</strong> for industrial and commercial use.</p><ul><li>Warranty: ${int(1, 3)} year(s)</li><li>Category: ${category}</li></ul>`,
      },
    });
  }
  await insertRows("products", productRows);

  const orderRows: Row[] = [];
  for (let i = 0; i < n(4000); i++) {
    const company = pick(companies);
    const orderDate = dateBetween(-540, 0);
    const items = sample(products, int(1, 4));
    const status = weighted(ORDER_STATUSES);
    const number = numbered("SO-", 24000 + i);
    orderRows.push({
      id: randomUUID(), dept: dept[weighted([["Sales", 8], ["Operations", 2], ["Finance", 1]])], createdAt: createdAround(orderDate),
      data: {
        number, customer: company.id, items: items.map((p) => p.id), order_date: orderDate,
        total: Math.round(items.reduce((s, p) => s + p.price * int(1, 40), 0)), status,
        paid: status === "Delivered" ? chance(0.85) : status === "Cancelled" ? false : chance(0.3),
        invoice: i < 40 ? await upload(`invoice-${number}.pdf`, pdf(`Invoice ${number}`, [company.name, `Date: ${orderDate}`, `Items: ${items.length}`]), "application/pdf") : null,
        notes: chance(0.1) ? "Deliver before noon." : "",
      },
    });
  }
  await insertRows("orders", orderRows);

  /* ---------- procurement ---------- */
  const suppliers: string[] = [];
  const supplierRows: Row[] = [];
  for (let i = 0; i < n(60); i++) {
    const id = randomUUID();
    suppliers.push(id);
    supplierRows.push({
      id, dept: dept["All staff"], createdAt: createdAround(dateBetween(-1200, -60)),
      data: {
        name: `${pick(CO_A)} ${pick(["Supply", "Components", "Metals", "Chemicals", "Packaging", "Electricals"])} ${pick(["Co", "Ltd", "LLP"])}${i > 20 ? ` ${i}` : ""}`,
        category: pick(SUPPLIER_CATEGORIES), contact_person: `${pick(FIRST)} ${pick(LAST)}`,
        email: `sales${i}@supplier.example`, phone: `+91 7${int(100000000, 999999999)}`, city: pick(CITIES), rating: int(2, 5), preferred: chance(0.25),
      },
    });
  }
  await insertRows("suppliers", supplierRows);

  const poRows: Row[] = [];
  for (let i = 0; i < n(500); i++) {
    const ordered = dateBetween(-420, 0);
    const status = weighted<string>([["Draft", 1], ["Sent", 2], ["Partially received", 1], ["Received", 6], ["Cancelled", 1]]);
    poRows.push({
      id: randomUUID(), dept: dept[chance(0.8) ? "Operations" : "Finance"], createdAt: createdAround(ordered),
      data: {
        po_number: numbered("PO-", 5000 + i), supplier: pick(suppliers), items: sample(products, int(1, 3)).map((p) => p.id),
        ordered_on: ordered, expected_on: plusDays(ordered, int(5, 45)), amount: money(5_000, 800_000), status, received: status === "Received",
      },
    });
  }
  await insertRows("purchase_orders", poRows);

  /* ---------- HR ---------- */
  const payrollRows: Row[] = [];
  const months = Array.from({ length: 6 }, (_, k) => iso(new Date(Date.UTC(2026, 4 + k, 1))));
  for (const month of months) {
    for (const e of employees.slice(0, n(180))) {
      const basic = Math.round(money(25_000, 180_000) / 100) * 100;
      const allowances = Math.round(basic * (0.1 + rand() * 0.2));
      const deductions = Math.round(basic * (0.08 + rand() * 0.06));
      payrollRows.push({
        id: randomUUID(), dept: dept.HR, createdAt: createdAround(plusDays(month, 27)),
        data: {
          reference: `PAY-${month.slice(0, 7)}-${String(employees.indexOf(e) + 1).padStart(4, "0")}`, employee: e.id, month,
          basic, allowances, deductions, net_pay: basic + allowances - deductions, paid: month < "2026-11-01",
        },
      });
    }
  }
  await insertRows("payroll", payrollRows);

  const leaveRows: Row[] = [];
  for (let i = 0; i < n(700); i++) {
    const from = dateBetween(-300, 60);
    const days = weighted([[1, 5], [2, 3], [3, 2], [5, 1], [10, 0.5]]);
    leaveRows.push({
      id: randomUUID(), dept: dept.HR, createdAt: createdAround(plusDays(from, -int(2, 20))),
      data: {
        reference: numbered("LV-", 1000 + i), employee: pick(employees).id,
        leave_type: weighted<string>([["Casual", 4], ["Sick", 3], ["Earned", 2], ["Work from home", 2], ["Unpaid", 0.5]]),
        from_date: from, to_date: plusDays(from, days - 1), days, status: from > iso(TODAY) ? weighted<string>([["Pending", 3], ["Approved", 2]]) : weighted<string>([["Approved", 8], ["Rejected", 1]]),
        reason: chance(0.5) ? pick(["Family function", "Medical appointment", "Travel", "Personal work", "Festival"]) : "",
      },
    });
  }
  await insertRows("leave_requests", leaveRows);

  /* ---------- projects, tasks, time ---------- */

  const projectTeams = ["IT", "Marketing", "Operations"];
  const projects: { id: string; team: string }[] = [];
  const projectRows: Row[] = [];
  const PROJECT_NAMES: Record<string, string[]> = {
    IT: ["ERP rollout", "Laptop refresh", "Network upgrade", "Website revamp", "Data backup policy", "Helpdesk automation"],
    Marketing: ["Diwali campaign", "Product brochure", "Trade fair 2026", "SEO overhaul", "Customer newsletter", "Brand guidelines"],
    Operations: ["Warehouse layout", "Vendor consolidation", "Fleet tracking", "Inventory audit", "Packaging redesign", "New site setup"],
  };
  for (let i = 0; i < n(30); i++) {
    const team = projectTeams[i % 3];
    const start = dateBetween(-300, 20);
    const id = randomUUID();
    projects.push({ id, team });
    projectRows.push({
      id, dept: dept[team], createdAt: createdAround(plusDays(start, -int(5, 30))),
      data: {
        name: `${PROJECT_NAMES[team][Math.floor(i / 3) % 6]}${i >= 18 ? ` (phase ${Math.floor(i / 18) + 1})` : ""}`, code: `${team.slice(0, 3).toUpperCase()}-${100 + i}`,
        owner: pick(staffOf(team)).id, start_date: start, due_date: plusDays(start, int(30, 200)), budget: money(100_000, 5_000_000),
        progress: int(0, 100), status: pick(["Planning", "Active", "Active", "On hold", "Completed"]),
        description: `<p>Goal: deliver <strong>${PROJECT_NAMES[team][Math.floor(i / 3) % 6].toLowerCase()}</strong> on time and within budget.</p>`,
      },
    });
  }
  await insertRows("projects", projectRows);

  const TASK_VERBS = ["Draft", "Review", "Update", "Fix", "Prepare", "Test", "Plan", "Order", "Configure", "Document", "Migrate", "Design"];
  const TASK_OBJECTS = ["requirements", "vendor quotes", "landing page", "user guide", "network diagram", "budget sheet", "stock count", "campaign brief", "test cases", "access rights", "backup job", "invoice template"];
  const tasks: { id: string; team: string; title: string }[] = [];
  const taskRows: Row[] = [];
  for (let i = 0; i < n(2000); i++) {
    const project = pick(projects);
    const statusName = weighted<string>([["To do", 3], ["In progress", 3], ["In review", 1], ["Blocked", 0.6], ["Done", 5], ["Cancelled", 0.4]]);
    const start = dateBetween(-240, 20);
    const due = plusDays(start, int(2, 40));
    const estimate = pick([2, 4, 6, 8, 12, 16, 24, 40]);
    const progress = statusName === "Done" ? 100 : statusName === "To do" ? 0 : statusName === "In review" ? 90 : int(10, 80);
    const id = randomUUID();
    const title = `${pick(TASK_VERBS)} ${pick(TASK_OBJECTS)}`;
    tasks.push({ id, team: project.team, title });
    taskRows.push({
      id, dept: dept[project.team], createdAt: createdAround(plusDays(start, -int(0, 10))),
      data: {
        title, status: statusName, priority: priority(weighted([[1, 1], [2, 3], [3, 4], [4, 2]])), assignee: pick(staffOf(project.team)).id,
        project: project.id, start_date: start, due_date: due, progress, estimated_hours: estimate,
        hours_spent: Math.round(estimate * (progress / 100) * (0.7 + rand() * 0.8)),
        completed_on: statusName === "Done" ? plusDays(due, int(-5, 6)) : null,
        parent_task: i > 50 && chance(0.12) ? tasks[int(0, tasks.length - 2)].id : null,
        description: `<p>${pick(["Coordinate with the vendor.", "Share the draft by Friday.", "Check last year's numbers first.", "Get sign-off from the lead."])}</p>`,
      },
    });
  }
  await insertRows("tasks", taskRows);

  const logRows: Row[] = [];
  for (let i = 0; i < n(5000); i++) {
    const task = pick(tasks);
    const when = dateBetween(-240, 0);
    logRows.push({
      id: randomUUID(), dept: dept[task.team], createdAt: createdAround(when),
      data: { work_done: `${pick(["Worked on", "Reviewed", "Discussed", "Fixed", "Updated"])} ${task.title.toLowerCase()}`, task: task.id, person: pick(staffOf(task.team)).id, date: when, hours: pick([0.5, 1, 1.5, 2, 3, 4, 6, 8]) },
    });
  }
  await insertRows("time_logs", logRows);

  /* ---------- IT ---------- */
  const assets: string[] = [];
  const assetRows: Row[] = [];
  for (let i = 0; i < n(350); i++) {
    const [type, category, value] = pick(ASSET_TYPES);
    const purchased = dateBetween(-1500, -5);
    const id = randomUUID();
    assets.push(id);
    assetRows.push({
      id, dept: dept.IT, createdAt: createdAround(purchased),
      data: {
        tag: numbered("AST-", 1000 + i), name: `${type} ${pick(["Dell", "HP", "Lenovo", "Apple", "Cisco", "Epson", "Samsung"])}`, category,
        assigned_to: chance(0.85) ? pick(employees).id : null, purchased_on: purchased, warranty_until: plusDays(purchased, pick([365, 730, 1095])),
        value: Math.round(value * (0.8 + rand() * 0.4)), condition: weighted<string>([["Good", 6], ["Fair", 2], ["Needs repair", 1], ["Retired", 0.5]]),
        serial_number: `SN${int(10000000, 99999999)}`,
      },
    });
  }
  await insertRows("assets", assetRows);

  const itStaff = staffOf("IT");
  const itRows: Row[] = [];
  for (let i = 0; i < n(900); i++) {
    const opened = dateBetween(-300, 0);
    const status = opened > plusDays(iso(TODAY), -10) ? weighted<string>([["Open", 3], ["In progress", 2], ["Resolved", 2]]) : weighted<string>([["Resolved", 8], ["Closed", 2], ["Open", 0.5]]);
    itRows.push({
      id: randomUUID(), dept: dept.IT, createdAt: createdAround(opened),
      data: {
        subject: pick(["Laptop won't start", "VPN not connecting", "Printer jam on floor 2", "Need access to shared drive", "Email not syncing", "New joiner setup", "Monitor flickering", "Password reset", "Software install request", "Wi-Fi slow in meeting room"]),
        requester: pick(employees).id, assignee: pick(itStaff).id, category: pick(["Hardware", "Network", "Access", "Software", "Email"]),
        priority: priority(weighted([[1, 1], [2, 3], [3, 5], [4, 2]])), status, opened_on: opened,
        resolved_on: status === "Resolved" || status === "Closed" ? plusDays(opened, int(0, 6)) : null, asset: chance(0.4) ? pick(assets) : null,
        details: "Reported via helpdesk portal.",
      },
    });
  }
  await insertRows("it_tickets", itRows);

  /* ---------- finance ---------- */
  const expenseRows: Row[] = [];
  const expenseTeams = ["Sales", "Marketing", "Operations", "IT", "Finance"];
  for (let i = 0; i < n(1800); i++) {
    const team = weighted<string>(expenseTeams.map((t) => [t, t === "Sales" ? 3 : 2]));
    const spent = dateBetween(-365, 0);
    const category = pick(EXPENSE_CATEGORIES);
    expenseRows.push({
      id: randomUUID(), dept: dept[team], createdAt: createdAround(spent),
      data: {
        description: `${category} – ${pick(["client visit", "team meeting", "conference", "monthly subscription", "site visit", "workshop"])}`, category,
        amount: money(150, 45_000), spent_on: spent, submitted_by: pick(staffOf(team)).id, reimbursed: spent < plusDays(iso(TODAY), -20) ? chance(0.9) : chance(0.3),
        receipt: i < 40 ? await upload(`receipt-${i}.png`, png(int(0, 359), 72), "image/png") : null,
      },
    });
  }
  await insertRows("expenses", expenseRows);

  /* ---------- customer support ---------- */
  const supportRows: Row[] = [];
  for (let i = 0; i < n(1200); i++) {
    const company = pick(companies);
    const opened = dateBetween(-365, 0);
    const resolved = opened < plusDays(iso(TODAY), -14) ? chance(0.92) : chance(0.4);
    const companyContacts = contacts.filter((c) => c.company === company.id);
    supportRows.push({
      id: randomUUID(), dept: dept[chance(0.85) ? "Support" : "Sales"], createdAt: createdAround(opened),
      data: {
        subject: pick(["Delivery delayed", "Wrong item received", "Invoice query", "Product not working", "Request for quotation", "Warranty claim", "Need installation help", "Change delivery address"]),
        customer: company.id, contact: companyContacts.length ? pick(companyContacts).id : null, product: pick(products).id,
        priority: priority(weighted([[1, 1], [2, 3], [3, 5], [4, 2]])), status: resolved ? "Resolved" : pick(["Open", "Waiting on customer", "In progress"]),
        channel: pick(["Email", "Phone", "WhatsApp", "Web form"]), opened_on: opened, resolved, details: "Customer reported the issue; see attached thread.",
        assigned_to: chance(0.9) ? userIds[pick(["ayesha", "vivek"])] : null,
      },
    });
  }
  await insertRows("support_tickets", supportRows);

  /* ---------- finish: indexes, statistics, audit ---------- */
  for (const t of TABLES) {
    await query(`UPDATE table_schemas SET columns = $2::jsonb WHERE table_name = $1`, [
      t.name,
      JSON.stringify((await getSchema(t.name))!.columns.map((c) => ({ ...c, indexed: Boolean(t.columns.find((x) => x.name === c.name)?.indexed) }))),
    ]);
  }
  await invalidateSchemas();
  for (const t of TABLES) {
    await ensureDataTable(t.name);
    const schema = (await getSchema(t.name))!;
    await syncColumnIndexes(schema);
    await query(`ANALYZE ${dataTable(t.name)}`);
    // auto-numbers: number the rows that came without one (oldest first);
    // otherwise new records continue after the demo's numbers
    for (const column of schema.columns.filter((c) => c.type === "autonumber")) {
      const { rowCount } = await query(`SELECT 1 FROM ${dataTable(t.name)} WHERE data ? $1 LIMIT 1`, [column.name]);
      await withTransaction((client) =>
        rowCount ? syncCounterFromData(t.name, column, client) : backfillAutonumber(t.name, column, client)
      );
    }
    // formulas from the stored fields (the generated rows may differ slightly)
    await withTransaction((client) => applyFormulas(schema, null, client));
  }
  for (const t of TABLES) {
    await query(
      `INSERT INTO audit_log (username, action, entity, table_name, changes) VALUES ('system', 'import', 'record', $1, $2::jsonb)`,
      [t.name, JSON.stringify({ inserted: counts[t.name] ?? 0, source: "demo seed" })]
    );
  }

  const total = Object.values(counts).reduce((s, c) => s + c, 0);
  console.log(`  ${total.toLocaleString("en")} records, ${uploads} uploaded files, in ${Math.round((Date.now() - started) / 1000)} s\n`);
  for (const t of TABLES) console.log(`  ${t.name.padEnd(17)} ${String(counts[t.name] ?? 0).padStart(7)}   (${t.departments.join(", ")})`);
  console.log(`\nDemo users (password "${DEMO_PASSWORD}"):`);
  for (const u of USERS) console.log(`  ${u.username.padEnd(8)} ${u.fullName.padEnd(16)} ${u.role.padEnd(14)} ${u.departments.join(", ")}`);
  console.log(`\nAdmin: "${env.adminUsername}" (password from ADMIN_PASSWORD). Restart the API if it was running before a reset.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
