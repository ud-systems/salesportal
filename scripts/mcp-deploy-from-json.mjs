#!/usr/bin/env node
/**
 * Reads deploy args JSON (from collect-edge-files.mjs) and prints MCP-ready payload metadata.
 * Actual deploy is done via CallMcpTool deploy_edge_function in the agent.
 */
import { readFileSync } from "fs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node mcp-deploy-from-json.mjs <args.json>");
  process.exit(1);
}

const args = JSON.parse(readFileSync(path, "utf8"));
if (!args.entrypoint_path?.includes("/")) {
  const fn = args.name;
  args.entrypoint_path = `${fn}/index.ts`;
}

console.log(JSON.stringify(args));
