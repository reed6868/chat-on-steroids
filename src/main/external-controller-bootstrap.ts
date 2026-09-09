import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
  onExternalControllerPersist,
  onExternalControllerPersistNow,
  restoreExternalController,
  snapshotExternalController,
  type ExternalControllerSnapshot
} from './external-controller.js';
import { startExternalControllerServer, type ExternalControllerServer } from './external-controller-server.js';
import { logError, logInfo, logWarn } from './logger.js';

const STATE_FILE = 'external-controller-state.json';
let server: ExternalControllerServer | null = null;
let writeTimer: NodeJS.Timeout | null = null;
let writeFlight: Promise<void> = Promise.resolve();

async function writeState(userDataDir: string, snapshot: ExternalControllerSnapshot): Promise<void> {
  const target = path.join(userDataDir, STATE_FILE);
  const temp = `${target}.tmp`;
  const payload = JSON.stringify(snapshot) + '\n';
  writeFlight = writeFlight.then(async () => {
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.writeFile(temp, payload, { mode: 0o600 });
    await fs.rename(temp, target);
    if (process.platform !== 'win32') await fs.chmod(target, 0o600);
  });
  return writeFlight;
}

async function restoreState(userDataDir: string): Promise<void> {
  const target = path.join(userDataDir, STATE_FILE);
  try {
    const saved = JSON.parse(await fs.readFile(target, 'utf8')) as ExternalControllerSnapshot;
    restoreExternalController(saved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      restoreExternalController(null);
      return;
    }
    // A corrupt controller state must never be guessed back into authority. Start empty and
    // leave the bad file untouched until the next real mutation replaces it atomically.
    restoreExternalController(null);
    logWarn(`external controller state was not restored: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scheduleStateWrite(userDataDir: string): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void writeState(userDataDir, snapshotExternalController()).catch((error) => {
      logError(`external controller state write failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 50);
  writeTimer.unref?.();
}

async function start(): Promise<void> {
  const userDataDir = app.getPath('userData');
  await restoreState(userDataDir);
  onExternalControllerPersist(() => scheduleStateWrite(userDataDir));
  onExternalControllerPersistNow((snapshot) => writeState(userDataDir, snapshot));
  server = await startExternalControllerServer(userDataDir);
  logInfo('external controller ready');
}

void app.whenReady().then(start).catch((error) => {
  logError(`external controller failed to start: ${error instanceof Error ? error.message : String(error)}`);
});

app.on('before-quit', () => {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const userDataDir = app.getPath('userData');
  void writeState(userDataDir, snapshotExternalController()).catch(() => undefined);
  const active = server;
  server = null;
  void active?.close().catch(() => undefined);
});
