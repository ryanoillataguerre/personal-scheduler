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

/** Wording for a task's deadline, and whether it needs attention. */
function dueInfo(t) {
  if (!t.dueDate) return null;
  const today = dayKey(S.now);
  const date = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(t.dueDate + "T12:00:00Z"));
  const open = t.status === "open";
  if (open && t.dueDate < today) return { text: `Overdue, was due ${date}`, warn: true };
  const label = t.dueDate === today ? "Due today" : t.dueDate === dayKey(S.now + 86400000) ? "Due tomorrow" : `Due ${date}`;
  if (open && S.plan.late.includes(t.id)) return { text: `${label}, won't be finished in time`, warn: true };
  if (open && S.plan.urgent.includes(t.id)) return { text: `${label}, moved to the front`, warn: false };
  return { text: label, warn: false };
}
const taskById = () => Object.fromEntries(S.tasks.map((t) => [t.id, t]));
/** Names given to blocks of hours on the Hours tab. */
const blockNames = () =>
  [...new Set([
    ...Object.values(S.hours.weekly).flat().map((r) => r.name),
    ...Object.values(S.hours.overrides).flat().map((r) => r.name),
  ].filter(Boolean))].sort();
const blocksText = (list) => (list.length ? `in ${list.join(" or ")}` : "");

/** Checkboxes for the named blocks a task or habit may go in. */
function blockPicker(selected) {
  // Keep names the item already has, even if no hours carry them any more.
  const names = [...new Set([...blockNames(), ...selected])].sort();
  if (!names.length) {
    return `<span class="label">When it can be done</span>
      <p class="hint" style="margin:0">Any time in your hours. To limit it, name some blocks on the Hours tab (focus, home, review) and pick them here.</p>`;
  }
  return `<span class="label" id="l-blocks">When it can be done</span>
    <div class="chips" role="group" aria-labelledby="l-blocks">
      ${names.map((n) => `<label class="chip"><input type="checkbox" name="blocks" value="${esc(n)}" ${selected.includes(n) ? "checked" : ""}><span>${esc(n)}</span></label>`).join("")}
    </div>
    <p class="hint">Pick the blocks of hours it may go in. With none picked it can go anywhere in your hours, except blocks set to take only work that picks them.</p>`;
}

// ---- Tags ------------------------------------------------------------------

let tagFilter = null; // show only work with this tag on the Tasks and Habits tabs

const cleanTag = (raw) => String(raw).replace(/,/g, " ").replace(/^#+/, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 30).trim();
/** Every tag in use, on one-off tasks and on habits. */
const allTags = () =>
  [...new Set([...S.tasks.filter((t) => !t.habitId).flatMap((t) => t.tags), ...S.habits.flatMap((h) => h.tags)])].sort();
const tagPills = (tags) =>
  tags.length ? `<span class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</span>` : "";
const tagChip = (name, on) =>
  `<label class="chip"><input type="checkbox" name="tags" value="${esc(name)}" ${on ? "checked" : ""}><span>${esc(name)}</span></label>`;

/** The filter in effect for a list: the chosen tag, if anything in the list still has it. */
const activeTag = (items) => (tagFilter && items.some((i) => i.tags.includes(tagFilter)) ? tagFilter : null);

/** A row of buttons to narrow a list to one tag. Nothing is drawn until a tag exists. */
function tagFilterBar(items) {
  const tags = [...new Set(items.flatMap((i) => i.tags))].sort();
  if (!tags.length) return "";
  const on = activeTag(items);
  const chip = (value, label) =>
    `<button class="fchip" type="button" data-tag="${esc(value)}" aria-pressed="${(on ?? "") === value}">${esc(label)}</button>`;
  return `<div class="filter" role="group" aria-label="Show only one tag">${chip("", "All")}${tags.map((t) => chip(t, t)).join("")}</div>`;
}

/** Tag editing inside a sheet: tick existing tags, or type a new one. */
function tagPicker(selected) {
  const names = [...new Set([...allTags(), ...selected])].sort();
  return `<span class="label" id="l-tags">Tags</span>
    <div class="chips" id="tag-chips" role="group" aria-labelledby="l-tags">${names.map((n) => tagChip(n, selected.includes(n))).join("")}</div>
    <div class="tagadd">
      <input type="text" id="tag-new" placeholder="New tag" maxlength="30" autocapitalize="none" autocomplete="off" enterkeyhint="done" aria-label="New tag">
      <button class="btn ghost" type="button" id="tag-add">Add tag</button>
    </div>
    <p class="hint">Tags group related work so you can filter by them. They don't change how anything is planned.</p>`;
}

/** Make the "New tag" field work. Returns a function that takes in whatever is still typed there. */
function wireTags(form) {
  const input = $("#tag-new", form);
  const chips = $("#tag-chips", form);
  const add = () => {
    for (const name of input.value.split(",").map(cleanTag).filter(Boolean)) {
      const existing = [...chips.querySelectorAll("input")].find((i) => i.value === name);
      if (existing) existing.checked = true;
      else chips.insertAdjacentHTML("beforeend", tagChip(name, true));
    }
    input.value = "";
  };
  $("#tag-add", form).addEventListener("click", add);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== ",") return;
    e.preventDefault(); // Enter here adds the tag; it must not save the whole sheet
    add();
  });
  return add;
}

// ---- Plan ------------------------------------------------------------------

function notices() {
  const out = [];
  const tasks = taskById();
  if (S.google.error) out.push(`Google Calendar: ${esc(S.google.error)}`);
  else if (!S.google.connected) out.push(`Not connected to Google Calendar, so blocks only show here. <a href="#settings">Connect it in Settings.</a>`);
  // Habits that don't fit report it on their own tab, not here.
  const un = S.plan.unscheduled.filter((u) => tasks[u.taskId] && !tasks[u.taskId].habitId);
  if (un.length) {
    const names = un.map((u) => `${esc(tasks[u.taskId].title)} (${dur(u.minutes)})`).join(", ");
    out.push(`No room in the next ${S.settings.horizonDays} days for: ${names}. Add hours, allow it in more blocks, or shorten its smallest piece.`);
  }
  const late = S.plan.late.map((id) => tasks[id]).filter((t) => t && t.status === "open");
  if (late.length) {
    out.push(`Won't be finished by the deadline: ${late.map((t) => `${esc(t.title)} (${esc(dueInfo(t).text.split(",")[0].toLowerCase())})`).join(", ")}. It's planned first; free up hours or move the deadline.`);
  }
  return out.map((n) => `<p class="notice">${n}</p>`).join("");
}

function blockHtml(b, t) {
  const live = b.status === "planned" && b.start <= S.now && S.now < b.end;
  const ask = b.status === "planned" && b.end <= S.now;
  const open = live || ask || openBlock === b.id;
  const mins = (b.end - b.start) / 60000;
  const state = b.status === "done" ? "done" : live ? "now" : ask ? "ask" : "";
  const meta = dur(mins);
  const due = b.status === "planned" ? dueInfo(t) : null;
  let actions = "";
  if (b.status === "planned" && open) {
    actions = live
      ? `<button class="btn" data-do="done">Done</button><button class="btn ghost" data-do="skip">Not now</button>`
      : ask
        ? `<button class="btn" data-do="done">I did it</button><button class="btn ghost" data-do="skip">Didn't do it</button>`
        : `<button class="btn" data-do="done">Done already</button><button class="btn ghost" data-do="edit">${t.habitId ? "Edit habit" : "Edit task"}</button>`;
    actions = `<div class="actions">${actions}</div>`;
  }
  const lead = ask ? "Did you do this? " : live ? "Now, " : "";
  return `<div class="block p${t.priority} ${state}" data-block="${b.id}" data-task="${t.id}" style="--h:${Math.min(9, Math.max(3.5, mins / 20))}rem">
    <div class="time"><b>${time(b.start)}</b><span>${time(b.end)}</span></div>
    <div class="body" ${b.status === "planned" && !live && !ask ? 'role="button" tabindex="0"' : ""}>
      <div class="title">${esc(t.title)}</div>
      <div class="meta">${lead}${esc(meta)}</div>
      ${tagPills(t.tags)}
      ${due ? `<div class="meta ${due.warn ? "warn" : ""}">${esc(due.text)}</div>` : ""}${actions}
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
        ? "Your tasks don't fit anywhere yet. Check your hours and which blocks each task is allowed in."
        : "Nothing to plan yet. Add a task with the + button, or a habit on the Habits tab."
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
  const mine = S.tasks.filter((t) => !t.habitId);
  const tag = activeTag(mine);
  const shown = tag ? mine.filter((t) => t.tags.includes(tag)) : mine;
  const open = shown.filter((t) => t.status === "open");
  const finished = shown.filter((t) => t.status === "done").sort((a, b) => b.completedAt - a.completedAt);
  const next = {};
  for (const b of S.blocks) if (b.status === "planned" && !(b.taskId in next)) next[b.taskId] = b.start;
  const total = open.reduce((s, t) => s + Math.max(0, t.durationMin - t.doneMin), 0);
  const tagged = tag ? ` tagged ${esc(tag)}` : "";
  let html = `<h1>Tasks</h1><p class="sub">${open.length ? `${open.length} open${tagged}, ${dur(total)} left to do.` : `Nothing open${tagged}.`}</p>${tagFilterBar(mine)}`;
  for (const t of open) {
    const missed = t.missedCount ? `, missed ${t.missedCount === 1 ? "once" : t.missedCount + " times"}` : "";
    const meta = [`${dur(t.durationMin - t.doneMin)} left`, blocksText(t.blocks)].filter(Boolean).join(", ") + missed;
    html += `<button class="task p${t.priority}" data-edit="${t.id}">
      <span class="pri" aria-label="Priority ${t.priority}, ${PRIORITY[t.priority]}">${t.priority}</span>
      <span><span class="title">${esc(t.title)}</span>
        <span class="meta">${esc(meta)}</span>
        ${dueInfo(t) ? `<span class="meta ${dueInfo(t).warn ? "warn" : ""}">${esc(dueInfo(t).text)}</span>` : ""}
        <span class="meta">${next[t.id] ? "Next: " + esc(when(next[t.id])) : "No room in your hours yet"}</span>
        ${tagPills(t.tags)}
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
  t = t || { title: "", priority: 2, durationMin: 60, minChunkMin: 30, blocks: [], tags: tagFilter ? [tagFilter] : [], notes: "", dueDate: null };
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
    <label for="f-due">Deadline</label>
    <input id="f-due" name="dueDate" type="date" value="${esc(t.dueDate ?? "")}">
    <p class="hint">Optional. Done by the end of this day. If it's running out of time, it's planned ahead of everything else, whatever its priority.</p>
    ${blockPicker(t.blocks ?? [])}
    ${tagPicker(t.tags ?? [])}
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
  const takeTypedTag = wireTags(form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const what = e.submitter?.value;
    if (what === "cancel") return sheet.close();
    takeTypedTag();
    const f = new FormData(form);
    const body = {
      title: f.get("title"),
      priority: Number(f.get("priority")),
      durationMin: Number(f.get("durationMin")),
      minChunkMin: Number(f.get("minChunkMin")),
      blocks: f.getAll("blocks"),
      tags: f.getAll("tags"),
      notes: f.get("notes"),
      dueDate: f.get("dueDate") || null,
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

// ---- Habits ----------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const DAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function daysText(days) {
  const key = days.join("");
  if (key === "12345") return "weekdays";
  if (key === "67") return "weekends";
  return days.map((d) => DAY_SHORT[d]).join(", ");
}
/** "17:15" as the reader's clock would show it. */
const clockText = (hhmm) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(`2000-01-01T${hhmm}:00Z`));

function habitRepeats(h) {
  const on = h.days.length ? daysText(h.days) : "";
  const between = h.timeFrom ? `, between ${clockText(h.timeFrom)} and ${clockText(h.timeTo)}` : "";
  if (h.kind === "daily") return `${on ? `Every ${on.startsWith("week") ? on.slice(0, -1) : on}` : "Every day"}, ${dur(h.sessionMin)}${between}`;
  const onDays = on ? `, on ${on}` : "";
  if (h.kind === "days") return `${plural(h.daysPerWeek, "day")} a week, ${dur(h.sessionMin)} each${onDays}${between}`;
  return `${dur(h.weeklyMin)} a week${h.maxPerDayMin ? `, up to ${dur(h.maxPerDayMin)} a day` : ""}${onDays}${between}`;
}

function habitStatus(h) {
  const p = h.progress;
  if (!h.active) return ["Paused", ""];
  const span = h.kind === "daily" ? "today" : "this week";
  let week;
  if (!p.weekTargetMin) week = "Starts next week";
  else if (h.kind === "hours") week = `This week: ${dur(p.weekDoneMin)} of ${dur(p.weekTargetMin)}`;
  else week = `This week: ${Math.floor(p.weekDoneMin / h.sessionMin)} of ${plural(Math.round(p.weekTargetMin / h.sessionMin), "day")}`;
  let next;
  if (p.noRoomMin > 0) next = h.kind === "hours" ? `No room for ${dur(p.noRoomMin)} of it ${span}` : `No room left ${span}`;
  else if (p.current === "done") next = `Done for ${span}`;
  else if (p.nextStart) next = `Next: ${when(p.nextStart)}`;
  else next = "Nothing planned";
  if (p.current === "done" && p.nextStart) next += `, next ${when(p.nextStart)}`;
  return [week, next];
}

function habitsView() {
  let html = `<h1>Habits</h1><p class="sub">Work that repeats. It's planned into your hours like a task, and what isn't done by the end of its day or week lapses instead of piling up.</p>`;
  if (!S.habits.length) {
    return html + `<div class="empty"><p>No habits yet. Add one with the + button: something for every day, for a few days a week, or for a number of hours a week.</p></div>`;
  }
  const tag = activeTag(S.habits);
  html += tagFilterBar(S.habits);
  for (const h of tag ? S.habits.filter((x) => x.tags.includes(tag)) : S.habits) {
    const [week, next] = habitStatus(h);
    const pct = h.progress.weekTargetMin ? Math.min(100, (h.progress.weekDoneMin / h.progress.weekTargetMin) * 100) : 0;
    html += `<button class="task p${h.priority} ${h.active ? "" : "paused"}" data-habit="${h.id}">
      <span class="pri" aria-label="Priority ${h.priority}, ${PRIORITY[h.priority]}">${h.priority}</span>
      <span><span class="title">${esc(h.title)}</span>
        <span class="meta">${esc([habitRepeats(h), blocksText(h.blocks)].filter(Boolean).join(", "))}</span>
        <span class="meta">${esc(week)}</span>
        ${next ? `<span class="meta">${esc(next)}</span>` : ""}
        ${tagPills(h.tags)}
        ${h.active && pct ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ""}</span>
    </button>`;
  }
  return html;
}

function habitSheet(h) {
  const isNew = !h;
  h = h || { title: "", kind: "daily", priority: 2, sessionMin: 30, daysPerWeek: 3, weeklyMin: 300, minChunkMin: 30, maxPerDayMin: null, blocks: [], tags: tagFilter ? [tagFilter] : [], days: [], timeFrom: null, timeTo: null, active: true };
  const kinds = [["daily", "Every day"], ["days", "Days a week"], ["hours", "Hours a week"]];
  sheet.innerHTML = `<form method="dialog">
    <h2>${isNew ? "New habit" : "Edit habit"}</h2>
    <label for="h-title">What you want to keep doing</label>
    <input id="h-title" name="title" type="text" value="${esc(h.title)}" maxlength="200" required autocomplete="off">
    <span class="label" id="l-kind">Repeats</span>
    ${isNew
      ? `<div class="picks three" role="radiogroup" aria-labelledby="l-kind">${kinds.map(([k, l]) => `<label class="pick k"><input type="radio" name="kind" value="${k}" ${h.kind === k ? "checked" : ""}><span>${l}</span></label>`).join("")}</div>`
      : `<p class="hint" style="margin:0">${kinds.find(([k]) => k === h.kind)[1]}. To change this, delete the habit and add a new one.</p><input type="hidden" name="kind" value="${h.kind}">`}
    <div class="row" data-for="daily days">
      <div data-for="days"><label for="h-days">Days a week</label>
        <input id="h-days" name="daysPerWeek" type="number" inputmode="numeric" min="1" max="7" value="${h.daysPerWeek}"></div>
      <div><label for="h-session">Time each day</label>
        <div class="unit"><input id="h-session" name="sessionMin" type="number" inputmode="numeric" min="5" max="720" step="5" value="${h.sessionMin}"><span>min</span></div></div>
    </div>
    <div data-for="hours">
      <label for="h-weekly">Hours a week</label>
      <div class="unit"><input id="h-weekly" name="weeklyHours" type="number" inputmode="decimal" min="0.25" max="100" step="0.25" value="${h.weeklyMin / 60}"><span>h</span></div>
      <div class="row">
        <div><label for="h-chunk">Smallest piece</label>
          <div class="unit"><input id="h-chunk" name="minChunkMin" type="number" inputmode="numeric" min="5" max="720" step="5" value="${h.minChunkMin}"><span>min</span></div></div>
        <div><label for="h-max">Most in one day</label>
          <div class="unit"><input id="h-max" name="maxPerDayMin" type="number" inputmode="numeric" min="5" max="1440" step="5" value="${h.maxPerDayMin ?? ""}" placeholder="No limit"><span>min</span></div></div>
      </div>
    </div>
    <p class="hint" data-for="daily">Planned once a day. If the day ends without it, that day is skipped; it doesn't carry over.</p>
    <p class="hint" data-for="days">One sitting a day, on that many different days between Monday and Sunday. A missed sitting moves to a later day that week.</p>
    <p class="hint" data-for="hours">Spread across Monday to Sunday in pieces no shorter than the smallest piece. Without a daily limit it's planned as early in the week as it fits.</p>
    <span class="label" id="l-hpri">Priority</span>
    <div class="picks" role="radiogroup" aria-labelledby="l-hpri">
      ${[1, 2, 3, 4].map((p) => `<label class="pick p${p}"><input type="radio" name="priority" value="${p}" ${h.priority === p ? "checked" : ""}><span><b>${p}</b>${PRIORITY[p]}</span></label>`).join("")}
    </div>
    <span class="label" id="l-days">Only on these days</span>
    <div class="chips" role="group" aria-labelledby="l-days">
      ${[1, 2, 3, 4, 5, 6, 7].map((d) => `<label class="chip"><input type="checkbox" name="days" value="${d}" ${h.days.includes(d) ? "checked" : ""}><span>${DAY_SHORT[d]}</span></label>`).join("")}
    </div>
    <p class="hint">Leave all off for any day.</p>
    <div class="row">
      <div><label for="h-from">Only between</label><input id="h-from" name="timeFrom" type="time" value="${esc(h.timeFrom ?? "")}"></div>
      <div><label for="h-to">and</label><input id="h-to" name="timeTo" type="time" value="${esc(h.timeTo ?? "")}"></div>
    </div>
    <p class="hint">Optional. With both times set, it's planned inside that window on its days, even outside your hours, and block names don't apply to it.</p>
    <div id="h-blocks">${blockPicker(h.blocks ?? [])}</div>
    ${tagPicker(h.tags ?? [])}
    <div class="foot">
      <button class="btn" value="save">${isNew ? "Add habit" : "Save changes"}</button>
      ${isNew ? "" : `<button class="btn ghost" value="${h.active ? "pause" : "resume"}" formnovalidate>${h.active ? "Pause" : "Resume"}</button>
      <button class="btn danger" value="delete" formnovalidate>Delete</button>`}
      <button class="btn ghost" value="cancel" formnovalidate>Cancel</button>
    </div>
  </form>`;
  const form = $("form", sheet);
  const showKind = () => {
    const kind = new FormData(form).get("kind");
    for (const el of form.querySelectorAll("[data-for]")) el.hidden = !el.dataset.for.split(" ").includes(kind);
    // A set time replaces named blocks, so the block picker steps aside.
    $("#h-blocks", form).hidden = Boolean($("#h-from", form).value && $("#h-to", form).value);
  };
  form.addEventListener("change", showKind);
  showKind();
  const takeTypedTag = wireTags(form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const what = e.submitter?.value;
    if (what === "cancel") return sheet.close();
    takeTypedTag();
    const f = new FormData(form);
    const max = String(f.get("maxPerDayMin") ?? "").trim();
    const body = {
      title: f.get("title"),
      kind: f.get("kind"),
      priority: Number(f.get("priority")),
      sessionMin: Number(f.get("sessionMin")),
      daysPerWeek: Number(f.get("daysPerWeek")),
      weeklyMin: Math.round((Number(f.get("weeklyHours")) * 60) / 5) * 5,
      minChunkMin: Number(f.get("minChunkMin")),
      maxPerDayMin: max === "" ? null : Number(max),
      blocks: f.getAll("blocks"),
      tags: f.getAll("tags"),
      days: f.getAll("days").map(Number),
      timeFrom: f.get("timeFrom") || null,
      timeTo: f.get("timeTo") || null,
    };
    let ok;
    if (what === "delete") ok = confirm(`Delete "${h.title}"? Its planned blocks are removed; finished ones stay.`) && (await act("DELETE", `/api/habits/${h.id}`, null, "Deleted"));
    else if (what === "pause") ok = await act("POST", `/api/habits/${h.id}/pause`, null, "Paused");
    else if (what === "resume") ok = await act("POST", `/api/habits/${h.id}/resume`, null, "Resumed and planned");
    else if (isNew) ok = await act("POST", "/api/habits", body, "Added and planned");
    else ok = await act("PATCH", `/api/habits/${h.id}`, body, "Saved");
    if (ok) sheet.close();
  });
  sheet.showModal();
  if (isNew) $("#h-title").focus();
}

// ---- Hours -----------------------------------------------------------------

const cloneHours = () => JSON.parse(JSON.stringify(S.hours));
const hoursDirty = () => hoursDraft && JSON.stringify(hoursDraft) !== JSON.stringify(S.hours);

function rangesHtml(scope, key, list) {
  if (!list.length) return `<p class="muted small" style="margin:.4rem 0 0">Off</p>`;
  return list.map((r, i) => `<div class="range" data-scope="${scope}" data-key="${key}" data-i="${i}">
      <input type="time" data-f="start" value="${esc(r.start)}" aria-label="From">
      <input type="time" data-f="end" value="${esc(r.end)}" aria-label="Until">
      <input type="text" data-f="name" value="${esc(r.name ?? "")}" placeholder="Name, e.g. focus (optional)" list="names-h" autocapitalize="none" autocomplete="off" aria-label="Block name">
      <button class="x" data-h="remove" aria-label="Remove these hours">×</button>
      ${r.name ? `<label class="check strict"><input type="checkbox" data-f="strict" ${r.strict ? "checked" : ""}>Only for work that picks ${esc(r.name)}</label>` : ""}
    </div>`).join("");
}

/**
 * Read-only picture of this week's hours: one column per day, blocks placed
 * by time of day. Drawn from the draft, so edits below show up at once.
 */
function weekChart(h) {
  const mins = (t) => (/^\d\d:\d\d$/.test(t ?? "") ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : NaN);
  // Work in UTC-noon dates so stepping through the week is safe across clock changes.
  const todayKey = dayKey(S.now);
  const today = new Date(todayKey + "T12:00:00Z");
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * 86400000);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getTime() + i * 86400000);
    const date = d.toISOString().slice(0, 10);
    const oneOff = date in h.overrides;
    const ranges = ((oneOff ? h.overrides[date] : h.weekly[i + 1]) ?? [])
      .map((r) => ({ ...r, a: mins(r.start), b: mins(r.end) }))
      .filter((r) => r.b > r.a);
    days.push({ date, oneOff, ranges, dom: d.getUTCDate(), letter: DAYS[i + 1].slice(0, 3), today: date === todayKey });
  }
  const all = days.flatMap((d) => d.ranges);
  if (!all.length) {
    return `<figure class="week"><p class="muted small" style="margin:0">No hours this week yet. Add some below and they'll be drawn here.</p></figure>`;
  }

  // Fit the time axis to the hours in use, on whole hours.
  let lo = Math.floor(Math.min(...all.map((r) => r.a)) / 60);
  let hi = Math.ceil(Math.max(...all.map((r) => r.b)) / 60);
  while (hi - lo < 6) hi < 24 ? hi++ : lo--;
  const perHour = Math.max(20, Math.min(36, Math.round(300 / (hi - lo))));
  const y = (m) => ((m - lo * 60) / 60) * perHour;
  const height = (hi - lo) * perHour;

  const names = [...new Set(all.map((r) => r.name).filter(Boolean))].sort();
  const color = (name) => (name ? `c${names.indexOf(name) % 6}` : "plain");
  const total = (list) => list.reduce((sum, r) => sum + (r.b - r.a), 0);
  const hourLabel = (hr) => new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2000, 0, 1, hr % 24)));
  const step = perHour >= 26 ? 1 : 2;

  let lines = "";
  for (let hr = lo; hr <= hi; hr++) {
    lines += `<i class="line ${(hr - lo) % step ? "minor" : ""}" style="top:${(hr - lo) * perHour}px">${(hr - lo) % step ? "" : `<span>${hourLabel(hr)}</span>`}</i>`;
  }

  const nowParts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone() }).format(S.now);
  const nowMin = mins(nowParts);
  const cols = days.map((d) => {
    const blocks = d.ranges.map((r) => {
      const hgt = Math.max(6, y(r.b) - y(r.a) - 2);
      return `<div class="blk ${color(r.name)} ${r.strict ? "strict" : ""}" style="top:${y(r.a) + 1}px;height:${hgt}px">${hgt >= 30 && r.name ? `<span>${esc(r.name)}</span>` : ""}</div>`;
    }).join("");
    const now = d.today && nowMin >= lo * 60 && nowMin <= hi * 60 ? `<i class="now" style="top:${y(nowMin)}px"></i>` : "";
    return `<div class="col ${d.today ? "today" : ""}">${blocks}${now}</div>`;
  }).join("");

  const head = days.map((d) => `<div class="${d.today ? "today" : ""}">${d.letter}<b>${d.dom}</b>${d.oneOff ? `<i class="dot" title="One-off day"></i>` : ""}</div>`).join("");

  const legend = [...names, null]
    .map((name) => {
      const list = all.filter((r) => (r.name ?? null) === name);
      if (!list.length) return "";
      const strict = list.some((r) => r.strict);
      return `<li><i class="sw ${color(name)} ${strict ? "strict" : ""}"></i>${esc(name ?? "unnamed")} <span>${dur(total(list))}${strict ? ", reserved" : ""}</span></li>`;
    }).join("");

  const summary = `This week's hours: ${dur(total(all))} in total. ` +
    days.filter((d) => d.ranges.length).map((d) => `${d.letter} ${d.ranges.map((r) => `${r.start} to ${r.end}${r.name ? ` ${r.name}` : ""}`).join(", ")}`).join("; ");

  return `<figure class="week" role="img" aria-label="${esc(summary)}">
    <header><b>This week</b><span>${dur(total(all))}</span></header>
    <div class="week-grid week-head"><div></div>${head}</div>
    <div class="week-grid week-body" style="height:${height}px"><div class="axis">${lines}</div>${cols}</div>
    <ul class="week-legend">${legend}${days.some((d) => d.oneOff) ? `<li><i class="dot"></i>one-off day</li>` : ""}</ul>
  </figure>`;
}

function hoursView() {
  const h = (hoursDraft ??= cloneHours());
  let html = `<h1>Hours</h1><p class="sub">When work may be planned. Give a block of hours a name, like focus, home or review, and each task or habit can then be limited to the blocks you pick for it. A named block can also be kept only for the work that picks it.</p>
    <datalist id="names-h">${blockNames().map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
    ${weekChart(h)}`;
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
    list.push({ start, end, name: null, strict: false });
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
      <label for="s-cushion">Finish deadline work early by</label>
      <div class="unit"><input id="s-cushion" name="deadlineCushionHours" type="number" inputmode="numeric" min="0" max="336" value="${s.deadlineCushionHours}"><span>h</span></div>
      <p class="hint">A task with a deadline is planned to finish this long before it's due. When that's at risk, it moves ahead of everything else. Set 0 to cut it as close as the deadline itself.</p>
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
    deadlineCushionHours: Number(f.get("deadlineCushionHours")),
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
  view.innerHTML = { plan: planView, tasks: tasksView, habits: habitsView, hours: hoursView, settings: settingsView }[t]?.() ?? planView();
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.tab === t) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  $("#add").hidden = t === "hours" || t === "settings";
  if (focus?.f) $(`.range[data-scope="${focus.scope}"][data-key="${focus.key}"][data-i="${focus.i}"] [data-f="${focus.f}"]`)?.focus();
}

view.addEventListener("click", (e) => {
  const el = e.target.closest("[data-do],[data-edit],[data-habit],[data-h],[data-s],[data-tag],.block .body[role=button]");
  if (!el) return;
  if (el.dataset.tag !== undefined) {
    tagFilter = el.dataset.tag || null;
    return render(true);
  }
  if (el.dataset.do) {
    const block = el.closest(".block");
    const id = block.dataset.block;
    if (el.dataset.do === "edit") {
      const task = S.tasks.find((t) => t.id === Number(block.dataset.task));
      const habit = task.habitId && S.habits.find((h) => h.id === task.habitId);
      return habit ? habitSheet(habit) : taskSheet(task);
    }
    el.disabled = true;
    openBlock = null;
    return act("POST", `/api/blocks/${id}/${el.dataset.do}`, null, el.dataset.do === "done" ? "Done" : "Moved to a later slot");
  }
  if (el.dataset.edit) return taskSheet(S.tasks.find((t) => t.id === Number(el.dataset.edit)));
  if (el.dataset.habit) return habitSheet(S.habits.find((h) => h.id === Number(el.dataset.habit)));
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
  const field = e.target.dataset.f;
  if (field === "strict") r.strict = e.target.checked;
  else if (field === "name") {
    r.name = e.target.value.replace(/,/g, " ").trim().toLowerCase() || null;
    if (!r.name) r.strict = false; // a block with no name can't be picked, so it can't be reserved
  } else r[field] = e.target.value;
  render(true);
});
view.addEventListener("submit", (e) => {
  if (e.target.id !== "settings") return;
  e.preventDefault();
  saveSettings(e.target);
});
$("#add").addEventListener("click", () => (tab() === "habits" ? habitSheet(null) : taskSheet(null)));
sheet.addEventListener("click", (e) => e.target === sheet && sheet.close());
addEventListener("hashchange", () => render(true));
document.addEventListener("visibilitychange", () => !document.hidden && refresh());
setInterval(refresh, 60_000);
refresh();
