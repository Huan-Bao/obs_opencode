import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  const suffix = Date.now().toString(36);
  const sessionID = `ses_e2e_${suffix}`;
  const imported = await request.post("/api/v1/import/trace", {
    data: {
      schema_version: 1,
      exported_at: Date.now(),
      session: {
        adapter: "opencode",
        session_id: sessionID,
        title: `E2E audit ${suffix}`,
        directory: "D:\\e2e",
        status: "idle",
        provider_id: "test",
        model_id: "model",
        created_at: Date.now() - 1000,
        updated_at: Date.now(),
        raw_json: JSON.stringify({
          id: sessionID,
          title: `E2E audit ${suffix}`,
          directory: "D:\\e2e",
          time: { created: Date.now() - 1000, updated: Date.now() },
        }),
      },
      children: [],
      messages: [
        {
          adapter: "opencode",
          session_id: sessionID,
          message_id: `msg_${suffix}`,
          role: "assistant",
          created_at: Date.now(),
          raw_json: JSON.stringify({
            id: `msg_${suffix}`,
            sessionID,
            role: "assistant",
            time: { created: Date.now() },
          }),
          parts: [
            {
              part_id: `prt_${suffix}`,
              raw_json: JSON.stringify({
                id: `prt_${suffix}`,
                sessionID,
                messageID: `msg_${suffix}`,
                type: "text",
                text: "E2E trace text",
              }),
            },
          ],
        },
      ],
      events: [
        {
          event_id: `evt_empty_diff_${suffix}`,
          adapter: "opencode",
          session_id: sessionID,
          seq: 1,
          event_type: "session.diff",
          event_time: Date.now(),
          raw_json: JSON.stringify({
            id: `evt_empty_diff_${suffix}`,
            type: "session.diff",
            properties: { sessionID, diff: [] },
          }),
        },
      ],
      tool_calls: [],
      diffs: [],
      audit: { review: {}, annotations: [] },
    },
  });
  expect(imported.ok()).toBeTruthy();
});

test("filters sessions, opens timeline, reviews, and annotates a part", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agent Trace 审计台" })).toBeVisible();
  const search = page.getByLabel("搜索会话");
  await search.fill("E2E audit");
  const card = page.locator(".session-card").first();
  await expect(card).toContainText("E2E audit");
  await card.click();

  await expect(page.locator(".trace-text")).toContainText("E2E trace text");
  await expect(page.locator(".trace-content")).not.toContainText("session.diff");
  await page.locator(".audit-strip select").nth(0).selectOption("approved");
  await page.locator(".audit-strip select").nth(1).selectOption("low");
  await page.getByPlaceholder("会话审计结论").fill("E2E approved");
  await page.getByRole("button", { name: "保存审计" }).click();
  await expect(page.locator(".audit-strip select").nth(0)).toHaveValue("approved");

  await page.locator(".trace-card").filter({ hasText: "text" }).getByRole("button", { name: "标注" }).click();
  await page.getByPlaceholder("标签，逗号分隔").fill("e2e,review");
  await page.getByPlaceholder("审计评论").fill("Part checked");
  await page.getByRole("button", { name: "保存标注" }).click();
  await expect(page.locator(".annotation")).toContainText("Part checked");

  await page.locator(".trace-card").filter({ hasText: "text" }).getByRole("button", { name: "JSON" }).click();
  await expect(page.locator(".trace-card .json-view")).toContainText("E2E trace text");

  await page.getByRole("button", { name: /原始事件/ }).click();
  await expect(page.locator(".trace-content")).toContainText("session.diff");
});
