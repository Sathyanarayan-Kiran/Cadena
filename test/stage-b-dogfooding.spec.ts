import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { importBacklogDogfooding } from '../src/scripts/import-backlog';
import backlog from '../backlog.json';

// Derived from backlog.json rather than hard-coded: the platform dogfoods its own backlog,
// so adding requirements must grow the import rather than break this test.
const EXPECTED_EPICS = backlog.epics.length;
const EXPECTED_STORIES = backlog.epics.reduce((total, epic) => total + epic.stories.length, 0);

describe('Stage B Dogfooding — Self-Host Backlog Ingestion', () => {
  let app: INestApplication;

  const dogfoodOrgId = '99999999-9999-9999-9999-999999999999';
  const dogfoodTeamId = '88888888-8888-8888-8888-888888888888';

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('Stage B: ingests the whole backlog and preserves parent-child hierarchy', async () => {
    // 1. Run Stage B Dogfooding import script
    const result = await importBacklogDogfooding(dogfoodOrgId, dogfoodTeamId);

    expect(result.epicCount).toBe(EXPECTED_EPICS);
    expect(result.storyCount).toBe(EXPECTED_STORIES);
    expect(result.totalImported).toBe(EXPECTED_EPICS + EXPECTED_STORIES);
    // Every story is linked to its parent epic, so links track stories exactly.
    expect(result.linkCount).toBe(EXPECTED_STORIES);

    // 2. Fetch all work items for dogfoodOrgId via GET /workitems
    const res = await request(app.getHttpServer())
      .get('/workitems')
      .set('x-org-id', dogfoodOrgId)
      .expect(200);

    expect(res.body.length).toBe(EXPECTED_EPICS + EXPECTED_STORIES);

    // 3. Verify Epic 1 and US1.1 exist and are linked
    const epic1 = res.body.find((item: any) => item.title.includes('[E1]'));
    expect(epic1).toBeDefined();
    expect(epic1.type).toBe('epic');

    const us11 = res.body.find((item: any) => item.title.includes('[US1.1]'));
    expect(us11).toBeDefined();

    // 4. Query upstream lineage for US1.1
    const lineageRes = await request(app.getHttpServer())
      .get(`/workitems/${us11.id}/lineage?direction=up`)
      .set('x-org-id', dogfoodOrgId)
      .expect(200);

    expect(lineageRes.body.chain.length).toBeGreaterThanOrEqual(2);
    expect(lineageRes.body.chain[0].title).toContain('[US1.1]');
    expect(lineageRes.body.chain.some((n: any) => n.title.includes('[E1]'))).toBe(true);
  });
});
