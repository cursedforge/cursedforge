const path = require("path");
const fs = require("fs");

const { Cluster } = require("puppeteer-cluster");
const puppeteer = require("puppeteer-extra");
const cheerio = require("cheerio");
const jszip = require("jszip");
const yargs = require("yargs");

const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const AdblockerPlugin = require("puppeteer-extra-plugin-adblocker");

puppeteer.use(AdblockerPlugin({ blockTrackers: true }));
puppeteer.use(StealthPlugin());

const argv = yargs(process.argv).argv;

const downloadPath = path.resolve(argv?.output || "./downloads");
if (!fs.existsSync(downloadPath)) {
  fs.mkdirSync(downloadPath);
}
const concurrency = argv?.concurrency || 5;
const inputPath = argv._[2];
if (!inputPath) {
  console.error("no input modpack provided");
  process.exit(1);
}
const inputArchive = path.resolve(inputPath);

const main = async () => {
  console.log(`modpack path set to ${inputArchive}`);
  console.log(`download destination set to ${downloadPath}`);
  console.log(`concurrency set to ${concurrency}`);

  const archiveContent = await fs.promises.readFile(inputArchive);
  const unzippedContent = await jszip.loadAsync(archiveContent);
  const modlist = unzippedContent.files["modlist.html"];
  const $ = cheerio.load(await modlist.async("string"));
  const modUrls = $("a")
    .map((_, el) => {
      return $(el).attr("href");
    })
    .get();
  const manifest = unzippedContent.files["manifest.json"];
  const manifestMods = JSON.parse(await manifest.async("string")).files;
  const mappedMods = [];

  const cluster = await Cluster.launch({
    puppeteer,
    maxConcurrency: concurrency,
    concurrency: Cluster.CONCURRENCY_BROWSER,
    puppeteerOptions: {
      headless: "new",
    },
  });

  const getIdFromUrl = async ({ page, data }) => {
    await page.setViewport({ width: 800, height: 600 });
    await page.goto(data.url, { waitUntil: "domcontentloaded" });
    const $ = cheerio.load(await page.content());
    const projectId = $(
      ".aside-box.project-details-box > section > dl > dd:nth-child(6)"
    )
      .first()
      .text();
    const match = manifestMods.find((mod) => `${mod.projectID}` === projectId);
    mappedMods.push({
      ...match,
      link: data.url,
      downloadLink: `${data.url}/download/${match.fileID}`,
    });
  };

  for (const modUrl of modUrls) {
    cluster.queue({ url: modUrl }, getIdFromUrl);
  }

  await cluster.idle();
  console.log(`mapped ${mappedMods.length} mods`);

  const downloadFile = async ({ page, data }) => {
    await page.setViewport({ width: 800, height: 600 });
    await (
      await page.target().createCDPSession()
    ).send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath,
    });
    await page.goto(data.url);
    await page.waitForTimeout(7777);

    await page.goto("chrome://downloads");
    await page.waitForFunction(
      () => {
        const downloadsManager =
          document.querySelector("downloads-manager").shadowRoot;
        const downloadsItem = downloadsManager.querySelector("#frb0");
        if (downloadsItem) {
          const controls = downloadsItem.shadowRoot.querySelector(".controls");
          const maybeFolder = controls.querySelector("a");
          if (maybeFolder && maybeFolder.textContent === "Show in folder") {
            return true;
          }
          const maybeRetry = controls.querySelector("cr-button");
          if (maybeRetry && maybeRetry.textContent === "Retry") {
            maybeRetry.click();
          }
        }
      },
      { polling: "raf", timeout: 0 }
    );
    await page.waitForTimeout(1000);
  };

  for (const mod of mappedMods) {
    cluster.queue({ url: mod.downloadLink }, downloadFile);
  }

  await cluster.idle();
  await cluster.close();

  const files = await fs.promises.readdir(downloadPath);
  console.log(`downloaded ${files.length} mods`);
};

main().catch(console.warn);
