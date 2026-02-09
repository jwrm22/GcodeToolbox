/**
 * Eenmalig uitvoeren om het letterfont te downloaden en als base64 op te slaan.
 * Gebruik: node scripts/fetch-font-base64.js
 * Vereist: node en internet.
 */
const https = require("https");
const fs = require("fs");
const path = require("path");

const FONT_URL = "https://cdn.jsdelivr.net/gh/opentypejs/opentype.js@master/test/fonts/Roboto-Black.ttf";
const OUT_DIR = path.join(__dirname, "..");
const OUT_FILE = path.join(OUT_DIR, "font-base64.js");

https.get(FONT_URL, (res) => {
  if (res.statusCode !== 200) {
    console.error("Font download failed:", res.statusCode);
    process.exit(1);
  }
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.on("end", () => {
    const buf = Buffer.concat(chunks);
    const base64 = buf.toString("base64");
    const content = `// Gegenereerd door scripts/fetch-font-base64.js - Roboto-Black.ttf (opentype.js test font)
// Gebruikt voor offline lettergravering.
window.LETTER_FONT_BASE64 = "${base64}";
`;
    fs.writeFileSync(OUT_FILE, content, "utf8");
    console.log("Written", OUT_FILE, "(" + Math.round(base64.length / 1024) + " KB base64)");
  });
}).on("error", (e) => {
  console.error("Download error:", e.message);
  process.exit(1);
});
