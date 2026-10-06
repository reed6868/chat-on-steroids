import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('runtime renderer controls', () => {
  it('exposes ChatGPT Plan auth, Codex verification, and the default worker runtime in the settings UI', async () => {
    const [html, main, chat] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'main.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'chat.ts'), 'utf8')
    ]);

    expect(html).toContain('id="workerRuntime"');
    expect(html).toContain('value="codex-app-server"');
    expect(html).toContain('id="chatgptPlanSignIn"');
    expect(html).toContain('id="chatgptPlanSignOut"');
    expect(html).toContain('id="chatgptPlanVerifyCodex"');
    expect(html).toContain('id="chatgptPlanStatus"');

    expect(chat).toContain("defaultRuntime: $<HTMLSelectElement>('workerRuntime').value");
    expect(chat).toContain("$<HTMLSelectElement>('workerRuntime')");
    expect(main).toContain('api.signInChatgptPlan()');
    expect(main).toContain('api.signOutChatgptPlan()');
    expect(main).toContain('api.verifyChatgptPlanCodex()');
    expect(main).toContain("next.chatgptPlan.signedIn");
    expect(main).toContain("next.chatgptPlan ??");
    expect(main).toContain("next.secureStorage?.available !== true");

    for (const locale of ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW']) {
      const catalog = JSON.parse(await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'locales', `${locale}.json`), 'utf8'));
      for (const key of ['Default sub-agent runtime', 'Browser stays the default. Codex app-server uses your signed-in ChatGPT Plan and keeps its provider thread durable across app restarts.', 'ChatGPT Plan for Codex', 'Verify Codex']) {
        expect(catalog[key], `${locale}: ${key}`).toBeTruthy();
      }
    }
  });
});
