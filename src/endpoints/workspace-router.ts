import { AppError } from "../core/errors.ts";
import type { PreparedProjectWorkspace, ProjectWorkspacePolicy } from "../sessions/project-workspace.ts";
import type { EndpointWorkLease } from "./types.ts";

export class WorkspaceRouter {
  constructor(
    private readonly policyFor: (endpointId: string) => ProjectWorkspacePolicy | Promise<ProjectWorkspacePolicy>,
    private readonly validateLease?: (endpointId: string, lease: EndpointWorkLease) => boolean,
  ) {}

  async prepareCreate(endpointId: string, nickname: string, requested?: string, _lease?: EndpointWorkLease): Promise<PreparedProjectWorkspace> {
    this.requireLease(endpointId, _lease);
    const result = await (await this.policy(endpointId)).prepareCreate(nickname, requested);
    this.requireLease(endpointId, _lease);
    return result;
  }
  async prepareExisting(endpointId: string, path: string, _lease?: EndpointWorkLease): Promise<PreparedProjectWorkspace> {
    this.requireLease(endpointId, _lease);
    const result = await (await this.policy(endpointId)).prepareExisting(path);
    this.requireLease(endpointId, _lease);
    return result;
  }
  async assertDispatchable(endpointId: string, prepared: PreparedProjectWorkspace, _lease?: EndpointWorkLease): Promise<void> {
    this.requireLease(endpointId, _lease);
    await (await this.policy(endpointId)).assertDispatchable(prepared);
    this.requireLease(endpointId, _lease);
  }

  private async policy(endpointId: string): Promise<ProjectWorkspacePolicy> {
    const policy = await this.policyFor(endpointId);
    if (!policy) throw new AppError("ENDPOINT_UNAVAILABLE", `workspace host is unavailable: ${endpointId}`);
    return policy;
  }
  private requireLease(endpointId: string, lease?: EndpointWorkLease): void {
    if (lease && this.validateLease && !this.validateLease(endpointId, lease)) throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint work lease changed: ${endpointId}`);
  }
}
