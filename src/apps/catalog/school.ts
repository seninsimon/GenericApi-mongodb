import { autonum, choice, date, formula, image, link, managerRole, num, staffRole, text, user, VIEW, WORK } from "../dsl.js";
import type { AppBlueprint } from "../types.js";

const ALL_RIGHTS = { view: true, create: true, edit: true, delete: true };

export const school: AppBlueprint = {
  key: "school",
  version: 1,
  name: "School",
  description: "Classes and students, daily attendance, exams with marks, and fees with what's still due.",
  icon: "IconSchool",
  tables: [
    {
      key: "classes",
      name: "classes",
      label: "Classes",
      description: "Classes or batches, with a class teacher",
      optional: false,
      columns: [text("name", "Class", { required: true, indexed: true }), user("teacher", "Class teacher"), text("room", "Room")],
    },
    {
      key: "students",
      name: "students",
      label: "Students",
      description: "Who studies here, in which class, and their guardian",
      optional: false,
      columns: [
        autonum("admission", "Admission #", "STU-"),
        text("name", "Name", { required: true, indexed: true }),
        link("class", "Class", "classes"),
        date("dob", "Date of birth", { indexed: false }),
        text("guardian", "Guardian"),
        text("phone", "Phone"),
        image("photo", "Photo", { showInTable: false }),
      ],
    },
    {
      key: "subjects",
      name: "subjects",
      label: "Subjects",
      description: "What each class learns, and who teaches it",
      columns: [text("name", "Subject", { required: true }), link("class", "Class", "classes"), user("teacher", "Teacher")],
    },
    {
      key: "attendance",
      name: "student_attendance",
      label: "Attendance",
      description: "One row per student per day",
      columns: [
        link("student", "Student", "students", { required: true }),
        date("date", "Date", { required: true, default: "today" }),
        choice("status", "Status", [["Present", "green"], ["Absent", "red"], ["Late", "yellow"], ["Leave", "orange"]], { default: "Present" }),
      ],
    },
    {
      key: "exams",
      name: "exams",
      label: "Exams",
      description: "Tests and exams, with each student's marks inside",
      columns: [text("name", "Exam", { required: true }), link("class", "Class", "classes"), date("date", "Date")],
    },
    {
      key: "marks",
      name: "marks",
      label: "Marks",
      description: "Each student's marks in an exam, edited inside the exam",
      optional: false,
      showInMenu: false,
      columns: [
        link("exam", "Exam", "exams", { required: true, inline: true }),
        link("student", "Student", "students", { required: true }),
        link("subject", "Subject", "subjects"),
        num("marks", "Marks", { required: true }),
        num("max", "Out of", { default: 100 }),
        formula("percent", "%", "ROUND({marks} / {max} * 100, 1)"),
      ],
    },
    {
      key: "fees",
      name: "fees",
      label: "Fees",
      description: "What each student owes per term, and what's paid",
      columns: [
        autonum("number", "Fee #", "FEE-"),
        link("student", "Student", "students", { required: true }),
        choice("term", "Term", ["Term 1", "Term 2", "Term 3", "Annual"]),
        num("amount", "Amount", { required: true }),
        date("due", "Due"),
        num("paid", "Paid"),
        formula("balance", "Balance", "{amount} - {paid}"),
        choice("status", "Status", [["Due", "orange"], ["Partly paid", "yellow"], ["Paid", "green"]], { default: "Due" }),
      ],
    },
  ],
  dashboard: {
    tiles: [
      { label: "Fees still due", table: "fees", filters: [{ field: "balance", op: "gt", value: 0 }] },
      { label: "Absent today", table: "attendance", filters: [{ field: "date", op: "eq", value: "$today" }, { field: "status", op: "in", value: ["Absent"] }] },
    ],
  },
  roles: [managerRole(), staffRole({ classes: VIEW, students: VIEW, subjects: VIEW, attendance: WORK, exams: WORK, marks: ALL_RIGHTS, fees: VIEW })],
  sample: (ctx) => ({
    classes: [{ $id: "c7", name: "Class 7 A", teacher: ctx.me, room: "201" }],
    students: [
      { $id: "s1", name: "Aditi Nair", class: "@classes:c7", guardian: "Suresh Nair", phone: "+91 98950 33333" },
      { $id: "s2", name: "Farhan Ali", class: "@classes:c7", guardian: "Imran Ali" },
    ],
    subjects: [
      { $id: "math", name: "Mathematics", class: "@classes:c7", teacher: ctx.me },
      { $id: "sci", name: "Science", class: "@classes:c7" },
    ],
    attendance: [
      { student: "@students:s1", date: ctx.date(-1), status: "Present" },
      { student: "@students:s2", date: ctx.date(-1), status: "Late" },
    ],
    exams: [{ $id: "mid", name: "Mid-term", class: "@classes:c7", date: ctx.date(-14) }],
    marks: [
      { exam: "@exams:mid", student: "@students:s1", subject: "@subjects:math", marks: 88, max: 100 },
      { exam: "@exams:mid", student: "@students:s2", subject: "@subjects:math", marks: 34, max: 50 },
    ],
    fees: [
      { student: "@students:s1", term: "Term 1", amount: 18000, due: ctx.date(10), paid: 18000, status: "Paid" },
      { student: "@students:s2", term: "Term 1", amount: 18000, due: ctx.date(10), paid: 9000, status: "Partly paid" },
    ],
  }),
};
