import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LifeKernel, loadConfig, type VaultGrants } from "@lifekernel/core";
import { createLifeKernelMcp } from "./server.js";

const repo = new URL("../../../", import.meta.url);

/** Connect an MCP client to a kernel in memory and return a helper that calls a tool and parses its JSON. */
export async function connectTo(kernel: LifeKernel, name = "flow-test") {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createLifeKernelMcp(kernel).connect(serverSide);
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(clientSide);
  return async (tool: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    if (result.isError) throw new Error(text);
    return JSON.parse(text);
  };
}

/**
 * A real starter vault plus the example config's routes, served over MCP. With `work`, a second vault built
 * from the work template is mounted beside the personal one. `viewFor` serves the same state through a
 * connection limited to some vaults, the way a vault-scoped token or OAuth grant would.
 */
export async function session(options: { work?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lifekernel-flow-"));
  await cp(new URL("templates/starter-vault", repo), join(root, "personal"), { recursive: true });
  const config = JSON.parse(await readFile(new URL("lifekernel.config.example.json", repo), "utf8"));
  config.timezone = "UTC";
  config.vaults[0].path = "./personal";
  if (options.work) {
    await cp(new URL("templates/work-vault", repo), join(root, "work"), { recursive: true });
    const routes = JSON.parse(await readFile(new URL("templates/work-vault/.lifekernel/routes.json", repo), "utf8"));
    config.vaults.push({ id: "work", kind: "work", path: "./work", mode: "read-write", routes });
  }
  await writeFile(join(root, "lifekernel.config.json"), JSON.stringify(config));
  const kernel = new LifeKernel(await loadConfig(join(root, "lifekernel.config.json")));
  return {
    root,
    kernel,
    call: await connectTo(kernel),
    viewFor: (grants: VaultGrants) => connectTo(kernel.restrictTo(grants), "scoped-agent")
  };
}
