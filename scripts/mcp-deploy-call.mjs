#!/usr/bin/env node
/**
 * Reads MCP deploy args JSON and prints tool invocation metadata.
 * Actual deploy is performed via CallMcpTool deploy_edge_function in the agent.
 */
import { readFileSync } from "fs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node mcp-deploy-call.mjs <args.json>");
  process.exit(1);
}

const args = JSON.parse(readFileSync(path, "utf8"));
if (!args.entrypoint_path?.includes("/")) {
  args.entrypoint_path = `${args.name}/index.ts`;
}

console.log(JSON.stringify(args));
