import fs from "node:fs";
import path from "node:path";
import { validateDir } from "./installer.ts";

const packagesRoot = path.resolve(process.cwd(), "packages");
const entries = fs
  .readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name));

let failed = false;
for (const entry of entries) {
  const result = validateDir(path.join(packagesRoot, entry.name));
  if (result.ok) {
    console.log(`${entry.name}: 판정 통과`);
    continue;
  }
  failed = true;
  console.error(`${entry.name}: 판정 실패`);
  for (const issue of result.issues) console.error(`  - ${issue}`);
}

process.exitCode = failed ? 1 : 0;
