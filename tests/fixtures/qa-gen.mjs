/**
 * Deterministic visual-QA fixture for the reconstruction pipeline.
 *
 * Renders a mock social-post page in headless Chromium at 4 UI states, grounds the
 * click targets from each screenshot's own DOM, and writes a `takeone reconstruct`
 * input.json. The render of this fixture must show: one stable shot across the
 * like+repost clicks, a crossfade (not a hard cut) at every screenshot change, and
 * no camera motion caused by the cuts.
 *
 * Usage: node tests/fixtures/qa-gen.mjs  (writes tests/fixtures/qa/)
 */
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "qa");
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "frames"), { recursive: true });

const VW = 1280, VH = 800;

function pageHtml(state) {
  const liked = state >= 2, menu = state === 3, reposted = state === 4;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#000;color:#e7e9ea;font:15px system-ui;display:flex;justify-content:center}
    .post{width:560px;border:1px solid #2f3336;border-radius:12px;margin:60px 0;padding:16px;background:#000}
    .head{display:flex;gap:10px;align-items:center;margin-bottom:10px}
    .avatar{width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#1d9bf0,#7c3aed)}
    .name{font-weight:700}.handle{color:#71767b}
    .body{margin:6px 0 14px;line-height:1.45}
    .actions{display:flex;justify-content:space-between;max-width:420px}
    .act{display:flex;gap:8px;align-items:center;color:#71767b;cursor:default;padding:6px 10px;border-radius:20px}
    .heart{color:${liked ? "#f91880" : "#71767b"};font-size:18px}
    .repost{color:${reposted ? "#00ba7c" : "#71767b"};font-size:18px}
    .menu{position:absolute;background:#000;border:1px solid #2f3336;border-radius:12px;box-shadow:0 0 12px #ffffff22;
      ${menu ? "" : "display:none"};padding:6px 0;width:220px}
    .menu div{padding:12px 16px;font-weight:700}
    .menu div:hover{background:#ffffff10}
    .badge{display:inline-block;margin-top:14px;padding:4px 12px;border:1px solid #00ba7c;border-radius:20px;color:#00ba7c;
      ${reposted ? "" : "display:none"}}
  </style></head><body><div class="post" style="position:relative">
    <div class="head"><div class="avatar"></div><div><div class="name">Build Updates</div><div class="handle">@vinayakbuild</div></div></div>
    <div class="body">Shipping a camera overhaul for reconstructed screen recordings: shots, not clicks, drive the zoom. Full write-up in the repo.</div>
    <div class="actions">
      <div class="act" id="like"><span class="heart">${liked ? "♥" : "♡"}</span><span>12${liked ? "8" : ""}</span></div>
      <div class="act" id="repost"><span class="repost">⇄</span><span>3${reposted ? "1" : ""}</span></div>
      <div class="act"><span>◉</span><span>1.2K</span></div>
    </div>
    <div class="menu" id="menu" style="left:120px;top:200px"><div id="repost-confirm">Repost</div><div>Quote</div></div>
    <div class="badge" id="badge">✓ Reposted</div>
  </div></body></html>`;
}

const browser = await chromium.launch({
  executablePath: process.env.TAKEONE_CHROMIUM_PATH ?? "/opt/meta-chromium/chrome",
  args: ["--no-sandbox", "--hide-scrollbars"],
});
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });

async function shot(name, state) {
  await page.setContent(pageHtml(state));
  await page.waitForTimeout(120);
  await page.screenshot({ path: join(root, "frames", name) });
}

async function center(id) {
  const b = await page.locator(`#${id}`).boundingBox();
  if (!b) throw new Error(`no box for #${id}`);
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}

// State 1: capture boxes here, because the buttons don't move between states.
await page.setContent(pageHtml(1));
await page.waitForTimeout(120);
const like = await center("like");
const repost = await center("repost");
await shot("01-post.png", 1);
await shot("02-liked.png", 2);
// State 3: ground the menu item on its own screenshot.
await page.setContent(pageHtml(3));
await page.waitForTimeout(120);
const confirm = await center("repost-confirm");
await page.screenshot({ path: join(root, "frames", "03-menu.png") });
await shot("04-done.png", 4);
await browser.close();

const input = {
  viewport: { width: VW, height: VH },
  screenshotsDir: "frames",
  frames: [
    { file: "01-post.png", holdMs: 2600, caption: "A post worth amplifying", actions: [{ kind: "click", ...like, pauseMs: 700 }] },
    { file: "02-liked.png", holdMs: 2400, caption: "Liked — now repost", actions: [{ kind: "click", ...repost, pauseMs: 700 }] },
    { file: "03-menu.png", holdMs: 2400, caption: "Confirm the repost", actions: [{ kind: "click", ...confirm, pauseMs: 700 }] },
    { file: "04-done.png", holdMs: 2600, caption: "Done" },
  ],
};
writeFileSync(join(root, "input.json"), JSON.stringify(input, null, 2));
console.log(JSON.stringify({ dir: root, like, repost, confirm }, null, 2));
