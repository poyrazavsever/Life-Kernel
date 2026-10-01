import { toolCli } from "./paths.js";
import type { Connection } from "./client.js";
import type { Sandbox, Scenario } from "./types.js";

/**
 * The prompt for a model under test. It carries what an MCP client would give the model: the server's
 * instructions and the tool definitions. The only way to act is the tool command; a model that edits files
 * directly is caught by the grader, because those changes have no matching audit event.
 */
export function buildPrompt(scenario: Scenario, sandbox: Sandbox, connection: Pick<Connection, "instructions" | "tools">): string {
  const messages = scenario.messages(sandbox.today).map((message, index) => `[${index + 1}] ${message}`).join("\n\n");
  const tools = connection.tools.map((tool) => `- ${tool.name}: ${tool.description}\n  input schema: ${JSON.stringify(tool.inputSchema)}`).join("\n");
  const command = `node "${toolCli}" "${sandbox.dir}" <tool_name> - <<'JSON'\n{ ...the tool's arguments as JSON... }\nJSON`;
  return `You are an AI assistant chatting with a user. You are connected to the user's Life Kernel server, a planning vault made of Markdown notes. For this task you may use ONLY the Life Kernel tools below. Do not read, list, create, or edit files yourself and do not run any other program: the vault is reachable only through the tools. Other tools you have, such as a file editor, are out of scope.

## How to call a tool

Run this in the shell (one call per command; the reply is printed back):

${command}

A reply that starts with "ERROR:" means the call failed. Read the message and fix your request.

## Instructions the server gave your client at startup

${connection.instructions}

## Tools

${tools}

## Context

Today's date is ${sandbox.today} and the user's time zone is Europe/Istanbul.

## The conversation so far (the user's messages, in order)

${messages}

## How to finish

You cannot wait for a reply. Do what the user asked, following the server's instructions and the skills it points you to. If you need something the user has not given, or their approval for something that needs it, stop and ask in your final message instead of guessing. Your final message is what the user sees: write it as a chat reply.`;
}
