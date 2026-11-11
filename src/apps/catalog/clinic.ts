import { autonum, choice, date, formula, image, link, longText, managerRole, num, OWN, richText, rollup, staffRole, text, user, WORK } from "../dsl.js";
import type { AppBlueprint } from "../types.js";

const ALL_RIGHTS = { view: true, create: true, edit: true, delete: true };

export const clinic: AppBlueprint = {
  key: "clinic",
  version: 1,
  name: "Clinic",
  description: "Patients, appointments, consultations with prescriptions, and bills. Doctors see their own consultations.",
  icon: "IconStethoscope",
  needs: ["products"], // medicines are products (stock them with Inventory)
  tables: [
    {
      key: "patients",
      name: "patients",
      label: "Patients",
      description: "Who you treat, with contact details and allergies",
      optional: false,
      columns: [
        autonum("mrn", "Patient #", "PAT-"),
        text("name", "Name", { required: true, indexed: true }),
        date("dob", "Date of birth", { indexed: false }),
        choice("gender", "Gender", ["Female", "Male", "Other"]),
        text("phone", "Phone"),
        choice("blood_group", "Blood group", ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]),
        longText("allergies", "Allergies"),
        longText("address", "Address", { showInTable: false }),
        image("photo", "Photo", { showInTable: false }),
      ],
    },
    {
      key: "appointments",
      name: "appointments",
      label: "Appointments",
      description: "Who comes when, to see whom",
      columns: [
        link("patient", "Patient", "patients", { required: true }),
        user("doctor", "Doctor"),
        date("date", "Date", { required: true, default: "today" }),
        text("time", "Time"),
        text("reason", "Reason"),
        choice("status", "Status", [["Booked", "blue"], ["Arrived", "orange"], ["Done", "green"], ["Cancelled", "gray"], ["No-show", "red"]], { default: "Booked" }),
      ],
    },
    {
      key: "consultations",
      name: "consultations",
      label: "Consultations",
      description: "The doctor's notes, diagnosis and prescription for a visit",
      columns: [
        link("patient", "Patient", "patients", { required: true }),
        link("appointment", "Appointment", "appointments", { showInTable: false }),
        user("doctor", "Doctor", { default: "$me" }),
        date("date", "Date", { default: "today" }),
        text("diagnosis", "Diagnosis"),
        richText("notes", "Notes", { showInTable: false }),
        date("follow_up", "Follow-up"),
      ],
    },
    {
      key: "prescription_items",
      name: "prescription_items",
      label: "Prescription items",
      description: "Medicines on each consultation, edited inside it",
      optional: false,
      showInMenu: false,
      columns: [
        link("consultation", "Consultation", "consultations", { required: true, inline: true }),
        link("medicine", "Medicine", "products.products", { required: true }),
        text("dose", "Dose"),
        choice("frequency", "Frequency", ["1-0-1", "1-1-1", "1-0-0", "0-0-1", "As needed"], { default: "1-0-1" }),
        num("days", "Days"),
      ],
    },
    {
      key: "bills",
      name: "bills",
      label: "Bills",
      description: "What patients pay: lines, total and balance",
      columns: [
        autonum("number", "Bill #", "BILL-"),
        link("patient", "Patient", "patients", { required: true }),
        date("date", "Date", { default: "today" }),
        rollup("total", "Total", { from: "bill_lines", via: "bill", fn: "sum", field: "amount" }),
        num("paid", "Paid"),
        formula("balance", "Balance", "{total} - {paid}"),
        choice("status", "Status", [["Unpaid", "orange"], ["Paid", "green"]], { default: "Unpaid" }),
      ],
    },
    {
      key: "bill_lines",
      name: "bill_lines",
      label: "Bill lines",
      description: "The charges on each bill, edited inside it",
      optional: false,
      showInMenu: false,
      columns: [
        link("bill", "Bill", "bills", { required: true, inline: true }),
        text("description", "Description", { required: true }),
        num("qty", "Qty", { default: 1, required: true }),
        num("rate", "Rate", { required: true }),
        formula("amount", "Amount", "ROUND({qty} * {rate}, 2)"),
      ],
    },
  ],
  roles: [
    managerRole(),
    // front desk and doctors share Staff; doctors see the consultations they're the Doctor on
    staffRole({
      patients: WORK,
      appointments: WORK,
      consultations: OWN(WORK),
      prescription_items: ALL_RIGHTS,
      bills: WORK,
      bill_lines: ALL_RIGHTS,
    }),
  ],
  sample: (ctx) => ({
    patients: [
      { $id: "anu", name: "Anu Thomas", dob: "1988-04-12", gender: "Female", phone: "+91 98470 22222", blood_group: "B+", allergies: "Penicillin" },
      { $id: "joel", name: "Joel Mathew", dob: "2015-09-03", gender: "Male", blood_group: "O+" },
    ],
    appointments: [
      { $id: "a1", patient: "@patients:anu", doctor: ctx.me, date: ctx.date(0), time: "10:30", reason: "Fever and cough", status: "Arrived" },
      { patient: "@patients:joel", doctor: ctx.me, date: ctx.date(1), time: "16:00", reason: "Vaccination", status: "Booked" },
    ],
    consultations: [
      { $id: "c1", patient: "@patients:anu", appointment: "@appointments:a1", doctor: ctx.me, date: ctx.date(0), diagnosis: "Viral fever", follow_up: ctx.date(5) },
    ],
    bills: [{ $id: "b1", patient: "@patients:anu", date: ctx.date(0), paid: 300 }],
    bill_lines: [
      { bill: "@bills:b1", description: "Consultation", qty: 1, rate: 500 },
      { bill: "@bills:b1", description: "Blood test (CBC)", qty: 1, rate: 350 },
    ],
  }),
};
