import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LifeKernel, loadConfig, loadEnvBeside } from "@lifekernel/core";
import { createLifeKernelMcp } from "./server.js";

const configPath = process.env.LIFEKERNEL_CONFIG ?? "./lifekernel.config.json";
await loadEnvBeside(configPath);
const kernel = new LifeKernel(await loadConfig(configPath));
const server = createLifeKernelMcp(kernel);
await server.connect(new StdioServerTransport());
