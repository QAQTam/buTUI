import type { CapabilityBroker } from "./capability.ts";
import type { PluginCapability } from "./types.ts";
import { serveWorkerRpc } from "./worker-rpc.ts";
import type {
  WorkerRpcEndpoint,
  WorkerRpcHandlers,
} from "./worker-rpc.ts";

export type WorkerCapabilityHandler = (
  ...args: any[]
) => unknown | Promise<unknown>;

export interface WorkerCapabilityBinding {
  capability: PluginCapability;
  handler: WorkerCapabilityHandler;
}

export type WorkerCapabilityBindings = Record<
  string,
  WorkerCapabilityBinding
>;

export interface WorkerCapabilityDeniedEvent {
  pluginId: string;
  method: string;
  capability: PluginCapability;
  args: readonly unknown[];
}

export interface WorkerCapabilityProxyOptions {
  pluginId: string;
  broker: Pick<CapabilityBroker, "has">;
  bindings: WorkerCapabilityBindings;
  onDenied?: (event: WorkerCapabilityDeniedEvent) => void;
}

/**
 * 在 host 侧把显式绑定暴露给 Worker。
 *
 * 每次调用都实时检查 `CapabilityBroker`，因此 revoke / TTL 过期会立即生效。
 * proxy 只做 capability 授权，不替代 handler 自己的参数、路径和资源校验。
 */
export function serveWorkerCapabilities(
  target: WorkerRpcEndpoint,
  options: WorkerCapabilityProxyOptions
): () => void {
  const handlers = Object.create(null) as WorkerRpcHandlers;

  for (const [method, binding] of Object.entries(options.bindings)) {
    if (typeof binding?.handler !== "function") {
      throw new Error(
        `[butui] worker capability handler must be a function: ${method}`
      );
    }
    handlers[method] = async (...args: unknown[]) => {
      if (!options.broker.has(options.pluginId, binding.capability)) {
        options.onDenied?.({
          pluginId: options.pluginId,
          method,
          capability: binding.capability,
          args,
        });
        throw new Error(
          `[butui] worker capability denied: ${options.pluginId}/${method} (${binding.capability})`
        );
      }
      return binding.handler(...args);
    };
  }

  return serveWorkerRpc(handlers, target);
}
