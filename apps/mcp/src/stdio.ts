import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LifeKernel, loadConfig, loadEnvBeside, parseVaultGrants } from "@lifekernel/core";
import { createLifeKernelMcp } from "./server.js";

const configPath = process.env.LIFEKERNEL_CONFIG ?? "./lifekernel.config.json";
await loadEnvBeside(configPath);
const full = new LifeKernel(await loadConfig(configPath));
// LIFEKERNEL_VAULTS (for example "startup:write,personal:read") limits what this client can see and change.
const grants = process.env.LIFEKERNEL_VAULTS ? parseVaultGrants(process.env.LIFEKERNEL_VAULTS, full.config.vaults.map((vault) => vault.id)) : null;
const server = createLifeKernelMcp(grants ? full.restrictTo(grants) : full);
await server.connect(new StdioServerTransport());
