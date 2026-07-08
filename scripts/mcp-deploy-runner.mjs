#!/usr/bin/env node
/**
 * Deploy edge function via Supabase MCP HTTP transport.
 * Usage: node scripts/mcp-deploy-runner.mjs <args.json>
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { Client } from "npm:@modelcontextprotocol/sdk@1.12.1/client/index.js";
import { StreamableHTTPClientTransport } from "npm:@modelcontextprotocol/sdk@1.12.1/client/streamableHttp.js";

const argsPath = resolve(process.argv[2] || "");
if (!argsPath) {
  console.error("Usage: node mcp-deploy-runner.mjs <args.json>");
  process.exit(1);
}

const deployArgs = JSON.parse(readFileSync(argsPath, "utf8"));
const outPath = argsPath.replace(/\.json$/, ".out.json");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let projectRef = "xbmpndatdanjewhwxzxr";
try {
  const mcpJson = JSON.parse(readFileSync(resolve(root, ".cursor/mcp.json"), "utf8"));
  const url = mcpJson?.mcpServers?.supabase?.url || "";
  const m = url.match(/project_ref=([^&]+)/);
  if (m?.[1]) projectRef = m[1];
} catch {
  // default project ref
}

const transport = new StreamableHTTPClientTransport(
  new URL(`https://mcp.supabase.com/mcp?project_ref=${projectRef}`),
);

const client = new Client({ name: "uddash-deploy-runner", version: "1.0.0" });

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: "deploy_edge_function",
    arguments: deployArgs,
  });
  const payload = {
    ok: !result.isError,
    name: deployArgs.name,
    result,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload));
  process.exit(result.isError ? 1 : 0);
} catch (err) {
  const payload = {
    ok: false,
    name: deployArgs.name,
    error: err instanceof Error ? err.message : String(err),
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.error(JSON.stringify(payload));
  process.exit(1);
} finally {
  await client.close().catch(() => {});
}
