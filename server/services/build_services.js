// build_services_index.js
import fs from "fs";
import pdf from "pdf-parse";

const input = process.argv[2];
const output = process.argv[3] || "services.index.json";

const buf = fs.readFileSync(input);
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
  const phones = [...m[4].matchAll(/(\+62|0)\d[\d\s-]{7,}/g)].map(x => x[0].replace(/\s+/g, " "));
  const key = m[2].toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "_");

  services.push({
    number: Number(m[1]),
    key,
    name: m[2].trim(),
    desc: m[3].trim(),
    contacts: {
      emails,
      phones
    }
  });
}

fs.writeFileSync(output, JSON.stringify({ services }, null, 2));
