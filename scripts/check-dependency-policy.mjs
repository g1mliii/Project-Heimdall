import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const minAgeDays = Number.parseInt(process.env.DEPENDENCY_MIN_AGE_DAYS ?? "30", 10);
const now = new Date();
const failures = [];
const warnings = [];

async function fetchPackageMetadata(name) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`registry returned ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function parsePackageManager(value) {
  const match = /^([^@]+)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(value ?? "");
  if (!match) {
    failures.push(`packageManager must be an exact package@version pin, got ${JSON.stringify(value)}.`);
    return null;
  }

  return { name: match[1], version: match[2], source: "packageManager" };
}

function parseExactDependency(name, versionRange, source) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(versionRange)) {
    failures.push(`${source}.${name} must be an exact version pin, got ${JSON.stringify(versionRange)}.`);
    return null;
  }

  return { name, version: versionRange, source };
}

function collectDependencies() {
  const dependencies = [];
  const packageManager = parsePackageManager(packageJson.packageManager);
  if (packageManager) {
    dependencies.push(packageManager);
  }

  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, versionRange] of Object.entries(packageJson[section] ?? {})) {
      const dependency = parseExactDependency(name, versionRange, section);
      if (dependency) {
        dependencies.push(dependency);
      }
    }
  }

  return dependencies;
}

function major(version) {
  return Number.parseInt(version.split(".")[0], 10);
}

function ageInDays(date) {
  return Math.floor((now.getTime() - date.getTime()) / 86_400_000);
}

async function validateDependency(dependency) {
  let metadata;

  try {
    metadata = await fetchPackageMetadata(dependency.name);
  } catch (error) {
    failures.push(`${dependency.source}.${dependency.name}@${dependency.version}: npm registry lookup failed (${error.message}).`);
    return;
  }

  const releaseTime = metadata.time?.[dependency.version];
  if (!releaseTime) {
    failures.push(`${dependency.source}.${dependency.name}@${dependency.version}: release timestamp not found in npm registry.`);
    return;
  }

  const releaseDate = new Date(releaseTime);
  const releaseAgeDays = ageInDays(releaseDate);
  if (releaseAgeDays < minAgeDays) {
    failures.push(
      `${dependency.source}.${dependency.name}@${dependency.version}: released ${releaseAgeDays} days ago; minimum soak is ${minAgeDays} days unless a security exception is documented.`,
    );
  }

  const versionMetadata = metadata.versions?.[dependency.version];
  if (versionMetadata?.deprecated) {
    failures.push(`${dependency.source}.${dependency.name}@${dependency.version}: deprecated by npm registry: ${versionMetadata.deprecated}`);
  }

  const latest = metadata["dist-tags"]?.latest;
  if (latest && major(latest) > major(dependency.version)) {
    const latestTime = metadata.time?.[latest];
    if (latestTime && ageInDays(new Date(latestTime)) >= minAgeDays) {
      warnings.push(
        `${dependency.source}.${dependency.name}@${dependency.version}: latest stable major is ${latest}; confirm this older major is intentional.`,
      );
    }
  }
}

for (const dependency of collectDependencies()) {
  await validateDependency(dependency);
}

if (warnings.length > 0) {
  console.warn(warnings.map((warning) => `warning: ${warning}`).join("\n"));
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `error: ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Dependency policy check passed (${minAgeDays}-day minimum release age).`);
