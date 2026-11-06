/**
 * Keyline backend as a Netlify Function (serverless).
 * Data is stored as one JSON document in Netlify Blobs, so no separate server or database is needed.
 * Routes are the same as the Express version: /api/auth/login, /api/properties, /api/stats ...
 */
import { getStore } from "@netlify/blobs";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "change-this-secret-before-sharing";

const RES = {
  properties: { cols: ["name", "address", "type", "units", "rent", "affordable", "status"], req: ["name", "address"] },
  tenants:    { cols: ["name", "phone", "email", "property_id", "unit", "rent", "category", "lease_start", "lease_end"], req: ["name", "property_id"] },
  payments:   { cols: ["tenant_id", "amount", "month", "paid_on", "method"], req: ["tenant_id", "amount", "month"] },
  requests:   { cols: ["tenant_id", "property_id", "issue", "priority", "status"], req: ["issue"] }
};
const NUM = new Set(["units", "rent", "affordable", "property_id", "tenant_id", "amount"]);

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const today = () => new Date().toISOString().slice(0, 10);

function seed() {
  const m = today().slice(0, 7);
  return {
    seq: { users: 1, properties: 3, tenants: 3, payments: 1, requests: 1, enquiries: 0 },
    users: [{ id: 1, name: "Site Admin", email: "admin@keyline.org", password_hash: bcrypt.hashSync("Admin@123", 10), role: "admin" }],
    properties: [
      { id: 1, name: "Maple Court", address: "RS Puram, Coimbatore", type: "Apartment", units: 24, rent: 36000, affordable: 0, status: "Occupied" },
      { id: 2, name: "Asha Nagar Homes", address: "Ganapathy, Coimbatore", type: "Community housing", units: 40, rent: 4500, affordable: 1, status: "Occupied" },
      { id: 3, name: "Trident Business Park", address: "Avinashi Road, Coimbatore", type: "Commercial", units: 6, rent: 160000, affordable: 0, status: "Available" }
    ],
    tenants: [
      { id: 1, name: "Priya Raman", phone: "9876500011", email: "priya@example.com", property_id: 1, unit: "A-101", rent: 32000, category: "Standard", lease_start: "2026-01-01", lease_end: "2026-12-31" },
      { id: 2, name: "Lakshmi Devi", phone: "9876500022", email: null, property_id: 2, unit: "B-07", rent: 3000, category: "Beneficiary", lease_start: "2026-03-01", lease_end: "2027-02-28" },
      { id: 3, name: "Murugan K", phone: "9876500033", email: null, property_id: 2, unit: "B-12", rent: 3000, category: "Beneficiary", lease_start: "2026-04-01", lease_end: "2027-03-31" }
    ],
    payments: [{ id: 1, tenant_id: 1, amount: 32000, month: m, paid_on: today(), method: "UPI" }],
    requests: [{ id: 1, tenant_id: 2, property_id: 2, issue: "Water tap leaking in kitchen", priority: "High", status: "Open", created_at: today() }],
    enquiries: []
  };
}

function view(db, table) {
  const name = (list, id) => (list.find(x => x.id === id) || {}).name || null;
  let rows = db[table].map(r => ({ ...r }));
  if (table === "tenants") rows.forEach(r => (r.property_name = name(db.properties, r.property_id)));
  if (table === "payments") rows.forEach(r => (r.tenant_name = name(db.tenants, r.tenant_id)));
  if (table === "requests") rows.forEach(r => { r.tenant_name = name(db.tenants, r.tenant_id); r.property_name = name(db.properties, r.property_id); });
  return rows.reverse();
}

function stats(db) {
  const month = today().slice(0, 7);
  const soon = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  const paidIds = new Set(db.payments.filter(p => p.month === month).map(p => p.tenant_id));
  const sum = (a, f) => a.reduce((t, x) => t + (Number(f(x)) || 0), 0);
  return {
    month,
    properties: db.properties.length,
    units: sum(db.properties, p => p.units),
    tenants: db.tenants.length,
    beneficiaryFamilies: db.tenants.filter(t => t.category === "Beneficiary").length,
    affordableProperties: db.properties.filter(p => p.affordable == 1).length,
    expectedRent: sum(db.tenants, t => t.rent),
    collectedRent: sum(db.payments.filter(p => p.month === month), p => p.amount),
    unpaidTenants: db.tenants.filter(t => !paidIds.has(t.id)).length,
    openRequests: db.requests.filter(r => r.status !== "Resolved").length,
    leasesEndingSoon: db.tenants.filter(t => t.lease_end && t.lease_end >= today() && t.lease_end <= soon).length
  };
}

export async function handle(req, store) {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;
  const body = ["POST", "PUT"].includes(method) ? await req.json().catch(() => ({})) : {};

  let db = await store.get("db", { type: "json" });
  if (!db) { db = seed(); await store.setJSON("db", db); }
  const save = () => store.setJSON("db", db);
  const nextId = t => ++db.seq[t];

  /* ----- public routes ----- */
  if (parts[0] === "auth" && parts[1] === "login" && method === "POST") {
    const u = db.users.find(x => x.email === String(body.email || "").trim().toLowerCase());
    if (!u || !bcrypt.compareSync(String(body.password || ""), u.password_hash)) return json({ error: "Incorrect email or password" }, 401);
    const user = { id: u.id, name: u.name, email: u.email, role: u.role };
    return json({ token: jwt.sign(user, SECRET, { expiresIn: "8h" }), user });
  }
  if (parts[0] === "contact" && method === "POST") {
    if (!body.name || !body.email) return json({ error: "Name and email are required" }, 400);
    db.enquiries.push({ id: nextId("enquiries"), name: String(body.name).slice(0, 100), email: String(body.email).slice(0, 100),
      role: String(body.role || "").slice(0, 40), message: String(body.message || "").slice(0, 2000), created_at: new Date().toISOString().replace("T", " ").slice(0, 19) });
    await save();
    return json({ ok: true }, 201);
  }

  /* ----- everything below needs a valid login ----- */
  let user;
  try { user = jwt.verify((req.headers.get("authorization") || "").replace("Bearer ", ""), SECRET); }
  catch { return json({ error: "Please log in again" }, 401); }
  const admin = user.role === "admin";

  if (parts[0] === "auth" && parts[1] === "register" && method === "POST") {
    if (!admin) return json({ error: "Admin access required" }, 403);
    const { name, email, password, role } = body;
    if (!name || !email || !password || password.length < 8) return json({ error: "Name, email and a password of 8+ characters are required" }, 400);
    if (db.users.some(u => u.email === email.trim().toLowerCase())) return json({ error: "Already exists" }, 400);
    const id = nextId("users");
    db.users.push({ id, name, email: email.trim().toLowerCase(), password_hash: bcrypt.hashSync(password, 10), role: role === "admin" ? "admin" : "staff" });
    await save();
    return json({ id }, 201);
  }
  if (parts[0] === "stats" && method === "GET") return json(stats(db));
  if (parts[0] === "enquiries" && method === "GET") return json([...db.enquiries].reverse());

  const cfg = RES[parts[0]];
  if (!cfg) return json({ error: "Not found" }, 404);
  const table = parts[0], id = Number(parts[1]);

  if (method === "GET" && !parts[1]) return json(view(db, table));

  if (method === "POST" || method === "PUT") {
    const o = {};
    for (const c of cfg.cols) {
      const v = body[c];
      o[c] = v === "" || v === undefined || v === null ? null : NUM.has(c) ? Number(v) : String(v).slice(0, 500);
    }
    const missing = cfg.req.filter(c => o[c] === null || Number.isNaN(o[c]));
    if (missing.length) return json({ error: `Missing: ${missing.join(", ")}` }, 400);
    if (o.property_id && !db.properties.some(p => p.id === o.property_id)) return json({ error: "Related record not found" }, 400);
    if (o.tenant_id && !db.tenants.some(t => t.id === o.tenant_id)) return json({ error: "Related record not found" }, 400);

    if (method === "POST") {
      const rec = { id: nextId(table), ...o };
      if (table === "requests") rec.created_at = today();
      db[table].push(rec);
      await save();
      return json({ id: rec.id }, 201);
    }
    const i = db[table].findIndex(r => r.id === id);
    if (i < 0) return json({ error: "Not found" }, 404);
    db[table][i] = { ...db[table][i], ...o };
    await save();
    return json({ ok: true });
  }

  if (method === "DELETE") {
    if (!admin) return json({ error: "Admin access required" }, 403);
    if (!db[table].some(r => r.id === id)) return json({ error: "Not found" }, 404);
    db[table] = db[table].filter(r => r.id !== id);
    if (table === "properties") {
      const gone = db.tenants.filter(t => t.property_id === id).map(t => t.id);
      db.tenants = db.tenants.filter(t => t.property_id !== id);
      db.payments = db.payments.filter(p => !gone.includes(p.tenant_id));
      db.requests.forEach(r => { if (r.property_id === id) r.property_id = null; if (gone.includes(r.tenant_id)) r.tenant_id = null; });
    }
    if (table === "tenants") {
      db.payments = db.payments.filter(p => p.tenant_id !== id);
      db.requests.forEach(r => { if (r.tenant_id === id) r.tenant_id = null; });
    }
    await save();
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}

export default async (req) => {
  try { return await handle(req, getStore({ name: "keyline", consistency: "strong" })); }
  catch (e) { console.error(e); return json({ error: "Server error" }, 500); }
};

export const config = { path: "/api/*" };
