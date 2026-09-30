import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as baseExpect } from "@playwright/test";
import { syntheticLearningPdf } from "./fixtures/learning-pdf.mjs";

const expect = baseExpect.configure({ timeout: 30000 });
export async function validateLearningPdfBrowser({ browser, base, run, inviteCode, bertologyPath }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, serviceWorkers: "block" });
  context.setDefaultTimeout(45000); context.setDefaultNavigationTimeout(90000);
  const checks = [], external = [], unexpected = [], errors = [];
  const pass = (label) => { checks.push(label); console.log(`[learning-pdf] ${checks.length}/${bertologyPath ? 13 : 12} ${label}`); };
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { external.push(url.origin); return route.abort(); }
    if (url.pathname.startsWith("/api/") && !/^\/api\/(auth\/|learning\/)/u.test(url.pathname)) { unexpected.push(url.pathname); return route.abort(); }
    return route.continue();
  });
  context.on("page", (tab) => tab.on("pageerror", (error) => errors.push(error.message)));
  const page = await context.newPage();
  const bytes = syntheticLearningPdf({ javascript: true });
  await writeFile(path.join(run, "SYNTHETIC-original.pdf"), bytes);
  const account = `pdf-${randomUUID()}@synthetic.invalid`, password = "synthetic-pdf-password-001";
  const pdfFile = (name, buffer = bytes) => ({ name, mimeType: "application/pdf", buffer });
  const assertRendered = async (tab, number) => {
    await expect(tab.getByRole("status").filter({ hasText: `原页可查看 · 第 ${number} /` })).toBeVisible();
    const canvas = tab.getByRole("img", { name: /PDF 原页/ });
    await expect(canvas).toHaveAttribute("data-ready", "true"); await expect(canvas).toHaveAttribute("data-physical-page", String(number));
    await expect.poll(() => canvas.evaluate((node) => {
      if (!node.width || !node.height || node.dataset.ready !== "true") return false;
      const pixels = node.getContext("2d").getImageData(0, 0, node.width, node.height).data;
      let ink = 0; for (let i = 0; i < pixels.length; i += 16) if (pixels[i] < 200 && pixels[i + 3] > 0) ink++;
      return ink > 200;
    }), { message: "a real nonblank page must be rendered" }).toBe(true);
  };
  try {
    assert.equal((await context.request.post(`${base}/api/auth/register`, { data: { email: account, password, name: "合成 PDF 账号", inviteCode } })).status(), 201);
    await page.goto(base);
    for (const [name, href] of [["约会陪伴", "/date-companion/a"], ["日常复盘", "/reflection"], ["工作复盘", "/work-review"], ["学习整理", "/learning"]]) await expect(page.getByRole("link", { name: new RegExp(name) })).toHaveAttribute("href", href);
    await page.getByRole("link", { name: /学习整理/ }).click();
    await page.getByLabel("学习页名称").fill("[合成 PDF 验收] 课件与笔记");
    await page.getByRole("button", { name: "创建学习页", exact: true }).click();
    await expect(page.getByRole("heading", { name: "[合成 PDF 验收] 课件与笔记" })).toBeVisible();
    const pageId = new URL(page.url()).pathname.split("/").at(-1), pageUrl = `${base}/learning/${pageId}`;
    const api = `${base}/api/learning/pages/${pageId}`;
    pass("four authenticated entrances and existing learning page creation");

    for (const [name, buffer, message] of [["合成损坏.pdf", Buffer.from("%PDF-1.7\nBROKEN\n%%EOF\n"), "损坏"], ["合成加密.pdf", syntheticLearningPdf({ password: "synthetic-only" }), "加密"]]) {
      await page.getByLabel("添加 PDF", { exact: true }).setInputFiles(pdfFile(name, buffer));
      await page.getByRole("button", { name: "只保存本批 1 份" }).click();
      await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
      assert.equal((await (await context.request.get(api)).json()).page.materialCount, 0);
      await page.getByRole("button", { name: `移除待保存材料 ${name.replace(/\.pdf$/u, "")}` }).click();
    }
    pass("damaged and encrypted PDFs fail truthfully; batch remains editable");

    await page.getByLabel("文本标题", { exact: true }).fill("合成配套笔记");
    await page.getByLabel("粘贴文本", { exact: true }).fill("[合成] 第一段：PDF 原页保留。\n\n第二段：这些不是 OCR 或模型结果。");
    await page.getByRole("button", { name: "加入本批材料" }).click();
    await page.getByLabel("添加 PDF", { exact: true }).setInputFiles([pdfFile("合成原页A.pdf"), pdfFile("合成图片页B.pdf", syntheticLearningPdf())]);
    await expect(page.getByRole("heading", { name: "本批待保存 · 3 份" })).toBeVisible();
    await page.getByRole("button", { name: "只保存本批 3 份" }).click();
    await expect(page.getByRole("status").filter({ hasText: "已保存：3/3" })).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(3);
    const detail = (await (await context.request.get(api)).json()).page;
    const a = detail.materials.find((m) => m.filename === "合成原页A.pdf"), b = detail.materials.find((m) => m.filename === "合成图片页B.pdf");
    const originalUrl = `${api}/materials/${a.id}/pdf`;
    const original = await context.request.get(originalUrl);
    assert.deepEqual(await original.body(), bytes);
    assert.equal(original.headers()["x-content-sha256"], createHash("sha256").update(bytes).digest("hex"));
    assert.equal(a.pdf.parsing, "not_parsed"); assert.equal(a.pdf.pageCount, 3);
    assert.equal((await context.request.get(`${api}/materials/${a.id}`)).status(), 409);
    pass("mixed text and multiple PDFs preserve original hashes, names, pages and unparsed state");

    await page.getByRole("checkbox", { name: /合成原页A/ }).check(); await page.getByRole("checkbox", { name: /合成配套笔记/ }).check();
    await page.getByRole("button", { name: "保存本次范围" }).click(); await expect(page.getByText("本次材料范围已保存。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "查看原页 合成原页A", exact: true }).click(); await assertRendered(page, 1);
    const annotationPixels = await page.getByRole("img", { name: /PDF 原页/ }).evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 220 && pixels[i + 1] < 40 && pixels[i + 2] < 40 && pixels[i + 3] > 0) red++;
      return red;
    });
    assert.ok(annotationPixels > 500, "static annotation appearance must remain on the original page");
    await page.screenshot({ path: path.join(run, "pdf-page-1.png"), fullPage: true });
    assert.equal(await page.evaluate(() => globalThis.SYNTHETIC_PDF_SCRIPT_EXECUTED), undefined);
    await page.getByRole("button", { name: "下一页", exact: true }).click(); await assertRendered(page, 2);
    assert.equal(await page.getByRole("img", { name: /PDF 原页/ }).evaluate((canvas) => canvas.width > canvas.height), true);
    const normalWidth = await page.getByRole("img", { name: /PDF 原页/ }).evaluate((canvas) => parseFloat(canvas.style.width));
    await page.getByLabel("缩放", { exact: true }).selectOption("2"); await assertRendered(page, 2);
    await expect.poll(() => page.getByRole("img", { name: /PDF 原页/ }).evaluate((canvas) => parseFloat(canvas.style.width))).toBeGreaterThan(normalWidth * 1.5);
    pass("actual page canvas, static annotation, rotation/crop, navigation and zoom; PDF scripts stay inert");

    await page.getByLabel("物理页", { exact: true }).fill("3"); await page.getByRole("button", { name: "跳转原页" }).click(); await assertRendered(page, 3);
    assert.match(page.url(), /pdfPage=3/u);
    await page.getByLabel("缩放", { exact: true }).selectOption("1");
    await assertRendered(page, 3);
    await page.screenshot({ path: path.join(run, "pdf-scan-style-page-3.png"), fullPage: true });
    await page.reload(); await assertRendered(page, 3);
    await expect(page.getByRole("checkbox", { name: /合成原页A/ })).toBeChecked();
    await expect(page.getByLabel("材料原文")).toContainText("尚未解析");
    pass("image-only original page displays; physical-page link and scope survive refresh");

    await page.getByRole("button", { name: "关闭原文", exact: true }).click();
    await page.getByRole("button", { name: "查看原文 合成配套笔记", exact: true }).click();
    await page.getByLabel("定位段落", { exact: true }).fill("2"); await page.getByRole("button", { name: "定位", exact: true }).click();
    await page.reload(); await expect(page.locator("#learning-paragraph-2")).toHaveAttribute("data-current", "true");
    await page.getByLabel("导入 UTF-8 TXT", { exact: true }).setInputFiles({ name: "合成追加.txt", mimeType: "text/plain", buffer: Buffer.from("[合成] TXT 追加仍然可用。") });
    await page.getByRole("button", { name: "只保存本批 1 份" }).click(); await expect(page.getByRole("checkbox")).toHaveCount(4);
    pass("old text paragraphs and UTF-8 TXT append remain intact");

    await page.getByRole("button", { name: /账号菜单/ }).click(); await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page).toHaveURL(/\/date-companion$/u); assert.equal((await context.request.get(originalUrl)).status(), 401);
    assert.equal((await context.request.post(`${base}/api/auth/login`, { data: { email: account, password } })).status(), 200);
    await page.goto(`${base}/learning`); await page.getByRole("link", { name: /\[合成 PDF 验收\]/ }).click();
    await expect(page.getByRole("checkbox")).toHaveCount(4); await page.goto(`${pageUrl}?material=${a.id}&pdfPage=2`); await assertRendered(page, 2);
    pass("logout denies original access; relogin reopens saved PDFs and physical-page links");

    await page.getByLabel("添加 PDF", { exact: true }).setInputFiles(pdfFile("合成原页A.pdf", syntheticLearningPdf({ pages: 1 })));
    let loseOnce = true;
    await page.route("**/api/learning/pages/*/materials", async (route) => {
      if (loseOnce && route.request().method() === "POST") {
        loseOnce = false; const committed = await route.fetch(); assert.equal(committed.status(), 200);
        await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"learning_storage_unavailable"}' });
      } else await route.continue();
    });
    await page.getByRole("button", { name: "只保存本批 1 份" }).click();
    await expect(page.getByRole("button", { name: "重试保存本批" })).toBeEnabled();
    await page.getByRole("button", { name: "重试保存本批" }).click(); await expect(page.getByRole("checkbox")).toHaveCount(5);
    await page.unroute("**/api/learning/pages/*/materials"); await page.reload();
    const afterRetry = (await (await context.request.get(api)).json()).page;
    assert.equal(afterRetry.materialCount, 5); assert.equal(afterRetry.materials.filter((m) => m.filename === "合成原页A.pdf").length, 2);
    assert.deepEqual(await (await context.request.get(originalUrl)).body(), bytes);
    pass("single PDF append and lost-success response retry create once; same names never overwrite");

    const stranger = await browser.newContext();
    assert.equal((await stranger.request.post(`${base}/api/auth/register`, { data: { email: `stranger-${randomUUID()}@synthetic.invalid`, password, inviteCode } })).status(), 201);
    for (const method of ["get", "head"]) assert.equal((await stranger.request[method](originalUrl, { headers: { range: "bytes=0-15" } })).status(), 404);
    assert.equal((await stranger.request.get(`${api}/materials/${a.id}`)).status(), 404); await stranger.close();
    const range = await context.request.get(originalUrl, { headers: { range: "bytes=0-15" } }); assert.equal(range.status(), 206); assert.deepEqual(await range.body(), bytes.subarray(0, 16));
    assert.equal((await context.request.head(originalUrl)).status(), 200);
    const uploads = await context.request.get(`${base}/api/uploads/by-date?date=2026-09-18`); assert.deepEqual((await uploads.json()).uploadIds, []);
    assert.equal((await context.request.get(`${base}/api/days/${a.id}`)).status(), 404);
    pass("original, metadata, HEAD and Range isolation; no generic upload/product visibility");

    await page.goto(`${pageUrl}?material=${b.id}&pdfPage=3`); await assertRendered(page, 3);
    await page.setViewportSize({ width: 390, height: 844 }); await assertRendered(page, 3);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(run, "pdf-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1050 });
    const observer = await context.newPage(); await observer.goto(`${pageUrl}?material=${a.id}&pdfPage=1`); await assertRendered(observer, 1);
    const firstDelete = page.getByRole("button", { name: "删除材料 合成原页A", exact: true }).first();
    await firstDelete.click(); await expect(page.getByRole("dialog")).toContainText("已有成果中可能仍包含材料摘录");
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(observer.getByRole("alert").filter({ hasText: "来源已删除" })).toBeVisible(); await expect(observer.getByRole("img", { name: /PDF 原页/ })).not.toBeVisible();
    assert.equal((await context.request.get(originalUrl, { headers: { range: "bytes=0-15" } })).status(), 410);
    await observer.reload(); await expect(observer.getByLabel("材料原文")).toContainText("来源已删除");
    pass("mobile preview stays contained; deletion invalidates another tab and old page links");

    await observer.goto(`${pageUrl}?material=${b.id}&pdfPage=3`); await assertRendered(observer, 3);
    await page.getByRole("button", { name: "删除学习页", exact: true }).click(); await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page).toHaveURL(`${base}/learning`); await expect(observer.getByRole("alert").filter({ hasText: "来源已删除" })).toBeVisible();
    await page.reload(); await expect(page.getByText("还没有学习页", { exact: true })).toBeVisible();
    assert.equal((await context.request.head(`${api}/materials/${b.id}/pdf`)).status(), 410);
    assert.equal((await context.request.post(`${base}/api/learning/pages`, { data: { id: pageId, title: "[合成 PDF 验收] 课件与笔记" } })).status(), 410);
    pass("whole-page deletion persists after refresh and rejects late page creation");

    if (bertologyPath) {
      const realBytes = await readFile(bertologyPath);
      assert.equal(createHash("sha256").update(realBytes).digest("hex"), "ba1255964007358db90742cf4051324ffadee69775a2dee86d3471be0e520ac1");
      const realPage = randomUUID();
      assert.equal((await context.request.post(`${base}/api/learning/pages`, { data: { id: realPage, title: "[离线公开原件] BERTology" } })).status(), 200);
      await page.goto(`${base}/learning/${realPage}`);
      await page.getByLabel("添加 PDF", { exact: true }).setInputFiles(pdfFile("BERTology-original.pdf", realBytes));
      await page.getByRole("button", { name: "只保存本批 1 份" }).click(); await expect(page.getByRole("checkbox")).toHaveCount(1);
      const real = (await (await context.request.get(`${base}/api/learning/pages/${realPage}`)).json()).page.materials[0];
      assert.equal(real.pdf.pageCount, 25); assert.equal(real.pdf.compatibilityWarnings.length, 2);
      assert.deepEqual(await (await context.request.get(`${base}/api/learning/pages/${realPage}/materials/${real.id}/pdf`)).body(), realBytes);
      await page.getByRole("button", { name: "查看原页 BERTology-original", exact: true }).click(); await assertRendered(page, 1);
      for (const physicalPage of [2, 3]) {
        await page.getByLabel("物理页", { exact: true }).fill(String(physicalPage)); await page.getByRole("button", { name: "跳转原页" }).click(); await assertRendered(page, physicalPage);
        await page.screenshot({ path: path.join(run, `bertology-original-page-${physicalPage}.png`), fullPage: true });
      }
      await page.reload(); await assertRendered(page, 3);
      assert.equal((await context.request.delete(`${base}/api/learning/pages/${realPage}`)).status(), 200);
      pass("delivered BERTology hash verified, normal upload 25 pages, original pages 1/2/3 rendered, refresh and deletion; no OCR/semantic/pixel-equality claim");
    }
    assert.deepEqual(external, []); assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    pass("no OCR, ASR, learning-model or external requests, no browser errors");
    await writeFile(path.join(run, "pdf-result.json"), JSON.stringify({ status: "PASS", checks, external, unexpected, errors, evidence: "synthetic PDFs, real local auth/API/SQLite/canvas; one intentionally lost successful save response", bertologyOriginal: bertologyPath ? "local normal upload and rendering PASS" : "NOT RUN" }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(run, "pdf-failure.png"), fullPage: true }).catch(() => {});
    await writeFile(path.join(run, "pdf-result.json"), JSON.stringify({ status: "FAIL", checks, external, unexpected, errors, error: String(error) }, null, 2));
    throw error;
  } finally { await context.close(); }
}
