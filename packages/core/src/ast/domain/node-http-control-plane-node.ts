import type { BaseControlPlaneASTNode } from '../base/base-control-plane-ast-node.js';

/**
 * Passive AST node exposing a local HTTP control-plane endpoint (`local.httpControlPlane`).
 *
 * Listens on `port` when mounted via `M.harness.exposeControlPlane(...)` to serve JSON-RPC/HTTP
 * control-plane commands and live run telemetry.
 */
export interface NodeHttpControlPlaneNode extends BaseControlPlaneASTNode<'node:http-control-plane'> {
  /** TCP port on which the HTTP control-plane server listens. */
  readonly port: number;
}
