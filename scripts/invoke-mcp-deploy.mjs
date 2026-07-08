#!/usr/bin/env node
/**
 * Deploy edge functions by printing MCP deploy args path for agent CallMcpTool.
 * The agent should call deploy_edge_function with JSON.parse(readFileSync(path)).
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const fn = process.argv[2];
if (!fn) {
  console.error("Usage: node invoke-mcp-deploy.mjs <webhook|sync>");
  process.exit(1);
}

const map = {
  webhook: "agent-tools/mcp-webhook-deploy.json",
  sync: "agent-tools/mcp-sync-deploy.json",
};
const root = resolve(import.meta.dirname, "..");
const path = resolve(root, map[fn]);
const args = JSON.parse(readFileSync(path, "utf8"));
console.log(JSON.stringify({ ok: true, path, name: args.name, entrypoint_path: args.entrypoint_path, fileCount: args.files.length, bytes: JSON.stringify(args).length }));
