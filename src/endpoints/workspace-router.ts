import { AppError } from "../core/errors.ts";
import type { PreparedProjectWorkspace, ProjectWorkspacePolicy } from "../sessions/project-workspace.ts";
import type { EndpointWorkLease } from "./types.ts";

export class WorkspaceRouter {
  constructor(private readonly policyFor: (endpointId: string) => ProjectWorkspacePolicy | Promise<ProjectWorkspacePolicy>) {}

  async prepareCreate(endpointId: string, nickname: string, requested?: string, _lease?: EndpointWorkLease): Promise<PreparedProjectWorkspace> {
    return (await this.policy(endpointId)).prepareCreate(nickname, requested);
  }
  async prepareExisting(endpointId: string, path: string, _lease?: EndpointWorkLease): Promise<PreparedProjectWorkspace> {
    return (await this.policy(endpointId)).prepareExisting(path);
  }
  async assertDispatchable(endpointId: string, prepared: PreparedProjectWorkspace, _lease?: EndpointWorkLease): Promise<void> {
    await (await this.policy(endpointId)).assertDispatchable(prepared);
  }

  private async policy(endpointId: string): Promise<ProjectWorkspacePolicy> {
    const policy = await this.policyFor(endpointId);
    if (!policy) throw new AppError("ENDPOINT_UNAVAILABLE", `workspace host is unavailable: ${endpointId}`);
    return policy;
  }
}
