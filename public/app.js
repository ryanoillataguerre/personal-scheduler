// Dayloop phone app. Plain JavaScript, no build step.
const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");
const sheet = $("#sheet");
const DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const PRIORITY = { 1: "Critical", 2: "High", 3: "Normal", 4: "Low" };

let S = null; // latest state from the server
let openBlock = null; // id of the block whose actions are showing
let hoursDraft = null; // unsaved edits on the Hours tab

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const tab = () => (location.hash.slice(1) || "plan").split("/")[0];

// ---- Talking to the server -------------------------------------------------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "X-Dayloop": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

/** Make a change, then redraw with the state the server sends back. */
async function act(method, path, body, done) {
  try {
    S = await api(method, path, body);
    if (done) toast(done);
    render(true);
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

async function refresh() {
  try {
    S = await api("GET", "/api/state");
    render();
  } catch (e) {
    if (!S) view.innerHTML = `<div class="empty"><h1>Can't reach Dayloop</h1><p>${esc(e.message)} Check that the server is running and that this phone is on Tailscale.</p></div>`;
  }
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

// ---- Formatting ------------------------------------------------------------

const zone = () => S.settings.zone;
const fmt = (opts) => new Intl.DateTimeFormat(undefined, { timeZone: zone(), ...opts });
const time = (ms) => fmt({ hour: "numeric", minute: "2-digit" }).format(ms);
const dayKey = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: zone() }).format(ms);
function dayName(ms) {
  const key = dayKey(ms);
  const date = fmt({ month: "short", day: "numeric" }).format(ms);
  if (key === dayKey(S.now)) return ["Today", date];
  if (key === dayKey(S.now + 86400000)) return ["Tomorrow", date];
  return [fmt({ weekday: "long" }).format(ms), date];
}
function dur(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
const when = (ms) => `${dayName(ms)[0]} ${time(ms)}`;
const taskById = () => Object.fromEntries(S.tasks.map((t) => [t.id, t]));
const places = () =>
  [...new Set([
    ...S.tasks.map((t) => t.location),
    ...Object.values(S.hours.weekly).flat().map((r) => r.location),
    ...Object.values(S.hours.overrides).flat().map((r) => r.location),
  ].filter(Boolean))].sort();

// ---- Plan ------------------------------------------------------------------

function notices() {
  const out = [];
  const tasks = taskById();
  if (S.google.error) out.push(`Google Calendar: ${esc(S.google.error)}`);
  else if (!S.google.connected) out.push(`Not connected to Google Calendar, so blocks only show here. <a href="#settings">Connect it in Settings.</a>`);
  const un = S.plan.unscheduled.filter((u) => tasks[u.taskId]);
  if (un.length) {
    const names = un.map((u) => `${esc(tasks[u.taskId].title)} (${dur(u.minutes)})`).join(", ");
    out.push(`No room in the next ${S.settings.horizonDays} days for: ${names}. Add hours, tag hours with the place it needs, or shorten its minimum piece.`);
  }
  return out.map((n) => `<p class="notice">${n}</p>`).join("");
}

function blockHtml(b, t) {
  const live = b.status === "planned" && b.start <= S.now && S.now < b.end;
  const ask = b.status === "planned" && b.end <= S.now;
  const open = live || ask || openBlock === b.id;
  const mins = (b.end - b.start) / 60000;
  const state = b.status === "done" ? "done" : live ? "now" : ask ? "ask" : "";
  const meta = [dur(mins), t.location].filter(Boolean).join(", ");
  let actions = "";
  if (b.status === "planned" && open) {
    actions = live
      ? `<button class="btn" data-do="done">Done</button><button class="btn ghost" data-do="skip">Not now</button>`
      : ask
        ? `<button class="btn" data-do="done">I did it</button><button class="btn ghost" data-do="skip">Didn't do it</button>`
        : `<button class="btn" data-do="done">Done already</button><button class="btn ghost" data-do="edit">Edit task</button>`;
    actions = `<div class="actions">${actions}</div>`;
  }
  const lead = ask ? "Did you do this? " : live ? "Now, " : "";
  return `<div class="block p${t.priority} ${state}" data-block="${b.id}" data-task="${t.id}" style="--h:${Math.min(9, Math.max(3.5, mins / 20))}rem">
    <div class="time"><b>${time(b.start)}</b><span>${time(b.end)}</span></div>
    <div class="body" ${b.status === "planned" && !live && !ask ? 'role="button" tabindex="0"' : ""}>
      <div class="title">${esc(t.title)}</div>
      <div class="meta">${lead}${esc(meta)}</div>${actions}
    </div>
  </div>`;
}

function planView() {
  const tasks = taskById();
  const blocks = S.blocks.filter((b) => tasks[b.taskId]);
  const today = dayKey(S.now);
  const left = blocks.filter((b) => b.status === "planned" && dayKey(b.start) === today);
  const leftMin = left.reduce((s, b) => s + (b.end - Math.max(b.start, S.now)) / 60000, 0);
  const sub = left.length
    ? `${left.length} ${left.length === 1 ? "block" : "blocks"} left today, ${dur(Math.max(0, leftMin))} of work.`
    : S.tasks.some((t) => t.status === "open")
      ? "Nothing more planned for today."
      : "";
  let html = `<h1>${fmt({ weekday: "long", month: "long", day: "numeric" }).format(S.now)}</h1><p class="sub">${sub}</p>${notices()}`;

  if (!blocks.length) {
    const hasOpen = S.tasks.some((t) => t.status === "open");
    return html + `<div class="empty"><p>${
      hasOpen
        ? "Your tasks don't fit anywhere yet. Check your hours and the places they're tagged with."
        : "No tasks yet. Add one with the + button and it's placed into your next open hours."
    }</p></div>`;
  }
  let current = null;
  for (const b of blocks) {
    const key = dayKey(b.start);
    if (key !== current) {
      if (current) html += "</section>";
      const [name, date] = dayName(b.start);
      html += `<section class="day"><h2>${name} <span>${date}</span></h2>`;
      current = key;
    }
    html += blockHtml(b, tasks[b.taskId]);
  }
  return html + "</section>";
}

// ---- Tasks -----------------------------------------------------------------

function tasksView() {
  const open = S.tasks.filter((t) => t.status === "open");
  const finished = S.tasks.filter((t) => t.status === "done").sort((a, b) => b.completedAt - a.completedAt);
  const next = {};
  for (const b of S.blocks) if (b.status === "planned" && !(b.taskId in next)) next[b.taskId] = b.start;
  const total = open.reduce((s, t) => s + Math.max(0, t.durationMin - t.doneMin), 0);
  let html = `<h1>Tasks</h1><p class="sub">${open.length ? `${open.length} open, ${dur(total)} left to do.` : "Nothing open."}</p>`;
  for (const t of open) {
    const missed = t.missedCount ? `, missed ${t.missedCount === 1 ? "once" : t.missedCount + " times"}` : "";
    const meta = [`${dur(t.durationMin - t.doneMin)} left`, t.location].filter(Boolean).join(", ") + missed;
    html += `<button class="task p${t.priority}" data-edit="${t.id}">
      <span class="pri" aria-label="Priority ${t.priority}, ${PRIORITY[t.priority]}">${t.priority}</span>
      <span><span class="title">${esc(t.title)}</span>
        <span class="meta">${esc(meta)}</span>
        <span class="meta">${next[t.id] ? "Next: " + esc(when(next[t.id])) : "No room in your hours yet"}</span>
        ${t.doneMin ? `<span class="bar"><i style="width:${Math.min(100, (t.doneMin / t.durationMin) * 100)}%"></i></span>` : ""}</span>
    </button>`;
  }
  if (finished.length) {
    html += `<h2>Finished this week</h2>`;
    for (const t of finished) {
      html += `<button class="task finished" data-edit="${t.id}"><span class="pri">✓</span>
        <span><span class="title">${esc(t.title)}</span><span class="meta">Finished ${esc(dayName(t.completedAt)[0].toLowerCase())}</span></span></button>`;
    }
  }
  return html;
}

function taskSheet(t) {
  const isNew = !t;
  t = t || { title: "", priority: 2, durationMin: 60, minChunkMin: 30, location: "", notes: "" };
  sheet.innerHTML = `<form method="dialog">
    <h2>${isNew ? "New task" : "Edit task"}</h2>
    <label for="f-title">What needs doing</label>
    <input id="f-title" name="title" type="text" value="${esc(t.title)}" maxlength="200" required autocomplete="off">
    <span class="label" id="l-pri">Priority</span>
    <div class="picks" role="radiogroup" aria-labelledby="l-pri">
      ${[1, 2, 3, 4].map((p) => `<label class="pick p${p}"><input type="radio" name="priority" value="${p}" ${t.priority === p ? "checked" : ""}><span><b>${p}</b>${PRIORITY[p]}</span></label>`).join("")}
    </div>
    <div class="row">
      <div><label for="f-dur">Total time</label>
        <div class="unit"><input id="f-dur" name="durationMin" type="number" inputmode="numeric" min="5" max="6000" step="5" value="${t.durationMin}" required><span>min</span></div></div>
      <div><label for="f-chunk">Smallest piece</label>
        <div class="unit"><input id="f-chunk" name="minChunkMin" type="number" inputmode="numeric" min="5" max="6000" step="5" value="${t.minChunkMin}" required><span>min</span></div></div>
    </div>
    <p class="hint">The task can be split across open time, but never into pieces shorter than the smallest piece. Set both the same to keep it in one sitting.</p>
    <label for="f-loc">Where it has to happen</label>
    <input id="f-loc" name="location" type="text" value="${esc(t.location ?? "")}" list="places" placeholder="Anywhere" autocapitalize="none" autocomplete="off">
    <datalist id="places">${places().map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
    <p class="hint">Leave empty if it can be done anywhere. Otherwise it's only planned into hours tagged with this place.</p>
    <label for="f-notes">Notes</label>
    <textarea id="f-notes" name="notes" maxlength="2000">${esc(t.notes)}</textarea>
    <div class="foot">
      <button class="btn" value="save">${isNew ? "Add task" : "Save changes"}</button>
      ${isNew ? "" : t.status === "done"
        ? `<button class="btn ghost" value="reopen">Reopen</button>`
        : `<button class="btn ghost" value="finish" formnovalidate>Mark done</button>`}
      ${isNew ? "" : `<button class="btn danger" value="delete" formnovalidate>Delete</button>`}
      <button class="btn ghost" value="cancel" formnovalidate>Cancel</button>
    </div>
  </form>`;
  const form = $("form", sheet);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const what = e.submitter?.value;
    if (what === "cancel") return sheet.close();
    const f = new FormData(form);
    const body = {
      title: f.get("title"),
      priority: Number(f.get("priority")),
      durationMin: Number(f.get("durationMin")),
      minChunkMin: Number(f.get("minChunkMin")),
      location: f.get("location"),
      notes: f.get("notes"),
    };
    let ok;
    if (what === "delete") ok = confirm(`Delete "${t.title}"?`) && (await act("DELETE", `/api/tasks/${t.id}`, null, "Deleted"));
    else if (what === "finish") ok = await act("POST", `/api/tasks/${t.id}/done`, null, "Marked done");
    else if (what === "reopen") ok = await act("POST", `/api/tasks/${t.id}/reopen`, null, "Reopened");
    else if (isNew) ok = await act("POST", "/api/tasks", body, "Added and planned");
    else ok = await act("PATCH", `/api/tasks/${t.id}`, body, "Saved");
    if (ok) sheet.close();
  });
  sheet.showModal();
  if (isNew) $("#f-title").focus();
}

// ---- Hours -----------------------------------------------------------------

const cloneHours = () => JSON.parse(JSON.stringify(S.hours));
const hoursDirty = () => hoursDraft && JSON.stringify(hoursDraft) !== JSON.stringify(S.hours);

function rangesHtml(scope, key, list) {
  if (!list.length) return `<p class="muted small" style="margin:.4rem 0 0">Off</p>`;
  return list.map((r, i) => `<div class="range" data-scope="${scope}" data-key="${key}" data-i="${i}">
      <input type="time" data-f="start" value="${esc(r.start)}" aria-label="From">
      <input type="time" data-f="end" value="${esc(r.end)}" aria-label="Until">
      <input type="text" data-f="location" value="${esc(r.location ?? "")}" placeholder="Place, e.g. home (optional)" list="places-h" autocapitalize="none" autocomplete="off" aria-label="Place">
      <button class="x" data-h="remove" aria-label="Remove these hours">×</button>
    </div>`).join("");
}

function hoursView() {
  const h = (hoursDraft ??= cloneHours());
  let html = `<h1>Hours</h1><p class="sub">When tasks may be planned, and where you'll be. A task that needs a place only goes into hours tagged with that place.</p>
    <datalist id="places-h">${places().map((p) => `<option value="${esc(p)}">`).join("")}</datalist>`;
  for (let d = 1; d <= 7; d++) {
    html += `<div class="hday"><header><b>${DAYS[d]}</b><button class="link" data-h="add" data-scope="weekly" data-key="${d}">Add hours</button></header>
      ${rangesHtml("weekly", d, h.weekly[d] ?? [])}</div>`;
  }
  html += `<p><button class="link" data-h="copy">Copy Monday to Tuesday through Friday</button></p>
    <h2>One-off days</h2><p class="muted small">Different hours for a single date. They replace that day's usual hours.</p>`;
  for (const date of Object.keys(h.overrides).sort()) {
    const label = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(date + "T12:00:00Z"));
    html += `<div class="hday"><header><b>${esc(label)}</b><span>
        <button class="link" data-h="add" data-scope="overrides" data-key="${date}">Add hours</button>
        <button class="link" data-h="drop" data-key="${date}" style="margin-left:.75rem">Use usual</button></span></header>
      ${rangesHtml("overrides", date, h.overrides[date])}</div>`;
  }
  html += `<div class="range" style="grid-template-columns:1fr auto"><input type="date" id="o-date" min="${dayKey(S.now)}" aria-label="Date">
    <button class="btn ghost" data-h="override">Change this day</button></div>`;
  if (hoursDirty()) html += `<div class="savebar"><button class="btn" data-h="save">Save hours</button></div>`;
  return html;
}

function hoursClick(el) {
  const h = hoursDraft;
  const what = el.dataset.h;
  const row = el.closest(".range");
  if (what === "add") {
    const list = (h[el.dataset.scope][el.dataset.key] ??= []);
    const last = list[list.length - 1];
    const start = last ? last.end : "09:00";
    const [hh, mm] = start.split(":").map(Number);
    const end = `${String(Math.min(23, hh + 3)).padStart(2, "0")}:${hh + 3 > 23 ? "59" : String(mm).padStart(2, "0")}`;
    list.push({ start, end, location: last?.location ?? null });
  } else if (what === "remove") {
    h[row.dataset.scope][row.dataset.key].splice(Number(row.dataset.i), 1);
  } else if (what === "copy") {
    for (let d = 2; d <= 5; d++) h.weekly[d] = JSON.parse(JSON.stringify(h.weekly[1]));
  } else if (what === "drop") {
    delete h.overrides[el.dataset.key];
  } else if (what === "override") {
    const date = $("#o-date").value;
    if (!date) return toast("Pick a date first.");
    const wd = new Date(date + "T12:00:00Z").getUTCDay() || 7;
    h.overrides[date] ??= JSON.parse(JSON.stringify(h.weekly[wd] ?? []));
  } else if (what === "save") {
    return act("PUT", "/api/hours", h, "Hours saved and plan updated").then((ok) => {
      if (ok) { hoursDraft = null; render(true); }
    });
  }
  render(true);
}

// ---- Settings --------------------------------------------------------------

function settingsView() {
  const g = S.google, s = S.settings;
  let google;
  if (!g.configured) {
    google = `<p>Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to <code>.env</code> and restart. The README walks through creating them.</p>
      <p class="small muted">Redirect address to give Google: <code>${esc(g.redirectUri)}</code></p>`;
  } else if (!g.connected) {
    const home = new URL(g.redirectUri).origin;
    google = `<p>Connect once so blocks show up in your calendar and your events block time.</p>
      <a class="btn" href="/oauth/start" style="display:inline-block;text-decoration:none;text-align:center">Connect Google Calendar</a>
      ${home !== location.origin ? `<p class="hint">Google sends you back to <code>${esc(home)}</code>, so do this step from a browser that can open that address.</p>` : ""}`;
  } else {
    google = `<p>Connected. Blocks go to a calendar named Dayloop; turn it on in Apple Calendar under your Gmail account.</p>
      <span class="label" style="margin-top:.5rem">Events on these calendars block time</span>
      ${g.calendars.length ? g.calendars.map((c) => {
        const on = s.busyCalendars.includes(c.id) || (c.primary && s.busyCalendars.includes("primary"));
        return `<label class="check"><input type="checkbox" name="cal" value="${esc(c.primary ? "primary" : c.id)}" ${on ? "checked" : ""}>${esc(c.name)}</label>`;
      }).join("") : `<p class="muted small">${g.error ? "Couldn't load your calendars." : "No calendars found."}</p>`}
      <p style="margin-top:.75rem"><button class="btn danger" data-s="disconnect" type="button">Disconnect</button></p>`;
  }
  const alerts = [[null, "No alert"], [0, "When it starts"], [5, "5 minutes before"], [10, "10 minutes before"], [15, "15 minutes before"]];
  return `<h1>Settings</h1><p class="sub">Last planned ${S.plan.at ? esc(when(S.plan.at)) : "never"}.</p>
    <form id="settings">
    <h2>Google Calendar</h2><div class="card">${g.error ? `<p class="notice">${esc(g.error)}</p>` : ""}${google}</div>
    <h2>Planning</h2><div class="card">
      <label for="s-grace">Count a block as missed after</label>
      <div class="unit"><input id="s-grace" name="graceMin" type="number" inputmode="numeric" min="0" max="720" value="${s.graceMin}"><span>min</span></div>
      <p class="hint">Time you get after a block ends to mark it done. After that it goes back in the queue and is planned again.</p>
      <div class="row">
        <div><label for="s-buf">Gap between blocks</label><div class="unit"><input id="s-buf" name="bufferMin" type="number" inputmode="numeric" min="0" max="120" step="5" value="${s.bufferMin}"><span>min</span></div></div>
        <div><label for="s-days">Plan ahead</label><div class="unit"><input id="s-days" name="horizonDays" type="number" inputmode="numeric" min="1" max="60" value="${s.horizonDays}"><span>days</span></div></div>
      </div>
      <label for="s-alert">Phone alert for each block</label>
      <select id="s-alert" name="reminderMin">${alerts.map(([v, l]) => `<option value="${v ?? ""}" ${s.reminderMin === v ? "selected" : ""}>${l}</option>`).join("")}</select>
      <label for="s-zone">Time zone</label>
      <input id="s-zone" name="zone" type="text" value="${esc(s.zone)}" autocapitalize="none" autocomplete="off">
    </div>
    <button class="btn wide">Save settings</button>
    </form>
    <p style="margin-top:.75rem"><button class="btn ghost wide" data-s="replan" type="button">Replan now</button></p>
    <h2>Backups</h2><div class="card">
      <p>${S.backup.last ? `Last backup ${esc(when(S.backup.last.at))}.` : "No backup yet."} A full copy of your data is saved every 24 hours, and the newest ${S.backup.keep} are kept.</p>
      <p class="small muted">Saved on the server in ${S.backup.dir === "/backups" ? "the <code>backups</code> folder next to <code>docker-compose.yml</code>" : `<code>${esc(S.backup.dir)}</code>`}. Each copy includes your Google sign-in, so keep them private.</p>
      <button class="btn ghost" data-s="backup" type="button">Back up now</button>
    </div>`;
}

function saveSettings(form) {
  const f = new FormData(form);
  const body = {
    graceMin: Number(f.get("graceMin")),
    bufferMin: Number(f.get("bufferMin")),
    horizonDays: Number(f.get("horizonDays")),
    reminderMin: f.get("reminderMin") === "" ? null : Number(f.get("reminderMin")),
    zone: String(f.get("zone")).trim(),
  };
  if (S.google.connected && S.google.calendars.length) body.busyCalendars = f.getAll("cal");
  act("PUT", "/api/settings", body, "Settings saved and plan updated");
}

// ---- Drawing and events ----------------------------------------------------

function render(force = false) {
  if (!S) return;
  const t = tab();
  if (!force) {
    // Don't yank the screen out from under someone who is typing.
    if (sheet.open) return;
    if (t === "hours" && hoursDirty()) return;
    const a = document.activeElement;
    if (a && view.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
  }
  if (t !== "hours" && !hoursDirty()) hoursDraft = null;
  const keep = document.activeElement?.closest?.(".range");
  const focus = keep && { scope: keep.dataset.scope, key: keep.dataset.key, i: keep.dataset.i, f: document.activeElement.dataset.f };
  view.innerHTML = { plan: planView, tasks: tasksView, hours: hoursView, settings: settingsView }[t]?.() ?? planView();
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.tab === t) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  $("#add").hidden = t === "hours" || t === "settings";
  if (focus?.f) $(`.range[data-scope="${focus.scope}"][data-key="${focus.key}"][data-i="${focus.i}"] [data-f="${focus.f}"]`)?.focus();
}

view.addEventListener("click", (e) => {
  const el = e.target.closest("[data-do],[data-edit],[data-h],[data-s],.block .body[role=button]");
  if (!el) return;
  if (el.dataset.do) {
    const block = el.closest(".block");
    const id = block.dataset.block;
    if (el.dataset.do === "edit") return taskSheet(S.tasks.find((t) => t.id === Number(block.dataset.task)));
    el.disabled = true;
    openBlock = null;
    return act("POST", `/api/blocks/${id}/${el.dataset.do}`, null, el.dataset.do === "done" ? "Done" : "Moved to a later slot");
  }
  if (el.dataset.edit) return taskSheet(S.tasks.find((t) => t.id === Number(el.dataset.edit)));
  if (el.dataset.h) return hoursClick(el);
  if (el.dataset.s === "replan") return act("POST", "/api/replan", null, "Plan updated");
  if (el.dataset.s === "disconnect") return confirm("Disconnect Google Calendar? Events already on the calendar stay there.") && act("POST", "/api/google/disconnect", null, "Disconnected");
  if (el.dataset.s === "backup") return act("POST", "/api/backup", null, "Backed up");
  const id = Number(el.closest(".block").dataset.block);
  openBlock = openBlock === id ? null : id;
  render(true);
});
view.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches(".block .body[role=button]")) {
    e.preventDefault();
    e.target.click();
  }
});
view.addEventListener("change", (e) => {
  const row = e.target.closest(".range[data-scope]");
  if (!row || !hoursDraft) return;
  const r = hoursDraft[row.dataset.scope][row.dataset.key][Number(row.dataset.i)];
  r[e.target.dataset.f] = e.target.dataset.f === "location" ? e.target.value.trim().toLowerCase() || null : e.target.value;
  render(true);
});
view.addEventListener("submit", (e) => {
  if (e.target.id !== "settings") return;
  e.preventDefault();
  saveSettings(e.target);
});
$("#add").addEventListener("click", () => taskSheet(null));
sheet.addEventListener("click", (e) => e.target === sheet && sheet.close());
addEventListener("hashchange", () => render(true));
document.addEventListener("visibilitychange", () => !document.hidden && refresh());
setInterval(refresh, 60_000);
refresh();
