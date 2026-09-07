const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    errors.push("console: " + message.text());
  });

  await page.goto("http://127.0.0.1:4173/?preview=1&slot=1&fast=1");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.screenshot({ path: "/tmp/reader-study-consent.png", fullPage: true });
  await page.check("#consent-check");
  await page.click("#consent-button");

  await page.selectOption("#frequency", "weekly");
  await page.fill("#native-language", "English");
  await page.fill("#spoken-languages", "Spanish");
  await page.check('input[name="vision"][value="yes"]');
  await page.click('#eligibility-form button[type="submit"]');
  if (await page.locator("#color-form, .plate-card").count()) throw new Error("Color-vision plate must not appear in Study 3");
  await page.screenshot({ path: "/tmp/reader-study-instructions.png", fullPage: true });

  await page.check('input[name="duration"][value="one_second"]');
  await page.check('input[name="judgment"][value="first_impression"]');
  await page.click('#comprehension-form button[type="submit"]');

  await page.click("#start-practice");
  for (let practice = 0; practice < 2; practice += 1) {
    await page.waitForSelector('.rating-option[data-value="0"]', { timeout: 20000 });
    await page.click('.rating-option[data-value="0"]');
    await page.click("#submit-rating");
  }
  await page.click("#begin-main");

  let safety = 0;
  let attentionIndex = 0;
  while (safety < 180) {
    safety += 1;
    if (await page.locator("#post-form").count()) break;
    if (await page.locator("#submit-attention").count()) {
      const expected = ["1", "3", "1"][attentionIndex];
      await page.click('.rating-option[data-value="' + expected + '"]');
      await page.click("#submit-attention");
      attentionIndex += 1;
      continue;
    }
    if (await page.locator("#continue-after-break").count()) {
      await page.click("#continue-after-break");
      continue;
    }
    if (await page.locator("#repeat-trial").count()) {
      await page.click("#repeat-trial");
      continue;
    }
    await page.waitForSelector('.rating-option[data-value="0"]', { timeout: 20000 });
    if (safety === 2) await page.screenshot({ path: "/tmp/reader-study-rating.png", fullPage: true });
    await page.click('.rating-option[data-value="0"]');
    await page.click("#submit-rating");
  }

  if (!(await page.locator("#post-form").count())) throw new Error("Did not reach final questionnaire");
  await page.check('input[name="technical"][value="no"]');
  await page.click('#post-form button[type="submit"]');
  await page.click("#final-submit");
  await page.waitForSelector("#reset-preview", { timeout: 10000 });

  const stored = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((value) => value.startsWith("te-reader-study:"));
    return JSON.parse(localStorage.getItem(key));
  });
  if (stored.trialCursor !== 114) throw new Error("Expected 114 trials, found " + stored.trialCursor);
  if ("responses" in stored) throw new Error("Completed response logs must not persist in participant storage");
  if ("colorTest" in stored) throw new Error("Study 3 state must not contain the removed color-vision stage");
  if (stored.attentionChecks.length !== 3) throw new Error("Expected three attention checks");
  if (stored.breaks.filter((item) => item.completedAt).length !== 2) throw new Error("Expected two completed breaks");
  if (errors.length) throw new Error(errors.join("\n"));

  console.log(JSON.stringify({
    status: stored.status,
    completedTrials: stored.trialCursor,
    locallyStoredResponseRecords: 0,
    attentionChecks: stored.attentionChecks.length,
    screenshots: [
      path.resolve("/tmp/reader-study-consent.png"),
      path.resolve("/tmp/reader-study-instructions.png"),
      path.resolve("/tmp/reader-study-rating.png")
    ]
  }, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
