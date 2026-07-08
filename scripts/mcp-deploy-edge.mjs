#!/usr/bin/env node
/**
 * Prints deploy args JSON for MCP deploy_edge_function (stdout, no BOM).
 * Usage: node scripts/mcp-deploy-edge.mjs agent-tools/mcp-webhook-args.json
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const path = resolve(process.argv[2] || "");
if (!path) {
  console.error("Usage: node mcp-deploy-edge.mjs <args.json>");
  process.exit(1);
}

const args = JSON.parse(readFileSync(path, "utf8"));
if (!args.entrypoint_path?.includes("/")) {
  args.entrypoint_path = `${args.name}/index.ts`;
}
process.stdout.write(JSON.stringify(args));
