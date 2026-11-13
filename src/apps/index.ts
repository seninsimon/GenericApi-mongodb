import { BUNDLES } from "./bundles.js";
import { assets } from "./catalog/assets.js";
import { billing } from "./catalog/billing.js";
import { clinic } from "./catalog/clinic.js";
import { customers, people, products } from "./catalog/core.js";
import { crm } from "./catalog/crm.js";
import { expenses } from "./catalog/expenses.js";
import { helpdesk } from "./catalog/helpdesk.js";
import { hr } from "./catalog/hr.js";
import { inventory } from "./catalog/inventory.js";
import { ngo } from "./catalog/ngo.js";
import { payroll } from "./catalog/payroll.js";
import { projects } from "./catalog/projects.js";
import { school } from "./catalog/school.js";
import type { AppBlueprint, BundleBlueprint } from "./types.js";

// Every app and organization type the installer knows.
export const APPS: AppBlueprint[] = [
  people,
  customers,
  products,
  projects,
  hr,
  payroll,
  crm,
  helpdesk,
  billing,
  inventory,
  expenses,
  assets,
  clinic,
  school,
  ngo,
];
export const APP_BY_KEY = new Map(APPS.map((a) => [a.key, a]));
export const BUNDLE_BY_KEY = new Map<string, BundleBlueprint>(BUNDLES.map((b) => [b.key, b]));
export { BUNDLES };

// Apps that share a sidebar group show as one app in the launcher.
const GROUPS: Record<string, { icon: string; description: string }> = {
  Company: { icon: "IconBuildingSkyscraper", description: "People, customers and products that your other apps share" },
};

// The launcher entry ("app") a table belongs to: its app, or the group its
// app is in ("Company"). null for your own tables and unknown apps.
export function launcherApp(appKey: string | null): { key: string; name: string; icon: string; description: string } | null {
  const app = appKey ? APP_BY_KEY.get(appKey) : undefined;
  if (!app) return null;
  if (app.group && app.group !== app.name) {
    const group = GROUPS[app.group];
    return {
      key: app.group.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name: app.group,
      icon: group?.icon ?? app.icon,
      description: group?.description ?? app.description,
    };
  }
  return { key: app.key, name: app.name, icon: app.icon, description: app.description };
}

// "projects" + "tasks" -> "projects.tasks"; refs inside an app may leave out the app
export const fullKey = (app: AppBlueprint, key: string) => (key.includes(".") ? key : `${app.key}.${key}`);
