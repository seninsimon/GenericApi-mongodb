import { autonum, choice, date, formula, link, managerRole, num, OWN, richText, rollup, staffRole, text, user, VIEW, WORK } from "../dsl.js";
import type { AppBlueprint } from "../types.js";

export const projects: AppBlueprint = {
  key: "projects",
  version: 2, // 2: hours and open-task totals
  name: "Projects",
  description: "Projects, tasks with status and priority, and time logs. Who is doing what, by when.",
  icon: "IconChecklist",
  tables: [
    {
      key: "projects",
      name: "projects",
      label: "Projects",
      description: "Groups tasks, with an owner, dates and a budget",
      columns: [
        text("name", "Project", { required: true, indexed: true }),
        autonum("code", "Code", "PRJ-"),
        user("owner", "Owner", { default: "$me" }),
        choice("status", "Status", [["Planned", "gray"], ["Active", "blue"], ["On hold", "orange"], ["Done", "green"]], { default: "Planned" }),
        date("start", "Start", { default: "today" }),
        date("due", "Due"),
        num("budget", "Budget"),
        rollup("open_tasks", "Open tasks", { from: "tasks", via: "project", fn: "count", where: { column: "status", notIn: ["Done"] } }),
        rollup("hours", "Hours logged", { from: "tasks", via: "project", fn: "sum", field: "hours" }),
        richText("description", "Description", { showInTable: false }),
      ],
    },
    {
      key: "tasks",
      name: "tasks",
      label: "Tasks",
      description: "The work items: status, priority, assignee and due date",
      optional: false,
      columns: [
        text("title", "Task", { required: true, indexed: true }),
        link("project", "Project", "projects"),
        choice("status", "Status", [["To do", "gray"], ["Doing", "blue"], ["Review", "violet"], ["Done", "green"]], { required: true, default: "To do" }),
        choice("priority", "Priority", [["Urgent", "red"], ["High", "orange"], ["Normal", "blue"], ["Low", "gray"]], { default: "Normal" }),
        user("assignee", "Assignee", { default: "$me" }),
        date("start", "Start"),
        date("due", "Due"),
        num("estimate", "Estimate (h)"),
        rollup("hours", "Hours logged", { from: "time_logs", via: "task", fn: "sum", field: "hours" }),
        link("parent", "Parent task", "tasks", { showInTable: false }),
        richText("description", "Description", { showInTable: false }),
      ],
    },
    {
      key: "time_logs",
      name: "time_logs",
      label: "Time logs",
      description: "Hours worked on each task, by whom and when (timesheets)",
      columns: [
        text("work_done", "Work done", { required: true }),
        link("task", "Task", "tasks", { required: true }),
        user("person", "Person", { required: true, default: "$me" }),
        date("date", "Date", { required: true, default: "today" }),
        num("hours", "Hours", { required: true }),
        formula("days", "Days (8 h)", "ROUND({hours} / 8, 2)", { showInTable: false }),
      ],
    },
  ],
  roles: [
    managerRole(),
    // everyone in the team sees the team's tasks; time logs are personal
    staffRole({ projects: VIEW, tasks: WORK, time_logs: OWN(WORK) }),
  ],
  sample: (ctx) => ({
    projects: [
      { $id: "web", name: "Website refresh", status: "Active", start: ctx.date(-20), due: ctx.date(40), budget: 250000, owner: ctx.me },
      { $id: "move", name: "Office move", status: "Planned", start: ctx.date(10), due: ctx.date(70), owner: ctx.me },
    ],
    tasks: [
      { $id: "brief", title: "Write the content brief", project: "@projects:web", status: "Done", priority: "High", assignee: ctx.me, due: ctx.date(-5), estimate: 6 },
      { $id: "design", title: "Design the home page", project: "@projects:web", status: "Doing", priority: "High", assignee: ctx.me, due: ctx.date(7), estimate: 16 },
      { title: "Review page copy", project: "@projects:web", status: "To do", priority: "Normal", due: ctx.date(14), parent: "@tasks:design" },
      { title: "Set up analytics", project: "@projects:web", status: "To do", priority: "Low", due: ctx.date(30) },
      { title: "Get quotes from movers", project: "@projects:move", status: "To do", priority: "Urgent", assignee: ctx.me, due: ctx.date(3) },
    ],
    time_logs: [
      { work_done: "Interviews and outline", task: "@tasks:brief", person: ctx.me, date: ctx.date(-8), hours: 4 },
      { work_done: "First draft", task: "@tasks:brief", person: ctx.me, date: ctx.date(-6), hours: 3 },
      { work_done: "Wireframes", task: "@tasks:design", person: ctx.me, date: ctx.date(-1), hours: 5 },
    ],
  }),
};
