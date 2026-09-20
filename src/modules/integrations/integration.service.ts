import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { InProcessEventBus } from '../events/event-bus';
import { IntegrationSupport, IntegrationWorkItemRef } from './integration-support';
import {
  ExternalArtifact,
  GitDeploymentPayload,
  GitPullRequestPayload,
  GitWebhookDto,
  IntegrationDeliveryResult,
  IntegrationTransitionResult,
} from './integration.types';

export class InvalidIntegrationPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIntegrationPayloadError';
  }
}

@Injectable()
export class IntegrationService {
  private dbService = DatabaseService.getInstance();
  private support = new IntegrationSupport();
  private eventBus = InProcessEventBus.getInstance();

  public async processGitWebhook(
    orgId: string,
    dto: GitWebhookDto,
    deliveryId: string,
  ): Promise<IntegrationDeliveryResult> {
    await this.dbService.initialize();
    this.validateWebhook(dto, deliveryId);

    const provider = (dto.provider || 'github').toLowerCase();
    const existing = await this.support.findDelivery<IntegrationDeliveryResult>(orgId, provider, deliveryId);
    if (existing) {
      if (existing.result) return { ...existing.result, duplicate: true };
      throw new InvalidIntegrationPayloadError(
        `Delivery '${deliveryId}' is already ${existing.status}`,
      );
    }

    const deliveryRecordId = await this.support.beginDelivery(
      orgId, provider, deliveryId, dto.event_type, dto,
    );

    try {
      const result = await this.processEvent(orgId, provider, deliveryId, dto);
      await this.support.completeDelivery(deliveryRecordId, result);
      await this.eventBus.publish(
        'IntegrationDeliveryProcessed',
        result.artifacts[0]?.id || deliveryRecordId,
        { type: 'integration', id: provider },
        { org_id: orgId, delivery_id: deliveryId, event_type: dto.event_type, result },
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown integration error';
      await this.support.failDelivery(deliveryRecordId, message);
      throw error;
    }
  }

  public async listExternalLinks(workItemId: string, orgId: string): Promise<Array<ExternalArtifact & {
    link_type: string;
    linked_at: string;
  }>> {
    await this.dbService.initialize();
    const item = await this.dbService.db.query(
      `SELECT id FROM work_items WHERE id = $1 AND org_id = $2`,
      [workItemId, orgId],
    );
    if (item.rows.length === 0) {
      throw new InvalidIntegrationPayloadError(`Work item '${workItemId}' not found`);
    }

    const result = await this.dbService.db.query<any>(
      `SELECT artifact.*, link.link_type, link.created_at AS linked_at
       FROM external_artifact_links link
       JOIN external_artifacts artifact ON artifact.id = link.artifact_id
       WHERE link.work_item_id = $1 AND artifact.org_id = $2
       ORDER BY link.created_at DESC`,
      [workItemId, orgId],
    );
    return result.rows.map((row) => ({
      ...this.support.mapArtifact(row),
      link_type: row.link_type,
      linked_at: this.support.toIso(row.linked_at),
    }));
  }

  public async getDelivery(orgId: string, provider: string, deliveryId: string): Promise<any | null> {
    await this.dbService.initialize();
    return this.support.getDeliveryRecord(orgId, provider, deliveryId);
  }

  private async processEvent(
    orgId: string,
    provider: string,
    deliveryId: string,
    dto: GitWebhookDto,
  ): Promise<IntegrationDeliveryResult> {
    const artifacts: ExternalArtifact[] = [];
    const linkedKeys = new Set<string>();
    const unresolvedKeys = new Set<string>();
    const transitions: IntegrationTransitionResult[] = [];

    if (dto.event_type === 'push') {
      const commits = dto.commits || (dto.commit ? [dto.commit] : []);
      if (commits.length === 0) {
        throw new InvalidIntegrationPayloadError('Push event must include at least one commit');
      }
      for (const commit of commits) {
        const artifact = await this.support.upsertArtifact(orgId, provider, 'commit', commit.sha, {
          title: commit.message.split('\n')[0] || commit.sha,
          url: commit.url,
          status: 'recorded',
          payload: { repository: dto.repository, delivery_id: deliveryId, ...commit },
        });
        artifacts.push(artifact);
        const references = await this.support.resolveReferences(orgId, this.extractWorkItemKeys(commit.message));
        references.unresolved.forEach((key) => unresolvedKeys.add(key));
        for (const item of references.items) {
          await this.support.linkArtifact(artifact.id, item.id, 'fixed_by');
          linkedKeys.add(item.key);
        }
      }
    }

    if (dto.event_type === 'pull_request') {
      const pullRequest = dto.pull_request;
      if (!pullRequest) {
        throw new InvalidIntegrationPayloadError('Pull request event must include pull_request');
      }
      const artifact = await this.createPullRequestArtifact(orgId, provider, deliveryId, dto.repository, pullRequest);
      artifacts.push(artifact);
      const keys = this.extractWorkItemKeys(
        pullRequest.title,
        pullRequest.body,
        pullRequest.head_ref,
      );
      const references = await this.support.resolveReferences(orgId, keys);
      references.unresolved.forEach((key) => unresolvedKeys.add(key));
      for (const item of references.items) {
        await this.support.linkArtifact(artifact.id, item.id, 'fixed_by');
        linkedKeys.add(item.key);
      }

      if (dto.action === 'merged' || pullRequest.merged === true) {
        for (const item of references.items.filter((candidate) => candidate.type === 'story')) {
          transitions.push(await this.support.attemptTransition(
            item,
            orgId,
            'In Review',
            `integration:${provider}:pull_request`,
          ));
        }
      }
    }

    if (dto.event_type === 'deployment') {
      const deployment = dto.deployment;
      if (!deployment) {
        throw new InvalidIntegrationPayloadError('Deployment event must include deployment');
      }
      const artifact = await this.createDeploymentArtifact(orgId, provider, deliveryId, dto.repository, deployment);
      artifacts.push(artifact);
      const keys = this.extractWorkItemKeys(
        deployment.release_key,
        deployment.description,
        ...(deployment.work_item_keys || []),
      );
      const references = await this.support.resolveReferences(orgId, keys);
      references.unresolved.forEach((key) => unresolvedKeys.add(key));
      for (const item of references.items) {
        await this.support.linkArtifact(artifact.id, item.id, 'deployed_in');
        linkedKeys.add(item.key);
      }

      if (['success', 'succeeded'].includes(deployment.status.toLowerCase())) {
        for (const release of references.items.filter((candidate) => candidate.type === 'release')) {
          transitions.push(await this.support.attemptTransition(
            release,
            orgId,
            'Deployed',
            `integration:${provider}:deployment`,
          ));
        }
      }
    }

    return {
      delivery_id: deliveryId,
      provider,
      event_type: dto.event_type,
      duplicate: false,
      artifacts,
      linked_work_item_keys: Array.from(linkedKeys),
      unresolved_keys: Array.from(unresolvedKeys),
      transitions,
    };
  }

  private validateWebhook(dto: GitWebhookDto, deliveryId: string): void {
    if (!deliveryId?.trim()) throw new InvalidIntegrationPayloadError('delivery_id is required');
    if (!dto.repository?.trim()) throw new InvalidIntegrationPayloadError('repository is required');
    if (!['push', 'pull_request', 'deployment'].includes(dto.event_type)) {
      throw new InvalidIntegrationPayloadError(
        "event_type must be 'push', 'pull_request', or 'deployment'",
      );
    }
  }

  private async createPullRequestArtifact(
    orgId: string,
    provider: string,
    deliveryId: string,
    repository: string,
    pullRequest: GitPullRequestPayload,
  ): Promise<ExternalArtifact> {
    const status = pullRequest.merged ? 'merged' : (pullRequest.state || 'open');
    return this.support.upsertArtifact(orgId, provider, 'pull_request', String(pullRequest.id), {
      title: pullRequest.title,
      url: pullRequest.url,
      status,
      payload: { repository, delivery_id: deliveryId, ...pullRequest },
    });
  }

  private async createDeploymentArtifact(
    orgId: string,
    provider: string,
    deliveryId: string,
    repository: string,
    deployment: GitDeploymentPayload,
  ): Promise<ExternalArtifact> {
    return this.support.upsertArtifact(orgId, provider, 'deployment', String(deployment.id), {
      title: `${repository} deployment to ${deployment.environment}`,
      url: deployment.url,
      status: deployment.status,
      payload: { repository, delivery_id: deliveryId, ...deployment },
    });
  }

  private extractWorkItemKeys(...values: Array<string | undefined>): string[] {
    const found = new Set<string>();
    const pattern = /\b(?:EPIC|STORY|INCIDENT|INC|RELEASE|REL)-[A-Z0-9]+\b/gi;
    for (const value of values) {
      if (!value) continue;
      for (const match of value.matchAll(pattern)) {
        found.add(match[0]
          .toUpperCase()
          .replace(/^INCIDENT-/, 'INC-')
          .replace(/^RELEASE-/, 'REL-'));
      }
    }
    return Array.from(found);
  }
}

export type { IntegrationWorkItemRef };
