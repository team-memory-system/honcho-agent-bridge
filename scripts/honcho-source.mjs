import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function isWrappedHoncho(directory) {
  try { await fs.access(path.join(directory, "selfhost-source.json")); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

/** Export a wrapper's pinned upstream plus patches into the flat runtime layout. */
export async function prepareHonchoTree(source, output, { runner = execFileAsync } = {}) {
  await runner(process.execPath, [path.join(source, "scripts", "prepare-source.mjs"), "--output", output], {
    cwd: source, timeout: 900_000, maxBuffer: 10 * 1024 * 1024,
  });
  for (const file of ["Dockerfile", "LICENSE", "database/init.sql", "local-dashboard/Dockerfile"]) {
    await fs.access(path.join(output, file));
  }
  const provenance = JSON.parse(await fs.readFile(path.join(output, ".honcho-source.json"), "utf8"));
  if (provenance.kind !== "honcho-selfhost-source") throw new Error("Honcho preparer returned an unrecognized source tree");
  return provenance;
}
