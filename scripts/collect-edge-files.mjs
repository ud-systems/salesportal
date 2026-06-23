import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, resolve, relative } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fnRoot = resolve(root, "supabase/functions");

function collect(entry) {
  const abs = resolve(fnRoot, entry);
  const dir = dirname(abs);
  const text = readFileSync(abs, "utf8");
  const name = relative(fnRoot, abs).replace(/\\/g, "/");
  const files = [{ name, content: text }];
  const seen = new Set([abs]);
  const re = /from ["'](\.\.?\/[^"']+)["']/g;
  let m;
  while ((m = re.exec(text))) {
    const dep = resolve(dir, m[1]);
    if (!dep.endsWith(".ts") || seen.has(dep)) continue;
    seen.add(dep);
    for (const f of collect(relative(fnRoot, dep))) {
      if (!files.some((x) => x.name === f.name)) files.push(f);
    }
  }
  return files;
}

const outDir = resolve(root, "agent-tools");
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "deploy-webhook.json"), JSON.stringify(collect("shopify-webhook/index.ts")));
writeFileSync(resolve(outDir, "deploy-sync.json"), JSON.stringify(collect("shopify-sync/index.ts")));
console.log("done");
