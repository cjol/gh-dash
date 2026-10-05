// Team activity dashboard: a small hash-routed page over the mirror's JSON API.

const $view = document.getElementById("view");
const $tip = document.getElementById("tooltip");
const DAY = 86_400_000;
let cfg;

// ---------- helpers ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtInt = (n) => (n == null ? "–" : Number(n).toLocaleString("en-GB"));

async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function ago(iso) {
  if (!iso) return "never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 0) return `in ${dur(-s)}`;
  if (s < 45) return "just now";
  return `${dur(s)} ago`;
}
function dur(s) {
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 129600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}
function days(d) {
  if (d == null) return "–";
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} h`;
  if (d < 60) return `${Math.round(d)} d`;
  if (d < 730) return `${(d / 30.44).toFixed(1)} mo`;
  return `${(d / 365.25).toFixed(1)} y`;
}
function fmtDay(date, opts = { weekday: "short", day: "numeric", month: "short" }) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: cfg.timezone });
}
function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: cfg.timezone }) : "–";
}
function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const isWeekend = (date) => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
const shortRepo = (r) => r.split("/")[1];
const coverageNote = (from) => (from ? `Mirror history starts ${fmtDateTime(from)}; nothing before that is counted.` : "");

function parseHash() {
  const [route, query] = location.hash.slice(1).split("?");
  return { route: route || "activity", params: Object.fromEntries(new URLSearchParams(query || "")) };
}
function setHash(route, params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== null)).toString();
  const next = `#${route}${q ? `?${q}` : ""}`;
  if (location.hash !== next) location.hash = next;
  else render();
}

// tooltip: rows = [[label, value], ...]
function showTip(evt, title, rows = [], foot = "") {
  $tip.innerHTML = `<div class="t">${title}</div>${rows.map(([l, v]) => `<div class="r"><span>${esc(l)}</span><b>${esc(v)}</b></div>`).join("")}${foot ? `<div class="meta" style="margin-top:4px">${foot}</div>` : ""}`;
  $tip.hidden = false;
  const pad = 14;
  const { innerWidth: W, innerHeight: H } = window;
  const r = $tip.getBoundingClientRect();
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + r.width > W - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > H - 8) y = evt.clientY - r.height - pad;
  $tip.style.left = `${Math.max(8, x)}px`;
  $tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => ($tip.hidden = true);

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

// ---------- People / activity ----------

const SEQ = ["--seq-0", "--seq-1", "--seq-2", "--seq-3", "--seq-4", "--seq-5", "--seq-6"];

async function viewActivity(p) {
  const end = p.end || cfg.today;
  const data = await api(`/api/activity?end=${end}&days=14`);
  const total = (d) => d.commits + d.opened + d.merged + d.comments + d.reviewComments;
  const max = Math.max(1, ...data.people.flatMap((x) => x.days.map(total)));
  const step = (n) => (n === 0 ? 0 : Math.min(6, 1 + Math.floor(((n - 1) / max) * 6)));

  const head = data.dates.map((d) => `<th class="day${isWeekend(d) ? " weekend" : ""}">${fmtDay(d, { weekday: "narrow" })}<br>${fmtDay(d, { day: "numeric" })}</th>`).join("");
  const rows = data.people.map((person) => `<tr>
      <td class="person"><button class="link" data-person="${esc(person.login)}" data-date="${esc(p.date || end)}">${esc(person.name)}</button><div class="meta">@${esc(person.login)}</div></td>
      ${person.days.map((d) => {
        const n = total(d), s = step(n);
        const sel = p.login === person.login && p.date === d.date ? " selected" : "";
        return `<td class="cell"><button class="heat${sel}${s >= 4 ? " dark-fill" : ""}" style="background:var(${SEQ[s]})" data-person="${esc(person.login)}" data-date="${d.date}" data-tip='${esc(JSON.stringify({ name: person.name, ...d }))}' aria-label="${esc(person.name)} ${d.date}: ${n} events">${n || ""}</button></td>`;
      }).join("")}
    </tr>`).join("");

  $view.innerHTML = `
    <h2>What people worked on</h2>
    <p class="sub">Each cell counts one person's GitHub activity that day (${esc(data.timezone)}): non-merge commits authored, issues and PRs opened, their PRs merged, and comments (conversation and inline review). Click a cell for the details.</p>
    <div class="controls">
      <button data-shift="-7">‹ Earlier</button>
      <button data-shift="7" ${end >= cfg.today ? "disabled" : ""}>Later ›</button>
      <span class="muted">${fmtDay(data.dates[0])} – ${fmtDay(data.dates.at(-1))}</span>
    </div>
    <div class="card scroll" id="grid-card">
      <table class="grid-table"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table>
      <div class="legend" style="margin-top:10px"><span>Fewer</span>${SEQ.slice(1).map((v) => `<span class="swatch" style="background:var(${v});margin:0"></span>`).join("")}<span>More events (darkest = ${max})</span></div>
      <div class="note">${esc(coverageNote(data.coverageFrom))}</div>
    </div>
    <div id="person-detail"></div>`;

  // On narrow screens the grid scrolls; start at the most recent days.
  const gridCard = document.getElementById("grid-card");
  gridCard.scrollLeft = gridCard.scrollWidth;

  $view.querySelectorAll("[data-shift]").forEach((b) => b.addEventListener("click", () => {
    const next = addDays(end, Number(b.dataset.shift));
    setHash("activity", { ...p, end: next > cfg.today ? cfg.today : next });
  }));
  $view.querySelectorAll("[data-person]").forEach((b) => b.addEventListener("click", () => setHash("activity", { ...p, login: b.dataset.person, date: b.dataset.date })));
  $view.querySelectorAll(".heat").forEach((b) => {
    b.addEventListener("mousemove", (e) => {
      const d = JSON.parse(b.dataset.tip);
      showTip(e, `${esc(d.name)} · ${fmtDay(d.date)}`, [["Commits", d.commits], ["Issues/PRs opened", d.opened], ["PRs merged", d.merged], ["Comments", d.comments], ["Review comments", d.reviewComments]]);
    });
    b.addEventListener("mouseleave", hideTip);
  });

  if (p.login) await renderPersonDay(p.login, p.date || cfg.today, p);
}

async function renderPersonDay(login, date, p) {
  const el = document.getElementById("person-detail");
  el.innerHTML = `<div class="card muted">Loading…</div>`;
  const d = await api(`/api/person?login=${encodeURIComponent(login)}&date=${date}`);
  const adds = d.commits.reduce((s, c) => s + (c.additions || 0), 0);
  const dels = d.commits.reduce((s, c) => s + (c.deletions || 0), 0);
  const commentCount = d.threads.reduce((s, t) => s + t.comments.length, 0);

  const itemLine = (i, verb) => `<li>${i.kind === "pr" ? "PR" : "Issue"} <a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(shortRepo(i.repo))}#${i.number}</a> ${esc(i.title)}
      ${i.draft ? '<span class="pill">draft</span>' : ""}${verb === "opened" && i.state === "closed" ? `<span class="pill">${i.merged ? "merged" : "closed"} since</span>` : ""}
      <span class="meta"> · ${verb} ${fmtTime(i.at)}</span></li>`;
  const section = (title, items, body) => (items.length ? `<h3>${title} <span class="muted">${items.length}</span></h3>${body}` : "");

  el.innerHTML = `<div class="card">
    <div class="day-head">
      <button data-day="-1" aria-label="Previous day">‹</button>
      <h2>${esc(d.name)} · ${fmtDay(date, { weekday: "long", day: "numeric", month: "long" })}</h2>
      <button data-day="1" ${date >= cfg.today ? "disabled" : ""} aria-label="Next day">›</button>
      <a class="meta" href="https://github.com/${esc(d.login)}" target="_blank" rel="noopener">@${esc(d.login)} on GitHub</a>
    </div>
    <div class="stat-row">
      <div class="stat"><div class="v">${d.commits.length}</div><div class="l">commits</div></div>
      <div class="stat"><div class="v"><span class="add">+${fmtInt(adds)}</span> <span class="del">−${fmtInt(dels)}</span></div><div class="l">lines</div></div>
      <div class="stat"><div class="v">${d.opened.length}</div><div class="l">opened</div></div>
      <div class="stat"><div class="v">${d.merged.length}</div><div class="l">PRs merged</div></div>
      <div class="stat"><div class="v">${commentCount}</div><div class="l">comments on ${d.threads.length} threads</div></div>
    </div>
    ${d.commits.length + d.opened.length + d.merged.length + d.closed.length + d.threads.length === 0 ? `<p class="empty">Nothing recorded for this day.</p>` : ""}
    ${section("Commits", d.commits, `<ul class="list">${d.commits.map((c) => `<li>
        <a class="mono" href="${esc(c.url)}" target="_blank" rel="noopener">${c.sha.slice(0, 7)}</a> ${esc(c.headline)}
        ${c.merge ? '<span class="pill">merge</span>' : ""}
        <div class="meta">${esc(c.repo)} · ${esc(c.branch || "")} · ${fmtTime(c.at)}
          ${c.filesStatus === "pending" ? " · file stats pending" : c.additions != null ? ` · <span class="add">+${fmtInt(c.additions)}</span> <span class="del">−${fmtInt(c.deletions)}</span> in ${c.files} file${c.files === 1 ? "" : "s"}` : ""}
          ${c.topDirs.length ? ` · ${c.topDirs.map((t) => `<code>${esc(t.dir)}</code>`).join(", ")}` : ""}</div></li>`).join("")}</ul>`)}
    ${section("Opened", d.opened, `<ul class="list">${d.opened.map((i) => itemLine(i, "opened")).join("")}</ul>`)}
    ${section("Their PRs merged", d.merged, `<ul class="list">${d.merged.map((i) => itemLine(i, "merged")).join("")}</ul>`)}
    ${section("Their issues/PRs closed", d.closed, `<ul class="list">${d.closed.map((i) => itemLine(i, "closed")).join("")}</ul>`)}
    ${section("Conversations", d.threads, `<ul class="list">${d.threads.map((t) => `<li>
        ${t.kind === "pr" ? "PR" : t.kind === "issue" ? "Issue" : ""} <a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(shortRepo(t.repo))}#${t.number}</a> ${esc(t.title || "")}
        <div class="thread">${t.comments.map((c) => `<div class="c"><a class="meta" href="${esc(c.url)}" target="_blank" rel="noopener">${fmtTime(c.at)}${c.kind === "review" ? ` · review on <code>${esc(c.path || "")}</code>` : ""}</a><div class="ink-2">${esc(c.excerpt)}</div></div>`).join("")}</div></li>`).join("")}</ul>`)}
  </div>`;
  el.querySelectorAll("[data-day]").forEach((b) => b.addEventListener("click", () => setHash("activity", { ...p, login, date: addDays(date, Number(b.dataset.day)) })));
}

// ---------- Issue health ----------

async function viewHealth() {
  const { repos } = await api("/api/health");
  const link = (x, text) => (x ? `<a href="${esc(x.url)}" target="_blank" rel="noopener" title="#${x.number} ${esc(x.title)}">${text}</a>` : "–");
  const partial = (w) => (w.complete ? "" : `<sup title="Window starts before the mirror did, so this may undercount">*</sup>`);
  const anyPartial = repos.some((r) => r.windows.some((w) => !w.complete));

  $view.innerHTML = `
    <h2>Repo issue health</h2>
    <p class="sub">Raw numbers per repo, to spot repos falling behind on issues. Open counts are current; flow counts come from the mirror.</p>
    <div class="card scroll"><h3 style="margin-top:0">Backlog now</h3>
      <table><thead><tr><th>Repo</th><th class="num">Open issues</th><th class="num">No comments yet</th><th class="num">Oldest with no comments</th><th class="num">Unassigned</th><th class="num">Unlabelled</th><th class="num">Median open age</th><th class="num">Oldest open</th><th class="num">Open PRs</th><th class="num">of which draft</th></tr></thead>
      <tbody>${repos.map((r) => `<tr>
        <td><a href="https://github.com/${esc(r.repo)}/issues" target="_blank" rel="noopener">${esc(r.repo)}</a></td>
        <td class="num">${fmtInt(r.openIssues)}</td>
        <td class="num">${fmtInt(r.openIssuesNoComments)}</td>
        <td class="num">${link(r.oldestNoComment, r.oldestNoComment ? days(r.oldestNoComment.ageDays) : "")}</td>
        <td class="num">${fmtInt(r.unassignedOpenIssues)}</td>
        <td class="num">${fmtInt(r.unlabelledOpenIssues)}</td>
        <td class="num">${days(r.medianOpenIssueAgeDays)}</td>
        <td class="num">${link(r.oldestOpenIssue, r.oldestOpenIssue ? days(r.oldestOpenIssue.ageDays) : "")}</td>
        <td class="num"><a href="#prs?repo=${encodeURIComponent(r.repo)}">${fmtInt(r.openPrs)}</a></td>
        <td class="num">${fmtInt(r.draftPrs)}</td></tr>`).join("")}</tbody></table>
      <div class="note">"No comments yet" uses GitHub's comment count, so it covers the issue's full history, not just the mirror's.</div>
    </div>
    <div class="card scroll"><h3 style="margin-top:0">Flow</h3>
      <table><thead><tr><th>Repo</th><th class="num">Issues opened 7d</th><th class="num">Issues closed 7d</th><th class="num">Issues opened 30d</th><th class="num">Issues closed 30d</th><th class="num">PRs opened 7d</th><th class="num">PRs merged 7d</th><th class="num">PRs opened 30d</th><th class="num">PRs merged 30d</th></tr></thead>
      <tbody>${repos.map((r) => { const [w7, w30] = r.windows; return `<tr><td>${esc(r.repo)}</td>
        <td class="num">${fmtInt(w7.issuesOpened)}${partial(w7)}</td><td class="num">${fmtInt(w7.issuesClosed)}${partial(w7)}</td>
        <td class="num">${fmtInt(w30.issuesOpened)}${partial(w30)}</td><td class="num">${fmtInt(w30.issuesClosed)}${partial(w30)}</td>
        <td class="num">${fmtInt(w7.prsOpened)}${partial(w7)}</td><td class="num">${fmtInt(w7.prsMerged)}${partial(w7)}</td>
        <td class="num">${fmtInt(w30.prsOpened)}${partial(w30)}</td><td class="num">${fmtInt(w30.prsMerged)}${partial(w30)}</td></tr>`; }).join("")}</tbody></table>
      ${anyPartial ? `<div class="note">* The window reaches back before the mirror started (${esc(repos.map((r) => `${shortRepo(r.repo)}: ${fmtDateTime(r.coverageFrom)}`).join(", "))}). Anything opened and closed again before then was never mirrored, so those counts can be low.</div>` : ""}
    </div>
    <h3>Issues opened vs closed per week</h3>
    <div class="legend" style="margin-bottom:8px"><span><span class="swatch" style="background:var(--series-1)"></span>Opened</span><span><span class="swatch" style="background:var(--series-2)"></span>Closed</span></div>
    <div class="charts">${repos.map((r) => `<div class="card"><div style="font-weight:600;margin-bottom:6px">${esc(r.repo)}</div>${weeklyChart(r.weeks)}</div>`).join("")}</div>`;

  $view.querySelectorAll("[data-week]").forEach((g) => {
    g.addEventListener("mousemove", (e) => { const w = JSON.parse(g.dataset.week); showTip(e, `Week of ${fmtDay(w.week, { day: "numeric", month: "short" })}`, [["Opened", w.opened], ["Closed", w.closed]]); });
    g.addEventListener("mouseleave", hideTip);
  });
}

function weeklyChart(weeks) {
  if (!weeks.length) return `<div class="empty">No weeks recorded yet.</div>`;
  const W = 320, H = 150, m = { l: 30, r: 6, t: 8, b: 22 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = niceMax(Math.max(1, ...weeks.flatMap((w) => [w.opened, w.closed])));
  const band = iw / weeks.length;
  const bw = Math.min(12, (band - 8) / 2);
  const y = (v) => m.t + ih - (v / max) * ih;
  const bar = (x, v, color) => {
    if (!v) return "";
    const top = y(v), h = m.t + ih - top, r = Math.min(4, h);
    return `<path d="M${x},${m.t + ih} V${top + r} q0,-${r} ${r},-${r} h${bw - 2 * r} q${r},0 ${r},${r} V${m.t + ih} Z" fill="var(${color})"/>`;
  };
  const ticks = max % 2 ? [0, max] : [0, max / 2, max]; // counts: integer ticks only
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Issues opened and closed per week">
    ${ticks.map((t) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join("")}
    ${weeks.map((w, i) => {
      const cx = m.l + band * i + band / 2;
      return `<g data-week='${esc(JSON.stringify(w))}'><rect class="hit" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}"/>
        ${bar(cx - bw - 1, w.opened, "--series-1")}${bar(cx + 1, w.closed, "--series-2")}
        ${weeks.length <= 8 || i % 2 === 0 ? `<text x="${cx}" y="${H - 6}" text-anchor="middle">${fmtDay(w.week, { day: "numeric", month: "short" })}</text>` : ""}</g>`;
    }).join("")}
    <line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/>
  </svg>`;
}

// ---------- PR ages ----------

async function viewPrs(p) {
  const data = await api("/api/prs");
  const team = p.team === "1";
  const repos = data.repos.filter((r) => !p.repo || r === p.repo);
  const prs = data.prs.filter((x) => repos.includes(x.repo) && (!team || x.team));

  $view.innerHTML = `
    <h2>Open PR ages</h2>
    <p class="sub">Every open PR, placed by how long it has been open. Click a point to open the PR on GitHub.</p>
    <div class="controls">
      <label>Repo <select id="f-repo"><option value="">All</option>${data.repos.map((r) => `<option ${r === p.repo ? "selected" : ""}>${esc(r)}</option>`).join("")}</select></label>
      <label><input type="checkbox" id="f-team" ${team ? "checked" : ""}> Team authors only</label>
      <span class="muted">${prs.length} open PRs</span>
    </div>
    <div class="card">
      <div class="legend" style="margin-bottom:6px"><span><span class="dot" style="background:var(--series-1)"></span>Ready for review</span><span><span class="dot" style="background:var(--series-2)"></span>Draft</span></div>
      <div id="pr-chart"></div>
    </div>
    <div class="card scroll"><table><thead><tr><th>PR</th><th>Author</th><th class="num">Open for</th><th class="num">Last update</th><th>Requested reviewers</th><th class="num">Comments</th></tr></thead>
      <tbody>${[...prs].sort((a, b) => b.ageDays - a.ageDays).map((x) => `<tr>
        <td><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(shortRepo(x.repo))}#${x.number}</a> ${esc(x.title)}${x.draft ? '<span class="pill">draft</span>' : ""}</td>
        <td>${esc(x.author || "?")}${x.team ? "" : ' <span class="muted">(ext)</span>'}</td>
        <td class="num">${days(x.ageDays)}</td><td class="num">${days(x.idleDays)} ago</td>
        <td>${esc(x.requestedReviewers.join(", ") || "–")}</td><td class="num">${x.comments + x.reviewComments}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No open PRs.</td></tr>`}</tbody></table></div>`;

  document.getElementById("f-repo").addEventListener("change", (e) => setHash("prs", { ...p, repo: e.target.value }));
  document.getElementById("f-team").addEventListener("change", (e) => setHash("prs", { ...p, team: e.target.checked ? "1" : "" }));
  const draw = () => drawPrChart(document.getElementById("pr-chart"), prs, repos);
  draw();
  window.onresize = draw;
}

function drawPrChart(el, prs, repos) {
  if (!prs.length) return (el.innerHTML = `<div class="empty">No open PRs to plot.</div>`);
  const W = Math.max(320, el.clientWidth), labelW = Math.min(170, W * 0.28);
  const bandH = Math.max(44, Math.min(90, 14 + Math.sqrt(prs.length / repos.length) * 14));
  const m = { l: labelW, r: 16, t: 8, b: 30 };
  const H = m.t + m.b + bandH * repos.length, iw = W - m.l - m.r;
  // Log scale: ages run from hours to years.
  const minD = 1 / 24, maxD = Math.max(7, ...prs.map((x) => x.ageDays)) * 1.15;
  const x = (d) => m.l + (Math.log(Math.max(d, minD) / minD) / Math.log(maxD / minD)) * iw;
  const ticks = [[1 / 24, "1h"], [1, "1d"], [7, "1w"], [30.44, "1mo"], [91, "3mo"], [182, "6mo"], [365.25, "1y"], [730, "2y"], [1826, "5y"]].filter(([d]) => d <= maxD);
  // Deterministic jitter inside each band so points don't stack.
  const jitter = (n) => (((n * 2654435761) % 1000) / 1000 - 0.5) * (bandH - 20);

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Open PRs by age">
    ${ticks.map(([d, l]) => `<line class="gridline" x1="${x(d)}" x2="${x(d)}" y1="${m.t}" y2="${H - m.b}"/><text x="${x(d)}" y="${H - m.b + 16}" text-anchor="middle">${l}</text>`).join("")}
    ${repos.map((r, i) => `<text class="lbl" x="${m.l - 12}" y="${m.t + bandH * i + bandH / 2 + 4}" text-anchor="end">${esc(r)}</text>${i ? `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${m.t + bandH * i}" y2="${m.t + bandH * i}"/>` : ""}`).join("")}
    <line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>
    ${prs.map((pr, k) => {
      const cy = m.t + bandH * repos.indexOf(pr.repo) + bandH / 2 + jitter(pr.number);
      return `<circle class="pt" data-k="${k}" cx="${x(pr.ageDays)}" cy="${cy}" r="5" fill="var(${pr.draft ? "--series-2" : "--series-1"})"/>`;
    }).join("")}
    <text x="${m.l + iw / 2}" y="${H - 2}" text-anchor="middle">Time open (log scale)</text>
  </svg>`;
  el.querySelectorAll(".pt").forEach((c) => {
    const pr = prs[Number(c.dataset.k)];
    c.addEventListener("mousemove", (e) => showTip(e, `${esc(shortRepo(pr.repo))}#${pr.number} ${esc(pr.title)}`,
      [["Author", pr.author || "?"], ["Open for", days(pr.ageDays)], ["Last update", `${days(pr.idleDays)} ago`], ["Status", pr.draft ? "Draft" : "Ready"], ["Reviewers requested", pr.requestedReviewers.join(", ") || "–"]],
      "Click to open on GitHub"));
    c.addEventListener("mouseleave", hideTip);
    c.addEventListener("click", () => window.open(pr.url, "_blank", "noopener"));
  });
}

// ---------- Churn ----------

async function viewChurn(p) {
  const to = p.to || cfg.today;
  const from = p.from || addDays(to, -6);
  const depth = p.depth || "2";
  const q = new URLSearchParams({ from, to, depth, repo: p.repo || "", who: p.who || "all", exclude: p.exclude === "0" ? "0" : "1" });
  const data = await api(`/api/churn?${q}`);
  const preset = (n) => setHash("churn", { ...p, from: addDays(cfg.today, -(n - 1)), to: cfg.today });
  const top = data.dirs.slice(0, 25);

  $view.innerHTML = `
    <h2>Code churn by directory</h2>
    <p class="sub">Lines added and removed per directory, from per-file line counts of non-merge commits authored in the period.</p>
    <div class="controls">
      <span><button data-preset="7">7 days</button> <button data-preset="14">14 days</button> <button data-preset="30">30 days</button></span>
      <label>From <input type="date" id="f-from" value="${from}" max="${cfg.today}"></label>
      <label>To <input type="date" id="f-to" value="${to}" max="${cfg.today}"></label>
      <label>Depth <select id="f-depth">${[1, 2, 3, 4].map((d) => `<option ${String(d) === depth ? "selected" : ""}>${d}</option>`).join("")}</select></label>
      <label>Repo <select id="f-repo"><option value="">All</option>${cfg.repos.map((r) => `<option ${r.name === p.repo ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>
      <label>Who <select id="f-who"><option value="all">Everyone</option><option value="team" ${p.who === "team" ? "selected" : ""}>Team</option>${cfg.users.map((u) => `<option value="${esc(u.login)}" ${p.who === u.login ? "selected" : ""}>${esc(u.name || u.login)}</option>`).join("")}</select></label>
      <label title="${esc(data.excludePatterns.join(", "))}"><input type="checkbox" id="f-ex" ${p.exclude === "0" ? "" : "checked"}> Hide lockfiles &amp; generated</label>
    </div>
    <div class="card">
      <div class="stat-row" style="margin-top:0">
        <div class="stat"><div class="v">${fmtInt(data.totals.lines)}</div><div class="l">lines changed</div></div>
        <div class="stat"><div class="v">${fmtInt(data.totals.commits)}</div><div class="l">commits</div></div>
        <div class="stat"><div class="v">${fmtInt(data.dirs.length)}</div><div class="l">directories</div></div>
        ${data.query.exclude ? `<div class="stat"><div class="v">${fmtInt(data.totals.excludedLines)}</div><div class="l">lines hidden by filter</div></div>` : ""}
      </div>
      ${data.totals.pendingCommits ? `<div class="note">${data.totals.pendingCommits} commits in this period are still waiting for file stats; they'll appear after the next sync.</div>` : ""}
      <div class="legend" style="margin:12px 0 6px"><span><span class="swatch" style="background:var(--series-1)"></span>Added</span><span><span class="swatch" style="background:var(--series-2)"></span>Removed</span>${data.dirs.length > top.length ? `<span class="muted">Top ${top.length} of ${data.dirs.length}; all in the table below.</span>` : ""}</div>
      <div id="churn-chart"></div>
      <div class="note">${esc(coverageNote(data.coverageFrom))}</div>
    </div>
    <div class="card scroll"><table><thead><tr><th>Directory</th><th class="num">Added</th><th class="num">Removed</th><th class="num">Total</th><th class="num">Files</th><th class="num">Commits</th><th>Who</th></tr></thead>
      <tbody>${data.dirs.map((d) => `<tr><td class="mono">${esc(d.dir)}</td><td class="num add">+${fmtInt(d.additions)}</td><td class="num del">−${fmtInt(d.deletions)}</td><td class="num">${fmtInt(d.lines)}</td><td class="num">${d.files}</td><td class="num">${d.commits}</td><td>${esc(d.people.join(", "))}</td></tr>`).join("") || `<tr><td colspan="7" class="empty">No commits with file stats in this period.</td></tr>`}</tbody></table></div>`;

  $view.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => preset(Number(b.dataset.preset))));
  const bind = (id, key, val = (e) => e.target.value) => document.getElementById(id).addEventListener("change", (e) => setHash("churn", { ...p, from, to, [key]: val(e) }));
  bind("f-from", "from"); bind("f-to", "to"); bind("f-depth", "depth"); bind("f-repo", "repo"); bind("f-who", "who");
  bind("f-ex", "exclude", (e) => (e.target.checked ? "" : "0"));
  const draw = () => drawChurn(document.getElementById("churn-chart"), top);
  draw();
  window.onresize = draw;
}

function drawChurn(el, dirs) {
  if (!dirs.length) return (el.innerHTML = `<div class="empty">Nothing to chart.</div>`);
  const W = Math.max(320, el.clientWidth);
  const labelW = Math.min(260, W * 0.38), valueW = 64;
  const row = 26, bh = 16, m = { t: 4, b: 24 };
  const iw = W - labelW - valueW - 8;
  const max = niceMax(Math.max(...dirs.map((d) => d.lines)));
  const H = m.t + m.b + row * dirs.length;
  const x = (v) => (v / max) * iw;
  const trunc = (s, n) => (s.length > n ? `…${s.slice(-(n - 1))}` : s);
  const maxChars = Math.floor(labelW / 7);
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Lines changed per directory">
    ${ticks.map((t) => `<line class="gridline" x1="${labelW + x(t)}" x2="${labelW + x(t)}" y1="${m.t}" y2="${H - m.b}"/><text x="${labelW + x(t)}" y="${H - 6}" text-anchor="middle">${fmtInt(Math.round(t))}</text>`).join("")}
    ${dirs.map((d, i) => {
      const y = m.t + row * i + (row - bh) / 2;
      const a = x(d.additions), r = x(d.deletions);
      const gap = a > 0 && r > 0 ? 2 : 0;
      const r4 = Math.min(4, r || a);
      // added segment square at the baseline; the outer end of the whole bar gets the 4px rounding
      const addPath = r > 0 ? `<rect x="${labelW}" y="${y}" width="${Math.max(0, a)}" height="${bh}" fill="var(--series-1)"/>`
        : `<path d="M${labelW},${y} h${Math.max(0, a - r4)} q${r4},0 ${r4},${r4} v${bh - 2 * r4} q0,${r4} -${r4},${r4} h-${Math.max(0, a - r4)} Z" fill="var(--series-1)"/>`;
      const sx = labelW + a + gap, sw = Math.max(0, r - gap);
      const delPath = r > 0 ? `<path d="M${sx},${y} h${Math.max(0, sw - r4)} q${r4},0 ${r4},${r4} v${bh - 2 * r4} q0,${r4} -${r4},${r4} h-${Math.max(0, sw - r4)} Z" fill="var(--series-2)"/>` : "";
      return `<g data-i="${i}"><rect class="hit" x="0" y="${m.t + row * i}" width="${W}" height="${row}"/>
        <text class="lbl" x="${labelW - 10}" y="${y + bh - 3}" text-anchor="end">${esc(trunc(d.dir, maxChars))}</text>
        ${addPath}${delPath}
        <text class="val" x="${labelW + a + gap + sw + 6}" y="${y + bh - 3}">${fmtInt(d.lines)}</text></g>`;
    }).join("")}
    <line class="axis" x1="${labelW}" x2="${labelW}" y1="${m.t}" y2="${H - m.b}"/>
  </svg>`;
  el.querySelectorAll("[data-i]").forEach((g) => {
    const d = dirs[Number(g.dataset.i)];
    g.addEventListener("mousemove", (e) => showTip(e, `<span class="mono">${esc(d.dir)}</span>`, [["Added", `+${fmtInt(d.additions)}`], ["Removed", `−${fmtInt(d.deletions)}`], ["Files", d.files], ["Commits", d.commits], ["Who", d.people.join(", ")]]));
    g.addEventListener("mouseleave", hideTip);
  });
}

// ---------- Sync status ----------

async function viewSync() {
  const s = await api("/api/status");
  $view.innerHTML = `
    <h2>Sync</h2>
    <p class="sub">The mirror polls GitHub every ${s.pollMinutes} min using conditional requests (unchanged listings come back 304 and don't use rate limit). Next sync ${s.nextSyncAt ? ago(s.nextSyncAt) : "not scheduled"}. Auth: <b>${esc(s.authMode)}</b>.${s.backfillSince ? ` Backfill from ${fmtDateTime(s.backfillSince)}.` : ""}</p>
    <div class="card scroll"><table><thead><tr><th>Repo</th><th>Branches</th><th>Mirror since</th><th>Last success</th><th class="num">Issues</th><th class="num">PRs</th><th class="num">Commits</th><th class="num">File stats pending</th><th class="num">Comments</th><th class="num">Review comments</th><th>Last error</th></tr></thead>
      <tbody>${s.repos.map((r) => `<tr><td>${esc(r.repo)}</td><td>${esc(r.branches)}${r.counts.branches ? ` (${r.counts.branches})` : ""}</td>
        <td>${fmtDateTime(r.state?.floor)}</td><td>${r.state?.last_success_at ? ago(r.state.last_success_at) : "never"}</td>
        <td class="num">${fmtInt(r.counts.issues)}</td><td class="num">${fmtInt(r.counts.prs)}</td><td class="num">${fmtInt(r.counts.commits)}</td>
        <td class="num">${fmtInt(r.counts.pendingCommitFiles)}</td><td class="num">${fmtInt(r.counts.issueComments)}</td><td class="num">${fmtInt(r.counts.reviewComments)}</td>
        <td class="error">${esc(r.state?.last_error || "")}</td></tr>`).join("")}</tbody></table></div>
    <h3>Recent runs</h3>
    <div class="card scroll"><table><thead><tr><th>Started</th><th>Trigger</th><th class="num">Duration</th><th class="num">Requests</th><th class="num">304s</th><th class="num">Rate left</th><th>Changes</th></tr></thead>
      <tbody>${s.log.map((l) => {
        const changes = l.summary ? l.summary.repos.map((r) => [r.items && `${r.items} items`, r.comments && `${r.comments} comments`, r.commits && `${r.commits} commits`, r.commitFiles && `${r.commitFiles} file stats`].filter(Boolean).map((t) => `${shortRepo(r.repo)}: ${t}`)).flat().join(" · ") : "";
        return `<tr><td>${fmtDateTime(l.started_at)}</td><td>${esc(l.trigger)}</td>
          <td class="num">${l.finished_at ? `${((Date.parse(l.finished_at) - Date.parse(l.started_at)) / 1000).toFixed(1)}s` : "running"}</td>
          <td class="num">${fmtInt(l.requests)}</td><td class="num">${fmtInt(l.not_modified)}</td><td class="num">${fmtInt(l.rate_remaining)}</td>
          <td>${l.error ? `<span class="error">${esc(l.error)}</span>` : esc(changes || "no changes")}${l.summary?.incomplete ? ' <span class="pill">continues next run</span>' : ""}</td></tr>`;
      }).join("")}</tbody></table></div>`;
}

// ---------- shell ----------

const views = { activity: viewActivity, health: viewHealth, prs: viewPrs, churn: viewChurn, sync: viewSync };

async function render() {
  const { route, params } = parseHash();
  document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${route}`));
  window.onresize = null;
  hideTip();
  try {
    await (views[route] || viewActivity)(params);
  } catch (e) {
    $view.innerHTML = `<div class="card error">Couldn't load this view: ${esc(e.message)}</div>`;
  }
}

async function updateSyncStatus() {
  try {
    const s = await api("/api/status");
    const last = s.repos.map((r) => r.state?.last_success_at).filter(Boolean).sort()[0];
    const errors = s.repos.filter((r) => r.state?.last_error).length;
    document.getElementById("sync-status").innerHTML = s.syncing ? "Syncing…" : `Synced ${ago(last)}${errors ? ` · <a class="error" href="#sync">${errors} error${errors > 1 ? "s" : ""}</a>` : ""}`;
  } catch {
    /* status is best-effort */
  }
}

document.getElementById("refresh").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  document.getElementById("sync-status").textContent = "Syncing…";
  try {
    const r = await api("/api/refresh", { method: "POST" });
    const changed = r.repos.reduce((s, x) => s + x.items + x.comments + x.commits + x.commitFiles, 0);
    btn.textContent = changed ? `${changed} updates` : "Up to date";
  } catch (err) {
    btn.textContent = "Refresh failed";
    btn.title = err.message;
  }
  await Promise.all([render(), updateSyncStatus()]);
  setTimeout(() => { btn.textContent = "Refresh"; btn.disabled = false; }, 2000);
});

window.addEventListener("hashchange", render);
cfg = await api("/api/config");
render();
updateSyncStatus();
setInterval(updateSyncStatus, 60_000);
