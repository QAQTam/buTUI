import type { AuditLog } from "./audit.ts";
import { safeRecordAudit } from "./audit.ts";
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

export interface WorkerCapabilityRequest {
  pluginId: string;
  method: string;
  capability: PluginCapability;
  args: readonly unknown[];
}

export type WorkerCapabilityAuthorization =
  | boolean
  | {
      allowed: boolean;
      reason?: string;
    };

export type WorkerCapabilityAuthorizer = (
  request: WorkerCapabilityRequest
) =>
  | WorkerCapabilityAuthorization
  | Promise<WorkerCapabilityAuthorization>;

export interface WorkerCapabilityBinding {
  capability: PluginCapability;
  handler: WorkerCapabilityHandler;
  /** 名称级 capability 通过后的调用级约束；false / throw 都 fail closed。 */
  authorize?: WorkerCapabilityAuthorizer;
}

export type WorkerCapabilityBindings = Record<
  string,
  WorkerCapabilityBinding
>;

export type WorkerCapabilityDeniedReason =
  | "missing-capability"
  | "policy"
  | "policy-error";

export interface WorkerCapabilityDeniedEvent extends WorkerCapabilityRequest {
  reason: WorkerCapabilityDeniedReason;
  detail?: string;
}

export interface WorkerCapabilityProxyOptions {
  pluginId: string;
  broker: Pick<CapabilityBroker, "has">;
  bindings: WorkerCapabilityBindings;
  onDenied?: (event: WorkerCapabilityDeniedEvent) => void;
  audit?: AuditLog;
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
      const request: WorkerCapabilityRequest = {
        pluginId: options.pluginId,
        method,
        capability: binding.capability,
        args,
      };
      if (!options.broker.has(options.pluginId, binding.capability)) {
        deny(request, options, "missing-capability");
      }
      if (binding.authorize) {
        let authorization: WorkerCapabilityAuthorization;
        try {
          authorization = await binding.authorize(request);
        } catch (error) {
          deny(request, options, "policy-error", asError(error).message);
        }
        if (!isAuthorized(authorization)) {
          deny(
            request,
            options,
            "policy",
            typeof authorization === "object"
              ? authorization.reason
              : undefined
          );
        }
      }
      return binding.handler(...args);
    };
  }

  return serveWorkerRpc(handlers, target);
}

function deny(
  request: WorkerCapabilityRequest,
  options: WorkerCapabilityProxyOptions,
  reason: WorkerCapabilityDeniedReason,
  detail?: string
): never {
  options.onDenied?.({
    ...request,
    reason,
    ...(detail ? { detail } : {}),
  });
  safeRecordAudit(options.audit, {
    type: "capability.denied",
    pluginId: request.pluginId,
    method: request.method,
    capability: request.capability,
    reason,
    ...(detail ? { detail } : {}),
  });
  throw new Error(
    `[butui] worker capability denied: ${request.pluginId}/${request.method} (${request.capability})` +
      (detail ? `: ${detail}` : "")
  );
}

function isAuthorized(value: WorkerCapabilityAuthorization): boolean {
  return (
    value === true ||
    (typeof value === "object" &&
      value !== null &&
      value.allowed === true)
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
