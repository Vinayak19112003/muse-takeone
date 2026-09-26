/**
 * Deterministic visual fixtures for the reconstruction pipeline.
 *
 * Renders synthetic mock-HTML pages in headless Chromium (NOT real sites, NOT the
 * managed browser — these fixtures carry source.type "manual-screenshots") and writes
 * a `takeone reconstruct` input.json per fixture with DOM-grounded targets:
 *
 * - form/   : login-like form with fake credentials. click field -> type username
 *             (HUD pill visible) -> click password -> type sensitive (HUD hidden)
 *             -> click sign in -> welcome state.
 * - scroll/ : long page, two scroll actions. Exercises the auto slide transition and
 *             its direction.
 * - nav/    : dashboard sidebar -> projects list -> project detail. Two distant
 *             clicks: camera must reframe smoothly, crossfade at each cut.
 *
 * Usage: node tests/fixtures/visual/gen.mjs   (writes tests/fixtures/visual/<name>/)
 */
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const VW = 1280, VH = 800;

const browser = await chromium.launch({
  executablePath: process.env.TAKEONE_CHROMIUM_PATH ?? "/opt/meta-chromium/chrome",
  args: ["--no-sandbox", "--hide-scrollbars"],
});
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });

async function center(id) {
  const b = await page.locator(`#${id}`).boundingBox();
  if (!b) throw new Error(`no box for #${id}`);
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}

async function shot(dir, name, html, scrollY = 0) {
  await page.setContent(html);
  await page.waitForTimeout(150);
  if (scrollY) await page.evaluate((y) => window.scrollTo(0, y), scrollY);
  await page.waitForTimeout(80);
  await page.screenshot({ path: join(dir, "frames", name) });
}

const SOURCE = { type: "manual-screenshots", note: "synthetic deterministic fixture, not a real capture" };

function writeInput(dir, frames) {
  writeFileSync(
    join(dir, "input.json"),
    JSON.stringify({ version: 1, source: SOURCE, viewport: { width: VW, height: VH }, screenshotsDir: "frames", frames }, null, 2),
  );
}

// ---------------------------------------------------------------- form
{
  const dir = join(here, "form");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "frames"), { recursive: true });

  const formHtml = (user, pass) => `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#0b0e14;color:#e6edf3;font:15px system-ui;display:flex;align-items:center;justify-content:center;height:100vh}
    .card{width:380px;background:#11161f;border:1px solid #232b36;border-radius:14px;padding:32px}
    h1{font-size:20px;margin:0 0 6px}.sub{color:#8b949e;font-size:13px;margin-bottom:22px}
    label{display:block;font-size:12px;color:#8b949e;margin:0 0 6px}
    input{width:100%;box-sizing:border-box;background:#0b0e14;border:1px solid #2d3642;border-radius:8px;color:#e6edf3;
      font-size:15px;padding:11px 12px;margin-bottom:16px;outline:none}
    input:focus{border-color:#1f6feb}
    button{width:100%;background:#1f6feb;border:0;border-radius:8px;color:#fff;font-size:15px;font-weight:600;
      padding:12px;cursor:default;margin-top:4px}
    .welcome{text-align:center}.welcome .tick{font-size:44px;color:#3fb950;margin-bottom:12px}
  </style></head><body>${
    user === "WELCOME"
      ? `<div class="card welcome"><div class="tick">✓</div><h1>Welcome back</h1><div class="sub">Signed in as demo_user</div></div>`
      : `<div class="card"><h1>Sign in</h1><div class="sub">Demo workspace — fake credentials only</div>
        <label>Username</label><input id="username" value="${user}" readonly>
        <label>Password</label><input id="password" type="password" value="${pass}" readonly>
        <button id="signin">Sign in</button></div>`
  }</body></html>`;

  await page.setContent(formHtml("", ""));
  await page.waitForTimeout(150);
  const u = await center("username"), p = await center("password"), s = await center("signin");
  await shot(dir, "01-empty.png", formHtml("", ""));
  await shot(dir, "02-username.png", formHtml("demo_user", ""));
  await shot(dir, "03-password.png", formHtml("demo_user", "••••••••••"));
  await shot(dir, "04-welcome.png", formHtml("WELCOME", ""));
  writeInput(dir, [
    { file: "01-empty.png", caption: "Sign in to the demo workspace", actions: [
      { kind: "click", ...u, pauseMs: 500 },
      { kind: "type", x: u.x, y: u.y, text: "demo_user", showKeys: true, pauseMs: 500 },
    ]},
    { file: "02-username.png", caption: "Username entered", actions: [
      { kind: "click", ...p, pauseMs: 500 },
      { kind: "type", x: p.x, y: p.y, text: "Tr0ub4dor-fake", sensitive: true, pauseMs: 500 },
    ]},
    { file: "03-password.png", caption: "Password stays hidden", actions: [{ kind: "click", ...s, pauseMs: 600 }]},
    { file: "04-welcome.png", caption: "Signed in", holdMs: 2200 },
  ]);
  console.log("form:", JSON.stringify({ u, p, s }));
}

// ---------------------------------------------------------------- scroll
{
  const dir = join(here, "scroll");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "frames"), { recursive: true });

  const section = (n, title, text) => `<div class="sec"><div class="kicker">Section ${n}</div><h2>${title}</h2><p>${text}</p></div>`;
  const longHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#fafafa;color:#1a1a1a;font:16px/1.6 system-ui}
    .hero{background:#111827;color:#fff;padding:120px 80px}
    .hero h1{font-size:44px;margin:0 0 12px}.hero p{color:#9ca3af;font-size:18px;max-width:640px}
    .wrap{max-width:760px;margin:0 auto;padding:60px 24px}
    .sec{margin:0 0 90px}.kicker{font-size:12px;letter-spacing:2px;color:#6b7280;text-transform:uppercase}
    h2{font-size:28px;margin:8px 0 12px}p{color:#374151}
    .foot{background:#111827;color:#9ca3af;padding:60px 80px;font-size:14px}
  </style></head><body>
    <div class="hero"><h1>The Field Guide</h1><p>A long-form doc used to exercise scroll reconstruction: steady downward motion, readable holds, no clicks.</p></div>
    <div class="wrap">
      ${section(1, "Beginnings", "Every workflow starts somewhere. This section anchors the top of the page with enough text to make the first scroll meaningful. ".repeat(6))}
      ${section(2, "Momentum", "Scrolling down reveals the middle of the document. The camera stays wide here; the motion itself is the story. ".repeat(6))}
      ${section(3, "Arrival", "The final stretch. By the time the footer appears the reader has seen the whole arc of the page. ".repeat(6))}
    </div>
    <div class="foot">© 2026 Field Guide Press — end of fixture</div>
  </body></html>`;

  await shot(dir, "01-top.png", longHtml, 0);
  await shot(dir, "02-mid.png", longHtml, 700);
  await shot(dir, "03-bottom.png", longHtml, 1600);
  writeInput(dir, [
    { file: "01-top.png", caption: "The field guide, top", actions: [{ kind: "scroll", dy: 700, durationMs: 700, pauseMs: 500 }]},
    { file: "02-mid.png", caption: "Scrolling through", actions: [{ kind: "scroll", dy: 700, durationMs: 700, pauseMs: 500 }]},
    { file: "03-bottom.png", caption: "End of the guide", holdMs: 2200 },
  ]);
  console.log("scroll: ok");
}

// ---------------------------------------------------------------- nav
{
  const dir = join(here, "nav");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "frames"), { recursive: true });

  const appHtml = (view) => `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#f3f4f6;color:#111827;font:14px system-ui;display:flex;height:100vh}
    .side{width:230px;background:#111827;color:#d1d5db;padding:20px 12px;box-sizing:border-box}
    .side .logo{font-weight:800;color:#fff;padding:6px 12px 20px;font-size:16px}
    .nav{padding:10px 12px;border-radius:8px;color:#9ca3af;margin-bottom:4px}
    .nav.on{background:#1f2937;color:#fff}
    .main{flex:1;padding:36px 44px;overflow:hidden}
    h1{font-size:24px;margin:0 0 20px}
    .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px}
    .card .t{font-weight:700;margin-bottom:6px}.card .m{color:#6b7280;font-size:12px}
    .row{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px 20px;margin-bottom:10px;display:flex;justify-content:space-between}
    .detail{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;max-width:720px}
    .detail h2{margin:0 0 8px}.detail .m{color:#6b7280;margin-bottom:16px}
    .bar{height:10px;background:#e5e7eb;border-radius:5px;margin:10px 0}
  </style></head><body>
    <div class="side"><div class="logo">▦ Acme Console</div>
      <div class="nav ${view === "overview" ? "on" : ""}" id="nav-overview">Overview</div>
      <div class="nav ${view === "projects" ? "on" : ""}" id="nav-projects">Projects</div>
      <div class="nav" id="nav-team">Team</div></div>
    <div class="main">${view === "overview" ? `<h1>Overview</h1><div class="cards">
        <div class="card"><div class="t">Active projects</div><div class="m">12 this month</div></div>
        <div class="card"><div class="t">Build minutes</div><div class="m">8,412 used</div></div>
        <div class="card"><div class="t">Team</div><div class="m">9 members</div></div></div>`
      : view === "projects" ? `<h1>Projects</h1>
        <div class="row" id="proj-1"><span><b>Website redesign</b></span><span class="m" style="color:#6b7280">Updated 2h ago</span></div>
        <div class="row"><span><b>API v2</b></span><span style="color:#6b7280">Updated 1d ago</span></div>
        <div class="row"><span><b>Mobile app</b></span><span style="color:#6b7280">Updated 3d ago</span></div>`
      : `<h1>Projects / Website redesign</h1><div class="detail"><h2>Website redesign</h2>
        <div class="m">Owner: demo_user · Status: In progress</div>
        <div class="bar" style="width:70%"></div><div class="bar" style="width:45%"></div><div class="bar" style="width:60%"></div></div>`}
    </div></body></html>`;

  await page.setContent(appHtml("overview"));
  await page.waitForTimeout(150);
  const projects = await center("nav-projects");
  await shot(dir, "01-overview.png", appHtml("overview"));
  await page.setContent(appHtml("projects"));
  await page.waitForTimeout(150);
  const proj1 = await center("proj-1");
  await shot(dir, "02-projects.png", appHtml("projects"));
  await shot(dir, "03-detail.png", appHtml("detail"));
  writeInput(dir, [
    { file: "01-overview.png", caption: "The Acme console", actions: [{ kind: "click", ...projects, pauseMs: 600 }]},
    { file: "02-projects.png", caption: "All projects", actions: [{ kind: "click", ...proj1, pauseMs: 600 }]},
    { file: "03-detail.png", caption: "Project detail", holdMs: 2400 },
  ]);
  console.log("nav:", JSON.stringify({ projects, proj1 }));
}

await browser.close();
console.log("fixtures written to", here);
