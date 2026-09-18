import { readFileSync } from 'fs';
import { join } from 'path';
import { DatabaseService } from '../database/database.service';
import { WorkItemService } from '../modules/work-items/work-item.service';
import { LineageService } from '../modules/lineage/lineage.service';

export interface BacklogStory {
  id: string;
  statement: string;
  acceptance_criteria: string[];
}

export interface BacklogEpic {
  epic_id: string;
  title: string;
  type: string;
  stories: BacklogStory[];
}

export interface BacklogJson {
  epics: BacklogEpic[];
}

export async function importBacklogDogfooding(
  orgId: string = '00000000-0000-0000-0000-000000000099',
  teamId: string = '00000000-0000-0000-0000-000000000001',
): Promise<{ epicCount: number; storyCount: number; totalImported: number; linkCount: number }> {
  await DatabaseService.getInstance().initialize();

  const itemService = new WorkItemService();
  const lineageService = new LineageService();

  const backlogPath = join(process.cwd(), 'backlog.json');
  const fileData = readFileSync(backlogPath, 'utf-8');
  const backlog: BacklogJson = JSON.parse(fileData);

  let epicCount = 0;
  let storyCount = 0;
  let linkCount = 0;

  for (const epicData of backlog.epics) {
    // 1. Create Epic WorkItem
    const epicItem = await itemService.createWorkItem({
      type: 'story',
      title: `[${epicData.epic_id}] ${epicData.title}`,
      description: `Epic specification: ${epicData.title}`,
      priority: 'P1',
      team_id: teamId,
      org_id: orgId,
      custom_fields: {
        is_epic: true,
        epic_code: epicData.epic_id,
        story_count: epicData.stories.length,
      },
    });
    epicCount++;

    // 2. Create Story WorkItems & Link child_of Parent Epic
    for (const storyData of epicData.stories) {
      const storyItem = await itemService.createWorkItem({
        type: 'story',
        title: `[${storyData.id}] ${storyData.statement}`,
        description: storyData.statement,
        priority: 'P2',
        team_id: teamId,
        org_id: orgId,
        custom_fields: {
          user_story_id: storyData.id,
          acceptance_criteria: storyData.acceptance_criteria,
          parent_epic_id: epicData.epic_id,
        },
      });
      storyCount++;

      // Create typed relationship edge child_of
      await lineageService.createLink(storyItem.id, epicItem.id, 'child_of');
      linkCount++;
    }
  }

  return {
    epicCount,
    storyCount,
    totalImported: epicCount + storyCount,
    linkCount,
  };
}

if (require.main === module) {
  importBacklogDogfooding()
    .then((res) => {
      console.log(`🎉 Stage B Dogfooding Backlog Import Successful!`);
      console.log(`   - Epics Imported: ${res.epicCount}`);
      console.log(`   - User Stories Imported: ${res.storyCount}`);
      console.log(`   - Total WorkItems: ${res.totalImported}`);
      console.log(`   - Relationships Created: ${res.linkCount}`);
    })
    .catch((err) => {
      console.error('❌ Stage B Dogfooding Import Failed:', err);
      process.exit(1);
    });
}
