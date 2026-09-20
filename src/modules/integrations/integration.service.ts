import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { InProcessEventBus } from '../events/event-bus';
import { WorkflowService } from '../workflow/workflow.service';
import {
  ExternalArtifact,
  GitCommitPayload,
  GitDeploymentPayload,
  GitPullRequestPayload,
  GitWebhookDto,
  IntegrationDeliveryResult,
  IntegrationTransitionResult,
} from './integration.types';

interface WorkItemReference {
  id: string;
  key: string;
  type: string;
  status: string;
}

export class InvalidIntegrationPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIntegrationPayloadError';
  }
}

@Injectable()
export class IntegrationService {
  private dbService = DatabaseService.getInstance();
  private workflowService = new WorkflowService();
  private eventBus = InProcessEventBus.getInstance();

  public async processGitWebhook(
    orgId: string,
    dto: GitWebhookDto,
    deliveryId: string,
  ): Promise<IntegrationDeliveryResult> {
    await this.dbService.initialize();
    this.validateWebhook(dto, deliveryId);

    const provider = (dto.provider || 'github').toLowerCase();
    const existing = await this.dbService.db.query<any>(
      `SELECT result, status FROM integration_deliveries
       WHERE org_id = $1 AND provider = $2 AND delivery_id = $3`,
      [orgId, provider, deliveryId],
    );
    if (existing.rows.length > 0) {
      const priorResult = this.parseJson<IntegrationDeliveryResult>(existing.rows[0].result);
      if (priorResult) return { ...priorResult, duplicate: true };
      throw new InvalidIntegrationPayloadError(
        `Delivery '${deliveryId}' is already ${existing.rows[0].status}`,
      );
    }

    const deliveryRecordId = randomUUID();
    await this.dbService.db.query(
      `INSERT INTO integration_deliveries
       (id, org_id, provider, delivery_id, event_type, status, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, 'processing', $6, CURRENT_TIMESTAMP)`,
      [deliveryRecordId, orgId, provider, deliveryId, dto.event_type, JSON.stringify(dto)],
    );

    try {
      const result = await this.processEvent(orgId, provider, deliveryId, dto);
      await this.dbService.db.query(
        `UPDATE integration_deliveries
         SET status = 'completed', result = $1, processed_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [JSON.stringify(result), deliveryRecordId],
      );
      await this.eventBus.publish(
        'IntegrationDeliveryProcessed',
        result.artifacts[0]?.id || deliveryRecordId,
        { type: 'integration', id: provider },
        { org_id: orgId, delivery_id: deliveryId, event_type: dto.event_type, result },
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown integration error';
      await this.dbService.db.query(
        `UPDATE integration_deliveries
         SET status = 'failed', error = $1, processed_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [message, deliveryRecordId],
      );
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
      ...this.mapArtifact(row),
      link_type: row.link_type,
      linked_at: this.toIso(row.linked_at),
    }));
  }

  public async getDelivery(orgId: string, provider: string, deliveryId: string): Promise<any | null> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT provider, delivery_id, event_type, status, result, error, created_at, processed_at
       FROM integration_deliveries
       WHERE org_id = $1 AND provider = $2 AND delivery_id = $3`,
      [orgId, provider.toLowerCase(), deliveryId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      ...row,
      result: this.parseJson(row.result),
      created_at: this.toIso(row.created_at),
      processed_at: row.processed_at ? this.toIso(row.processed_at) : null,
    };
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
        const artifact = await this.upsertArtifact(orgId, provider, 'commit', commit.sha, {
          title: commit.message.split('\n')[0] || commit.sha,
          url: commit.url,
          status: 'recorded',
          payload: { repository: dto.repository, delivery_id: deliveryId, ...commit },
        });
        artifacts.push(artifact);
        const references = await this.resolveReferences(orgId, this.extractWorkItemKeys(commit.message));
        references.unresolved.forEach((key) => unresolvedKeys.add(key));
        for (const item of references.items) {
          await this.linkArtifact(artifact.id, item.id, 'fixed_by');
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
      const references = await this.resolveReferences(orgId, keys);
      references.unresolved.forEach((key) => unresolvedKeys.add(key));
      for (const item of references.items) {
        await this.linkArtifact(artifact.id, item.id, 'fixed_by');
        linkedKeys.add(item.key);
      }

      if (dto.action === 'merged' || pullRequest.merged === true) {
        for (const item of references.items.filter((candidate) => candidate.type === 'story')) {
          transitions.push(await this.attemptTransition(
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
      const references = await this.resolveReferences(orgId, keys);
      references.unresolved.forEach((key) => unresolvedKeys.add(key));
      for (const item of references.items) {
        await this.linkArtifact(artifact.id, item.id, 'deployed_in');
        linkedKeys.add(item.key);
      }

      if (['success', 'succeeded'].includes(deployment.status.toLowerCase())) {
        for (const release of references.items.filter((candidate) => candidate.type === 'release')) {
          transitions.push(await this.attemptTransition(
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
    return this.upsertArtifact(orgId, provider, 'pull_request', String(pullRequest.id), {
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
    return this.upsertArtifact(orgId, provider, 'deployment', String(deployment.id), {
      title: `${repository} deployment to ${deployment.environment}`,
      url: deployment.url,
      status: deployment.status,
      payload: { repository, delivery_id: deliveryId, ...deployment },
    });
  }

  private async upsertArtifact(
    orgId: string,
    provider: string,
    artifactType: ExternalArtifact['artifact_type'],
    externalId: string,
    input: { title: string; url?: string; status?: string; payload: Record<string, unknown> },
  ): Promise<ExternalArtifact> {
    const result = await this.dbService.db.query<any>(
      `INSERT INTO external_artifacts
       (id, org_id, provider, artifact_type, external_id, title, url, status, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (org_id, provider, artifact_type, external_id)
       DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url, status = EXCLUDED.status,
                     payload = EXCLUDED.payload, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        randomUUID(), orgId, provider, artifactType, externalId, input.title,
        input.url || null, input.status || null, JSON.stringify(input.payload),
      ],
    );
    return this.mapArtifact(result.rows[0]);
  }

  private async linkArtifact(artifactId: string, workItemId: string, linkType: string): Promise<void> {
    await this.dbService.db.query(
      `INSERT INTO external_artifact_links
       (id, artifact_id, work_item_id, link_type, created_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (artifact_id, work_item_id, link_type) DO NOTHING`,
      [randomUUID(), artifactId, workItemId, linkType],
    );
  }

  private async resolveReferences(
    orgId: string,
    keys: string[],
  ): Promise<{ items: WorkItemReference[]; unresolved: string[] }> {
    const items: WorkItemReference[] = [];
    const unresolved: string[] = [];
    for (const key of keys) {
      const result = await this.dbService.db.query<any>(
        `SELECT id, item_key, type, status FROM work_items
         WHERE org_id = $1 AND UPPER(item_key) = $2`,
        [orgId, key.toUpperCase()],
      );
      if (result.rows.length === 0) {
        unresolved.push(key);
      } else {
        items.push({
          id: result.rows[0].id,
          key: result.rows[0].item_key,
          type: result.rows[0].type,
          status: result.rows[0].status,
        });
      }
    }
    return { items, unresolved };
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

  private async attemptTransition(
    item: WorkItemReference,
    orgId: string,
    targetState: string,
    actorId: string,
  ): Promise<IntegrationTransitionResult> {
    try {
      const transition = await this.workflowService.transitionWorkItem({
        workItemId: item.id,
        orgId,
        toState: targetState,
        actorId,
        actorRole: 'integration',
        actorType: 'integration',
      });
      return {
        work_item_id: item.id,
        work_item_key: item.key,
        from_state: transition.from_state,
        to_state: transition.to_state,
        outcome: 'applied',
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Transition was rejected';
      await this.eventBus.publish(
        'IntegrationAutoTransitionSkipped',
        item.id,
        { type: 'integration', id: actorId },
        {
          org_id: orgId,
          work_item_key: item.key,
          from_state: item.status,
          to_state: targetState,
          reason,
        },
      );
      return {
        work_item_id: item.id,
        work_item_key: item.key,
        from_state: item.status,
        to_state: targetState,
        outcome: 'skipped',
        reason,
      };
    }
  }

  private mapArtifact(row: any): ExternalArtifact {
    return {
      id: row.id,
      org_id: row.org_id,
      provider: row.provider,
      artifact_type: row.artifact_type,
      external_id: row.external_id,
      title: row.title,
      url: row.url,
      status: row.status,
      payload: this.parseJson<Record<string, unknown>>(row.payload) || {},
      created_at: this.toIso(row.created_at),
      updated_at: this.toIso(row.updated_at),
    };
  }

  private parseJson<T = any>(value: any): T | null {
    if (value === null || value === undefined) return null;
    return typeof value === 'string' ? JSON.parse(value) as T : value as T;
  }

  private toIso(value: any): string {
    return typeof value === 'string' ? value : new Date(value).toISOString();
  }
}
