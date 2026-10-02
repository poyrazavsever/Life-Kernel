import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { stdioServer } from "./paths.js";
import type { Sandbox, ToolCall } from "./types.js";

export interface Connection {
  /** The text a tool returned and whether it was an error. Every call is recorded in the sandbox's transcript. */
  call(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  instructions: string;
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  close(): Promise<void>;
}

const transcriptPath = (sandbox: Pick<Sandbox, "dir">) => join(sandbox.dir, "transcript.jsonl");

/** Start the stdio server for a sandbox, the way a desktop MCP client would. */
export async function connect(sandbox: Pick<Sandbox, "dir" | "configPath">, options: { record?: boolean } = {}): Promise<Connection> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [stdioServer],
    env: { ...process.env as Record<string, string>, LIFEKERNEL_CONFIG: sandbox.configPath },
    stderr: "ignore"
  });
  const client = new Client({ name: "lifekernel-evals", version: "0.0.0" });
  await client.connect(transport);
  const listed = await client.listTools();
  return {
    instructions: client.getInstructions() ?? "",
    tools: listed.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema })),
    async call(tool, args) {
      const result = await client.callTool({ name: tool, arguments: args });
      const text = (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
      const isError = Boolean(result.isError);
      if (options.record !== false) {
        const entry: ToolCall = { at: new Date().toISOString(), tool, args, isError, result: text.slice(0, 4000) };
        await appendFile(transcriptPath(sandbox), `${JSON.stringify(entry)}\n`, "utf8");
      }
      return { text, isError };
    },
    close: () => client.close()
  };
}

export async function readTranscript(sandbox: Pick<Sandbox, "dir">): Promise<ToolCall[]> {
  try {
    return (await readFile(transcriptPath(sandbox), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as ToolCall);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
