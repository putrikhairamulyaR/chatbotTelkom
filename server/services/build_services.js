// server/services/build_services.js
import fs from "fs";
import path from "path";
import pdf from "pdf-parse";

const inputPdf = process.argv[2];
const outputJson = process.argv[3];

if (!inputPdf || !outputJson) {
  console.error("Usage: node build_services.js <input.pdf> <output.json>");
  process.exit(1);
}

const absPdf = path.resolve(process.cwd(), inputPdf);
const absOut = path.resolve(process.cwd(), outputJson);

const buf = fs.readFileSync(absPdf);
const { text } = await pdf(buf);

const blocks = text
  .replace(/\r/g, "")
  .replace(/[ \t]+/g, " ")
  .split(/\n(?=\d+\.\s)/g)
  .map(x => x.replace(/\n/g, " ").trim())
  .filter(Boolean);

const services = [];

for (const b of blocks) {
  const m = b.match(/^(\d+)\.\s*(.+?)\s+Layanan:\s*(.+?)\s+Kontak:\s*(.+)$/i);
  if (!m) continue;

  const emails = [...m[4].matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map(x => x[0]);
  const phones = [...m[4].matchAll(/(\+62|0)\d[\d\s-]{7,}/g)].map(x => x[0].replace(/\s+/g, " ").trim());
  const websites = [...m[4].matchAll(/(?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?/gi)]
    .map(x => x[0])
    .filter(w => !w.includes("@"));

  const key = m[2]
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  services.push({
    number: Number(m[1]),
    key,
    name: m[2].trim(),
    desc: m[3].trim(),
    contacts: {
      emails: [...new Set(emails)],
      phones: [...new Set(phones)],
      websites: [...new Set(websites)]
    }
  });
}

services.sort((a, b) => a.number - b.number);

fs.writeFileSync(absOut, JSON.stringify({ services }, null, 2));
console.log(`OK: ${services.length} layanan ditulis ke ${absOut}`);
