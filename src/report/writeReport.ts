import { open, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';

import type { SixServiceJourneyResult } from '../demo/sixServiceJourney.js';
import { withOwnedLifecycle } from '../demo/ownedLifecycle.js';
import { renderStaticReport, renderReceiptsOnlyReport } from './renderHtml.js';
import { buildReportViewModel, buildReceiptsOnlyViewModel } from './viewModel.js';
import type { LicensedExternalClientResult } from '../client/externalClient.js';

export type StaticReportPaths = { htmlPath: string; evidencePath: string };

/** Reserves both explicit sibling paths before any fixture work; neither existing file is overwritten. */
export async function writeStaticReport(produce: () => Promise<SixServiceJourneyResult>,
  paths: StaticReportPaths): Promise<void> {
  return writeReportFiles(async () => {
    const result = await produce();
    return { htmlText: renderStaticReport(buildReportViewModel(result), basename(paths.evidencePath)),
      originalJson: `${JSON.stringify(result, null, 2)}\n` };
  }, paths);
}

/** Only an allowlisted public summary is serialized, never the caller's private input. */
export async function writeReceiptsOnlyReport(result: LicensedExternalClientResult,
  paths: StaticReportPaths, now?: () => string): Promise<void> {
  return writeReportFiles(async () => {
    const model = buildReceiptsOnlyViewModel(result, now);
    return { htmlText: renderReceiptsOnlyReport(model, basename(paths.evidencePath)),
      originalJson: `${JSON.stringify(model, null, 2)}\n` };
  }, paths);
}

async function writeReportFiles(produce: () => Promise<{ htmlText: string; originalJson: string }>, paths: StaticReportPaths): Promise<void> {
  const { htmlPath, evidencePath } = paths;
  if (!isAbsolute(htmlPath) || !isAbsolute(evidencePath) ||
      resolve(htmlPath) === resolve(evidencePath) ||
      dirname(resolve(htmlPath)) !== dirname(resolve(evidencePath)) ||
      extname(htmlPath).toLowerCase() !== '.html' ||
      extname(evidencePath).toLowerCase() !== '.json') {
    throw new Error('report requires distinct absolute sibling .html and .json output paths');
  }
  await withOwnedLifecycle(async (lifecycle) => {
    let html: FileHandle | undefined;
    let evidence: FileHandle | undefined;
    let completed = false;
    try {
      lifecycle.check();
      html = await open(htmlPath, 'wx', 0o600);
      lifecycle.check();
      evidence = await open(evidencePath, 'wx', 0o600);
      lifecycle.check();
      const { htmlText, originalJson } = await produce();
      lifecycle.check();
      await evidence.writeFile(originalJson, 'utf8');
      await evidence.sync();
      lifecycle.check();
      await html.writeFile(htmlText, 'utf8');
      await html.sync();
      lifecycle.check();
      completed = true;
    } finally {
      await Promise.allSettled([html?.close(), evidence?.close()]);
      if (!completed) {
        if (html) await unlink(htmlPath);
        if (evidence) await unlink(evidencePath);
      }
    }
  });
}
