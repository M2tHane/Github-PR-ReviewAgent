// Manual browser regression: PLAYWRIGHT_CHANNEL=chrome node --test test/frontend/select.browser.mjs
// Uses the Playwright installation already provided by @playwright/mcp. No API or worker is started.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";

const fixture = `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Select } from './frontend/components/common/select.tsx';
function Fixture() {
 const [repo,setRepo]=useState('0');
 return <main style={{padding:32,maxWidth:720}}>
  <h2>下拉框交互验证</h2>
  <label>仓库<Select value={repo} onChange={setRepo}>
   <option value="0">acme/order-api</option>
   <option value="1" disabled>不可用的仓库</option>
   <option value="2">some-very-long-organization-name/{'repository-name-without-spaces-'.repeat(10)}</option>
   {Array.from({length:65},(_,i)=><option key={i+3} value={i+3}>acme/repository-{i+3}</option>)}
  </Select></label>
  <output data-testid="repository">{repo}</output>
  <form onSubmit={e=>{e.preventDefault();document.querySelector('#submitted').textContent=JSON.stringify([...new FormData(e.currentTarget)]);}}>
   <label>规则级别<Select name="level" defaultValue="should"><option value="must">必须</option><option value="should">建议</option><option value="info">参考</option></Select></label>
   <label>禁用的选择<Select name="disabled" disabled defaultValue="locked"><option value="locked">不可修改</option></Select></label>
   <fieldset disabled><label>随表单禁用<Select name="fieldset"><option value="locked">不可修改</option></Select></label></fieldset>
   <label>已失效的关联<Select name="unavailable" value="gone"><option value="gone" disabled>当前关联不可选</option></Select></label>
   <button type="submit">提交</button><button type="reset">重置</button><output id="submitted"/>
  </form>
  <button onClick={()=>document.querySelector('dialog').showModal()}>打开弹窗</button>
  <dialog><label>弹窗级别<Select defaultValue="must"><option value="must">必须</option><option value="should">建议</option></Select></label><button onClick={()=>document.querySelector('dialog').close()}>关闭</button></dialog>
  <div style={{position:'fixed',bottom:16,left:32,width:400}}><label>窗口底部<Select defaultValue="0">{Array.from({length:8},(_,i)=><option key={i} value={i}>选项 {i}</option>)}</Select></label></div>
 </main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;

test("custom select: keyboard, outside click, forms, disabled, dialog, placement and themes", async (t) => {
  const bundle = await build({
    stdin: { contents: fixture, loader: "tsx", resolveDir: process.cwd() },
    bundle: true,
    write: false,
    jsx: "automatic",
    format: "esm",
  });
  const css = await readFile("frontend/app.css", "utf8");
  const server = createServer((req, res) => {
    if (req.url === "/app.js")
      res.writeHead(200, { "content-type": "text/javascript" }).end(bundle.outputFiles[0].contents);
    else
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
        );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const repo = page.getByRole("combobox", { name: "仓库" }),
    level = page.getByRole("combobox", { name: "规则级别", exact: true });
  const count = () => page.getByRole("listbox").count();
  await t.test(
    "keyboard highlights without committing, skips disabled, Enter and Space choose; Escape and Tab leave",
    async () => {
      await repo.focus();
      await page.keyboard.press("ArrowDown");
      assert.equal(await count(), 1);
      assert.equal(await repo.getAttribute("aria-expanded"), "true");
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.locator(".select-option.is-active").getAttribute("data-index"), "2");
      assert.equal(await page.getByTestId("repository").textContent(), "0");
      await page.keyboard.press("Enter");
      assert.equal(await count(), 0);
      assert.equal(await page.getByTestId("repository").textContent(), "2");
      await repo.press("Space");
      assert.equal(await count(), 1);
      await repo.press("ArrowDown");
      await repo.press("Space");
      assert.equal(await page.getByTestId("repository").textContent(), "3");
      await repo.press("ArrowUp");
      await repo.press("ArrowUp");
      await repo.press("Escape");
      assert.equal(await page.getByTestId("repository").textContent(), "3");
      assert.equal(await count(), 0);
      await repo.press("Enter");
      await repo.press("Tab");
      assert.equal(await count(), 0);
      assert.equal(await level.evaluate((el) => document.activeElement === el), true);
      await level.press("Enter");
      await level.press("Shift+Tab");
      assert.equal(await count(), 0);
      assert.equal(await repo.evaluate((el) => document.activeElement === el), true);
    },
  );
  await t.test("outside click and pointer selection; disabled options cannot commit", async () => {
    await repo.click();
    await page.getByRole("option", { name: "不可用的仓库", exact: true }).click({ force: true });
    assert.equal(await page.getByTestId("repository").textContent(), "3");
    assert.equal(await count(), 1);
    await page.getByRole("heading").click();
    assert.equal(await count(), 0);
    await repo.click();
    await page.getByRole("option", { name: "acme/order-api", exact: true }).click();
    assert.equal(await page.getByTestId("repository").textContent(), "0");
  });
  await t.test("name submits new value, disabled fields omitted, reset restores default", async () => {
    await level.click();
    await page.getByRole("option", { name: "必须", exact: true }).click();
    await page.getByRole("button", { name: "提交", exact: true }).click();
    assert.equal(await page.locator("#submitted").textContent(), '[["level","must"]]');
    assert.equal(await page.getByRole("combobox", { name: "禁用的选择", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("combobox", { name: "随表单禁用", exact: true }).isDisabled(), true);
    const unavailable = page.getByRole("combobox", { name: "已失效的关联", exact: true });
    await unavailable.press("Enter");
    await unavailable.press("ArrowDown");
    assert.equal(await unavailable.getAttribute("aria-activedescendant"), null);
    await unavailable.press("Escape");
    await page.getByRole("button", { name: "重置", exact: true }).click();
    assert.equal((await level.innerText()).trim(), "建议");
  });
  await t.test("listbox works inside a modal; first Escape only closes dropdown", async () => {
    await page.getByRole("button", { name: "打开弹窗", exact: true }).click();
    const select = page.getByRole("combobox", { name: "弹窗级别", exact: true });
    await select.press("Enter");
    await select.press("Escape");
    assert.equal(await count(), 0);
    assert.equal(await page.locator("dialog").evaluate((el) => el.open), true);
    await select.click();
    await page.getByRole("option", { name: "建议", exact: true }).click();
    assert.equal((await select.innerText()).trim(), "建议");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
  });
  await mkdir("work/ui-review/slop-after", { recursive: true });
  await t.test("long labels, 68 options scrolling, upward placement and screenshots in both themes", async () => {
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      await repo.click();
      await repo.press("Home");
      await repo.press("ArrowDown");
      const popup = page.getByRole("listbox");
      assert.equal(await page.getByRole("option").count(), 68);
      assert.equal(await popup.evaluate((el) => el.scrollHeight > el.clientHeight), true);
      assert.equal(
        await page.locator(".select-option.is-active").getAttribute("title"),
        await page.locator(".select-option.is-active").textContent(),
      );
      await page.screenshot({ path: `work/ui-review/slop-after/select-long-${theme}.png` });
      await repo.press("End");
      assert((await popup.evaluate((el) => el.scrollTop)) > 0);
      await page.screenshot({ path: `work/ui-review/slop-after/select-many-${theme}.png` });
      await repo.press("ArrowUp");
      await page.screenshot({ path: `work/ui-review/slop-after/select-keyboard-${theme}.png` });
      await repo.press("Escape");
      const bottom = page.getByRole("combobox", { name: "窗口底部", exact: true });
      await bottom.click();
      assert.equal(await popup.getAttribute("data-side"), "top");
      const menuRect = await popup.boundingBox(),
        buttonRect = await bottom.boundingBox();
      assert(menuRect.y >= 0 && menuRect.y + menuRect.height <= buttonRect.y);
      await page.screenshot({ path: `work/ui-review/slop-after/select-upward-${theme}.png` });
      await bottom.press("Escape");
      await page.screenshot({ path: `work/ui-review/slop-after/select-disabled-${theme}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
  });
  assert.deepEqual(errors, []);
});
